import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import {
  prepareDesktopRelease,
  publishDesktopRelease,
  verifyDesktopUpdateRegression,
} from "./desktop-release.mjs";
import { compareDesktopUpdateData } from "./desktop-update-data.mjs";

const source = "1".repeat(40);
const version = "0.2.0-rc.2.20261109.2";
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

async function fixture(t, mac = true) {
  const directory = await mkdtemp(join(tmpdir(), "gea-desktop-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stem = `Synear-GEA-${version}-${mac ? "mac-arm64" : "win-x64"}-signed`;
  const primary = stem + (mac ? ".zip" : ".exe");
  const installer = stem + (mac ? ".dmg" : ".exe");
  const contents = new Map(
    (mac ? [installer, primary, primary + ".blockmap"] : [installer, primary + ".blockmap"]).map(
      (name) => [name, Buffer.from("signed bytes for " + name)],
    ),
  );
  const files = [...contents]
    .filter(([name]) => !name.endsWith(".blockmap"))
    .map(([url, bytes]) => ({ url, size: bytes.length, sha512: hash(bytes, "sha512", "base64") }));
  const feedName = mac ? "nightly-mac.yml" : "nightly.yml";
  contents.set(
    feedName,
    Buffer.from(
      YAML.stringify({
        version,
        files,
        path: primary,
        sha512: files.find((file) => file.url === primary).sha512,
      }),
    ),
  );
  for (const [name, bytes] of contents) await writeFile(join(directory, name), bytes);
  const receipt = {
    status: "packaged-and-runtime-smoke-passed",
    geaSha: source,
    desktopVersion: version,
    platform: mac ? "darwin-arm64" : undefined,
    windowsHost: mac ? undefined : "win32-x64",
    artifact: installer,
    size: contents.get(installer).length,
    sha256: hash(contents.get(installer)),
    localCandidate: false,
    signing: "Developer ID; Apple notarized and stapled App and DMG",
    unsigned: false,
    windowsSigning: { publisher: "company" },
  };
  await writeFile(join(directory, "result.json"), JSON.stringify(receipt));
  const objects = new Map(),
    writes = [];
  const store = {
    read: async (key) => objects.get(key) ?? null,
    put: async (key, bytes, immutable) => {
      if (immutable) assert.equal(objects.has(key), false);
      writes.push(key);
      objects.set(key, bytes);
    },
  };
  return {
    directory,
    feedName,
    primary,
    contents,
    receipt,
    objects,
    writes,
    store,
    plan: () => prepareDesktopRelease(directory, source),
  };
}

test("a successful receipt must bind the expected installer name, size and digest", async (t) => {
  for (const mac of [true, false]) {
    for (const field of ["artifact", "size", "sha256"]) {
      const f = await fixture(t, mac);
      delete f.receipt[field];
      await writeFile(join(f.directory, "result.json"), JSON.stringify(f.receipt));
      await assert.rejects(f.plan(), /INSTALLER_IDENTITY_REQUIRED/);
    }
  }
});

for (const mac of [true, false])
  test(`${mac ? "Mac missing feed" : "Windows stale feed"} publishes the complete updater and verifies anonymous bytes before the feed`, async (t) => {
    const f = await fixture(t, mac),
      plan = await f.plan();
    const key = plan.prefix + plan.feed;
    if (!mac) f.objects.set(key, Buffer.from(YAML.stringify({ version: "0.2.0-rc.2.20261104.1" })));
    const result = await publishDesktopRelease(plan, f.store);
    assert.equal(result.status, "published-and-anonymously-verified");
    assert.equal(result.updateAcceptance, "pending-full-ui-regression");
    assert.equal(f.writes.at(-1), key);
    assert.deepEqual(
      YAML.parse(f.objects.get(key).toString())
        .files.map((file) => file.url)
        .sort(),
      (mac ? [f.primary, f.primary.replace(".zip", ".dmg")] : [f.primary]).sort(),
    );
    assert.ok(f.objects.has(plan.prefix + f.primary + ".blockmap"));
    const count = f.writes.length;
    await publishDesktopRelease(plan, f.store);
    assert.equal(f.writes.length, count);
  });

test("a missing ZIP, changed stapled DMG or wrong primary digest stops before upload", async (t) => {
  const f = await fixture(t);
  const zip = join(f.directory, f.primary),
    original = await readFile(zip);
  await rm(zip);
  await assert.rejects(f.plan(), /FILE_REQUIRED/);
  await writeFile(zip, original);
  await writeFile(
    join(f.directory, f.primary.replace(".zip", ".dmg")),
    "changed after notarization",
  );
  await assert.rejects(f.plan(), /INSTALLER_HASH_MISMATCH/);
});

test("failed payload upload or anonymous read never promotes a new feed", async (t) => {
  for (const failure of ["upload", "public-read"]) {
    const f = await fixture(t),
      plan = await f.plan();
    const store =
      failure === "upload"
        ? {
            ...f.store,
            put: async () => {
              throw Error("upload failed");
            },
          }
        : {
            ...f.store,
            read: async (key, authenticated) => (authenticated ? f.store.read(key) : null),
          };
    await assert.rejects(
      publishDesktopRelease(plan, store),
      /upload failed|PUBLIC_READBACK_FAILED/,
    );
    assert.equal(f.objects.has(plan.prefix + plan.feed), false);
  }
});

test("downgrades, changed same-version feeds and immutable filename conflicts are refused", async (t) => {
  for (const kind of ["newer", "same-version", "payload"]) {
    const f = await fixture(t),
      plan = await f.plan();
    if (kind === "payload")
      f.objects.set(plan.prefix + f.primary, Buffer.from("different release"));
    else
      f.objects.set(
        plan.prefix + plan.feed,
        Buffer.from(
          YAML.stringify({ version: kind === "newer" ? "0.2.0-rc.2.20261110.1" : version }),
        ),
      );
    await assert.rejects(
      publishDesktopRelease(plan, f.store),
      /DOWNGRADE_REJECTED|SAME_VERSION_CHANGED|IMMUTABLE_CONFLICT/,
    );
    assert.ok(!f.writes.includes(plan.prefix + plan.feed));
  }
});

test("concurrent feed changes are preserved and unsigned builds cannot be published", async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  const store = {
    ...f.store,
    put: async (...args) => {
      await f.store.put(...args);
      f.objects.set(plan.prefix + plan.feed, Buffer.from("other release"));
    },
  };
  await assert.rejects(publishDesktopRelease(plan, store), /FEED_CHANGED/);
  f.receipt.localCandidate = true;
  await writeFile(join(f.directory, "result.json"), JSON.stringify(f.receipt));
  await assert.rejects(publishDesktopRelease(await f.plan(), f.store), /CANDIDATE_NOT_PUBLISHABLE/);
});

async function updateFixture(t) {
  const fixtures = [await fixture(t), await fixture(t, false)];
  const plans = await Promise.all(fixtures.map((f) => f.plan()));
  const fromVersion = "0.2.0-rc.2.20261104.1";
  const receipt = { schema: 1, status: "passed", version, sourceSha: source, platforms: {} };
  for (const plan of plans)
    receipt.platforms[plan.platform] = {
      fromVersion,
      toVersion: version,
      installerSha256: plan.files.find((file) => /\.(dmg|exe)$/.test(file.name)).sha256,
      feedSha256: plan.files.at(-1).sha256,
      signatureVerified: true,
      ui: {
        entry: plan.platform === "mac-arm64" ? "restart-ready" : "check-download",
        downloadVerified: true,
        installAndRestartInvoked: true,
        normalSuccessorWindow: true,
        accountResumed: true,
        currentVersionAndLatest: true,
      },
      relaunch: {
        method: "native-updater",
        manualSuccessorLaunch: false,
        flagsUnmodified: true,
        updaterOrCoordinatorIntercepted: false,
      },
      data: {
        status: "passed",
        fromVersion,
        toVersion: version,
        configuration: {
          status: "passed",
          allUserPatchValuesPreserved: true,
          onlyExpectedCoreProofRefreshed: true,
          coreProofMatchesVerifiedInstalledSeed: true,
        },
        history: {
          status: "passed",
          historicalSessions: 2,
          historicalEvents: 6,
          allOriginalHeadersAndEventsPreserved: true,
          readWithNewBundledCore: true,
        },
      },
    };
  return { fixtures, plans, receipt };
}

test("release completion requires both platforms and rejects stale artifacts or script-controlled relaunch", async (t) => {
  const { plans, receipt } = await updateFixture(t);
  assert.equal(verifyDesktopUpdateRegression(plans, receipt).status, "full-ui-update-regression-passed");
  assert.throws(() => verifyDesktopUpdateRegression([plans[0]], receipt), /BOTH_PLATFORMS_REQUIRED/);
  for (const platform of ["mac-arm64", "win-x64"]) {
    for (const change of [
      (r) => delete r.platforms[platform],
      (r) => (r.sourceSha = "2".repeat(40)),
      (r) => (r.platforms[platform].installerSha256 = "0".repeat(64)),
      (r) => (r.platforms[platform].feedSha256 = "0".repeat(64)),
      (r) => (r.platforms[platform].fromVersion = version),
      (r) => (r.platforms[platform].signatureVerified = false),
      (r) => (r.platforms[platform].ui.installAndRestartInvoked = false),
      (r) => (r.platforms[platform].ui.accountResumed = false),
      (r) => (r.platforms[platform].relaunch.manualSuccessorLaunch = true),
      (r) => (r.platforms[platform].relaunch.flagsUnmodified = false),
      (r) => (r.platforms[platform].relaunch.updaterOrCoordinatorIntercepted = true),
      (r) => (r.platforms[platform].data.toVersion = "0.2.0"),
      (r) => (r.platforms[platform].data.history.historicalEvents = 0),
      (r) => (r.platforms[platform].data.configuration.allUserPatchValuesPreserved = false),
    ]) {
      const changed = structuredClone(receipt);
      change(changed);
      assert.throws(() => verifyDesktopUpdateRegression(plans, changed), /DESKTOP_UPDATE_/);
    }
  }
});

test("the final CLI validates both unchanged signed artifact sets without publishing", async (t) => {
  const { fixtures, receipt } = await updateFixture(t);
  const input = join(fixtures[0].directory, "update-acceptance.json");
  await writeFile(input, "\uFEFF" + JSON.stringify(receipt));
  const output = execFileSync(
    process.execPath,
    [
      "scripts/desktop-release.mjs",
      "--verify-update",
      "--source-sha", source,
      "--mac-artifacts", fixtures[0].directory,
      "--windows-artifacts", fixtures[1].directory,
      "--acceptance", input,
    ],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(output).status, "full-ui-update-regression-passed");
});

test("data comparison preserves every original event and user setting, allowing only the installed Core proof", () => {
  const oldCore = { root: "old-app", head: "old-core" };
  const installedCore = { root: "new-app", head: "new-core" };
  const before = {
    version: "0.2.0-rc.2.20261104.1",
    patch: [
      {
        id: "gea-proof",
        config: { secret: "private-do-not-print", pluginUpdates: { core: oldCore } },
      },
    ],
    sessions: [
      {
        header: { id: "old-chat", title: "original" },
        events: [
          { type: "user", text: "original question" },
          { type: "assistant", text: "original reply" },
        ],
      },
    ],
  };
  const after = structuredClone(before);
  after.version = version;
  after.patch[0].config.pluginUpdates.core = installedCore;
  after.sessions[0].events.push({ type: "user", text: "later message" });
  const result = compareDesktopUpdateData(before, after, installedCore);
  assert.equal(result.history.historicalEvents, 2);
  assert.equal(result.configuration.allUserPatchValuesPreserved, true);
  for (const change of [
    (r) => (r.patch[0].config.secret = "changed"),
    (r) => (r.patch[0].config.pluginUpdates.core = oldCore),
    (r) => (r.sessions = []),
    (r) => (r.sessions[0].header.title = "changed"),
    (r) => r.sessions[0].events.shift(),
    (r) => (r.sessions[0].events[1].text = "changed reply"),
  ]) {
    const changed = structuredClone(after);
    change(changed);
    assert.throws(() => compareDesktopUpdateData(before, changed, installedCore), (error) => {
      assert.match(error.message, /DESKTOP_UPDATE_/);
      assert.ok(!error.message.includes("private-do-not-print"));
      return true;
    });
  }
  assert.throws(
    () => compareDesktopUpdateData({ ...before, sessions: [] }, after, installedCore),
    /EXISTING_HISTORY_REQUIRED/,
  );
});
