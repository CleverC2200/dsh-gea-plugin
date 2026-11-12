import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";
import semver from "semver";

const origin = "https://synear-gea.oss-cn-hangzhou.aliyuncs.com";
const digest = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const equal = (a, b) => (a === null ? b === null : b !== null && a.equals(b));

async function paths(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await paths(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

export async function prepareDesktopRelease(directory, sourceSha, receiptPath) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/, "DESKTOP_RELEASE_SOURCE_REQUIRED");
  const entries = await paths(resolve(directory));
  const receipts = [];
  for (const path of receiptPath
    ? [receiptPath]
    : entries.filter((path) => basename(path) === "result.json")) {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    if (receipt.status === "packaged-and-runtime-smoke-passed") receipts.push(receipt);
  }
  assert.equal(receipts.length, 1, "DESKTOP_RELEASE_BUILD_RECEIPT_REQUIRED");
  const receipt = receipts[0];
  assert.equal(receipt.geaSha, sourceSha, "DESKTOP_RELEASE_SOURCE_MISMATCH");
  const mac = receipt.platform === "darwin-arm64";
  assert.ok(mac || receipt.windowsHost === "win32-x64", "DESKTOP_RELEASE_PLATFORM_INVALID");
  assert.ok(
    mac
      ? typeof receipt.localCandidate === "boolean" &&
          receipt.signing?.includes("notarized and stapled")
      : receipt.unsigned === false && receipt.windowsSigning?.publisher,
    "DESKTOP_RELEASE_SIGNED_BUILD_REQUIRED",
  );
  const version = receipt.desktopVersion ?? receipt.packaged?.version;
  assert.ok(semver.valid(version), "DESKTOP_RELEASE_VERSION_INVALID");
  const platform = mac ? "mac-arm64" : "win-x64";
  const stem = `Synear-GEA-${version}-${platform}-signed`;
  const feed = mac ? "nightly-mac.yml" : "nightly.yml";
  const names = mac
    ? [stem + ".dmg", stem + ".zip", stem + ".zip.blockmap", feed]
    : [stem + ".exe", stem + ".exe.blockmap", feed];
  assert.ok(
    receipt.artifact === names[0] &&
      Number.isSafeInteger(receipt.size) &&
      receipt.size > 0 &&
      typeof receipt.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(receipt.sha256),
    "DESKTOP_RELEASE_INSTALLER_IDENTITY_REQUIRED",
  );
  const files = [];
  for (const name of names) {
    const candidates = entries.filter((path) => basename(path) === name);
    assert.equal(candidates.length, 1, "DESKTOP_RELEASE_FILE_REQUIRED: " + name);
    const bytes = await readFile(candidates[0]);
    assert.ok(bytes.length > 0, "DESKTOP_RELEASE_EMPTY_FILE");
    const file = {
      name,
      path: candidates[0],
      size: bytes.length,
      sha256: digest(bytes),
      sha512: digest(bytes, "sha512", "base64"),
    };
    const recorded = receipt.files?.find((row) => row.name === name);
    if (recorded)
      assert.ok(
        file.size === recorded.size && file.sha256 === recorded.sha256,
        "DESKTOP_RELEASE_BUILD_HASH_MISMATCH",
      );
    if (name === receipt.artifact)
      assert.ok(
        file.size === receipt.size && file.sha256 === receipt.sha256,
        "DESKTOP_RELEASE_INSTALLER_HASH_MISMATCH",
      );
    files.push(file);
  }
  const manifest = YAML.parse(await readFile(files.at(-1).path, "utf8"));
  const payloads = files.filter((file) => /\.(zip|dmg|exe)$/.test(file.name));
  const primary = files.find((file) => file.name.endsWith(mac ? ".zip" : ".exe"));
  assert.equal(manifest.version, version, "DESKTOP_RELEASE_FEED_VERSION_MISMATCH");
  assert.deepEqual(
    manifest.files?.map((file) => file.url).sort(),
    payloads.map((file) => file.name).sort(),
    "DESKTOP_RELEASE_FEED_FILES_MISMATCH",
  );
  for (const file of payloads) {
    const row = manifest.files.find((row) => row.url === file.name);
    assert.ok(
      row.size === file.size && row.sha512 === file.sha512,
      "DESKTOP_RELEASE_FEED_HASH_MISMATCH",
    );
  }
  assert.ok(
    manifest.path === primary.name && manifest.sha512 === primary.sha512,
    "DESKTOP_RELEASE_FEED_PRIMARY_MISMATCH",
  );
  return {
    version,
    sourceSha,
    platform,
    feed,
    localCandidate: receipt.localCandidate === true,
    prefix: `client-release/electron/${platform}/`,
    files,
  };
}

export async function publishDesktopRelease(plan, store) {
  assert.equal(plan.localCandidate, false, "DESKTOP_RELEASE_CANDIDATE_NOT_PUBLISHABLE");
  const feedKey = plan.prefix + plan.feed;
  const previous = await store.read(feedKey, true);
  const feedBytes = await readFile(plan.files.at(-1).path);
  assert.equal(digest(feedBytes), plan.files.at(-1).sha256, "DESKTOP_RELEASE_LOCAL_FILE_CHANGED");
  if (previous !== null) {
    const current = YAML.parse(previous.toString("utf8"));
    assert.ok(
      semver.valid(current.version) && semver.lte(current.version, plan.version),
      "DESKTOP_RELEASE_DOWNGRADE_REJECTED",
    );
    if (current.version === plan.version)
      assert.ok(previous.equals(feedBytes), "DESKTOP_RELEASE_SAME_VERSION_CHANGED");
  }
  const uploaded = [];
  for (const file of plan.files.slice(0, -1)) {
    const bytes = await readFile(file.path);
    assert.equal(digest(bytes), file.sha256, "DESKTOP_RELEASE_LOCAL_FILE_CHANGED");
    const keys = [plan.prefix + file.name];
    if (/\.(dmg|exe)$/.test(file.name))
      keys.unshift(`client-release/raw/${plan.sourceSha}/desktop/${file.name}`);
    for (const key of keys) {
      const existing = await store.read(key, true);
      assert.ok(
        existing === null || existing.equals(bytes),
        "DESKTOP_RELEASE_IMMUTABLE_CONFLICT: " + key,
      );
      if (existing === null) await store.put(key, bytes, true);
      const actual = await store.read(key, false);
      assert.ok(
        actual !== null && digest(actual) === file.sha256,
        "DESKTOP_RELEASE_PUBLIC_READBACK_FAILED: " + key,
      );
      uploaded.push({ url: origin + "/" + key, sha256: file.sha256, size: file.size });
    }
  }
  assert.ok(equal(previous, await store.read(feedKey, true)), "DESKTOP_RELEASE_FEED_CHANGED");
  if (!equal(previous, feedBytes)) await store.put(feedKey, feedBytes, previous === null);
  assert.ok(
    equal(feedBytes, await store.read(feedKey, false)),
    "DESKTOP_RELEASE_PUBLIC_FEED_FAILED",
  );
  return {
    status: "published-and-anonymously-verified",
    version: plan.version,
    platform: plan.platform,
    sourceSha: plan.sourceSha,
    updateAcceptance: "pending-full-ui-regression",
    feed: origin + "/" + feedKey,
    files: uploaded,
  };
}

export function verifyDesktopUpdateRegression(plans, receipt) {
  assert.deepEqual(
    plans.map((plan) => plan.platform).sort(),
    ["mac-arm64", "win-x64"],
    "DESKTOP_UPDATE_BOTH_PLATFORMS_REQUIRED",
  );
  assert.ok(
    receipt?.schema === 1 && receipt.status === "passed",
    "DESKTOP_UPDATE_RECEIPT_REQUIRED",
  );
  const platforms = {};
  for (const plan of plans) {
    assert.ok(
      plan.localCandidate === false &&
        receipt.sourceSha === plan.sourceSha &&
        receipt.version === plan.version,
      "DESKTOP_UPDATE_RELEASE_IDENTITY_MISMATCH",
    );
    const row = receipt.platforms?.[plan.platform];
    assert.ok(row, "DESKTOP_UPDATE_PLATFORM_RECEIPT_REQUIRED: " + plan.platform);
    const installer = plan.files.find((file) => /\.(dmg|exe)$/.test(file.name));
    assert.ok(
      row.installerSha256 === installer.sha256 && row.feedSha256 === plan.files.at(-1).sha256,
      "DESKTOP_UPDATE_QUALIFIED_ARTIFACT_MISMATCH",
    );
    assert.ok(
      semver.valid(row.fromVersion) &&
        semver.lt(row.fromVersion, plan.version) &&
        row.toVersion === plan.version &&
        row.signatureVerified === true,
      "DESKTOP_UPDATE_SIGNED_UPGRADE_REQUIRED",
    );
    assert.ok(
      ["check-download", "restart-ready"].includes(row.ui?.entry) &&
        [
          "downloadVerified",
          "installAndRestartInvoked",
          "normalSuccessorWindow",
          "accountResumed",
          "currentVersionAndLatest",
        ].every((key) => row.ui[key] === true),
      "DESKTOP_UPDATE_COMPLETE_UI_REQUIRED",
    );
    assert.ok(
      row.relaunch?.method === "native-updater" &&
        row.relaunch.manualSuccessorLaunch === false &&
        row.relaunch.flagsUnmodified === true &&
        row.relaunch.updaterOrCoordinatorIntercepted === false,
      "DESKTOP_UPDATE_NATIVE_AUTOMATIC_RELAUNCH_REQUIRED",
    );
    const data = row.data;
    assert.ok(
      data?.status === "passed" &&
        data.fromVersion === row.fromVersion &&
        data.toVersion === plan.version &&
        data.configuration?.status === "passed" &&
        [
          "allUserPatchValuesPreserved",
          "onlyExpectedCoreProofRefreshed",
          "coreProofMatchesVerifiedInstalledSeed",
        ].every((key) => data.configuration[key] === true) &&
        data.history?.status === "passed" &&
        Number.isSafeInteger(data.history.historicalSessions) &&
        data.history.historicalSessions > 0 &&
        Number.isSafeInteger(data.history.historicalEvents) &&
        data.history.historicalEvents > 0 &&
        data.history.allOriginalHeadersAndEventsPreserved === true &&
        data.history.readWithNewBundledCore === true,
      "DESKTOP_UPDATE_CONFIGURATION_AND_HISTORY_REQUIRED",
    );
    platforms[plan.platform] = {
      fromVersion: row.fromVersion,
      toVersion: plan.version,
      historicalSessions: data.history.historicalSessions,
      historicalEvents: data.history.historicalEvents,
    };
  }
  return {
    status: "full-ui-update-regression-passed",
    version: receipt.version,
    sourceSha: receipt.sourceSha,
    platforms,
  };
}

export function createDesktopOssStore(environment = process.env) {
  const id = environment.OSS_ACCESS_KEY_ID,
    secret = environment.OSS_ACCESS_KEY_SECRET;
  assert.ok(id && secret, "DESKTOP_RELEASE_OSS_CREDENTIALS_REQUIRED");
  async function request(method, key, bytes, immutable, authenticated) {
    assert.ok(
      /^client-release\/(electron\/(mac-arm64|win-x64)\/|raw\/[a-f0-9]{40}\/desktop\/)[A-Za-z0-9._-]+$/.test(
        key,
      ),
      "DESKTOP_RELEASE_KEY_INVALID",
    );
    const headers = {};
    const contentType = bytes ? "application/octet-stream" : "";
    if (bytes) {
      headers["Content-Type"] = contentType;
      headers["Cache-Control"] = key.endsWith(".yml")
        ? "no-cache"
        : "public, max-age=31536000, immutable";
      headers["x-oss-object-acl"] = "public-read";
      if (immutable) headers["x-oss-forbid-overwrite"] = "true";
    }
    if (authenticated) {
      headers.Date = new Date().toUTCString();
      const ossHeaders = bytes
        ? (immutable ? "x-oss-forbid-overwrite:true\n" : "") + "x-oss-object-acl:public-read\n"
        : "";
      const signature = createHmac("sha1", secret)
        .update(`${method}\n\n${contentType}\n${headers.Date}\n${ossHeaders}/synear-gea/${key}`)
        .digest("base64");
      headers.Authorization = `OSS ${id}:${signature}`;
    }
    const options = {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(180000),
    };
    if (bytes) options.body = bytes;
    const response = await fetch(origin + "/" + key, options);
    if (method === "GET" && response.status === 404) return null;
    assert.equal(response.status, 200, `DESKTOP_RELEASE_OSS_HTTP_${response.status}: ${key}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return {
    read: (key, authenticated) => request("GET", key, undefined, false, authenticated),
    put: (key, bytes, immutable) => request("PUT", key, bytes, immutable, true),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      artifacts: { type: "string" },
      "source-sha": { type: "string" },
      publish: { type: "boolean", default: false },
      "verify-update": { type: "boolean", default: false },
      "mac-artifacts": { type: "string" },
      "windows-artifacts": { type: "string" },
      acceptance: { type: "string" },
      output: { type: "string" },
    },
  });
  let result;
  if (values["verify-update"]) {
    assert.ok(
      !values.publish &&
        !values.artifacts &&
        values.acceptance &&
        values["mac-artifacts"] &&
        values["windows-artifacts"],
      "DESKTOP_UPDATE_ACCEPTANCE_ARGUMENTS_REQUIRED",
    );
    const plans = [];
    for (const directory of [values["mac-artifacts"], values["windows-artifacts"]])
      plans.push(await prepareDesktopRelease(directory, values["source-sha"]));
    result = verifyDesktopUpdateRegression(
      plans,
      JSON.parse((await readFile(values.acceptance, "utf8")).replace(/^\uFEFF/, "")),
    );
  } else {
    assert.ok(
      !values.acceptance && !values["mac-artifacts"] && !values["windows-artifacts"],
      "DESKTOP_UPDATE_VERIFY_MODE_REQUIRED",
    );
    const plan = await prepareDesktopRelease(values.artifacts, values["source-sha"]);
    result = values.publish
      ? await publishDesktopRelease(plan, createDesktopOssStore())
      : { status: "validated-only", ...plan };
  }
  if (values.output)
    await writeFile(values.output, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  console.log(JSON.stringify(result));
}
