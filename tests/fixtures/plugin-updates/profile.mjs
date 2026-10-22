import { mkdtemp, mkdir, readFile, writeFile, rm, rename, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPluginReleaseSource } from "../../../src/host/plugin-release-source.ts";
import { companyPackageNames, projectPluginRelease } from "../../../src/shared/plugin-release.mjs";
const digest = (b) => createHash("sha256").update(b).digest("hex");
export async function controllerFixture(
  t,
  { mode = "success", sourceFailure, fileCommit, allUpdates = false, releasePeers = {} } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "plugin-update-real-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "profile"),
    anchor = join(root, "anchor");
  await mkdir(join(dir, "node_modules"), { recursive: true });
  const store = join(root, "profile-store", "v11");
  await mkdir(store, { recursive: true });
  await writeFile(join(dir, "node_modules/.modules.yaml"), JSON.stringify({ storeDir: store }));
  await mkdir(anchor);
  await writeFile(join(anchor, "package.json"), JSON.stringify({ dependencies: {} }));
  const oldVersions = ["1.0.0", "2.0.0", "3.0.0"];
  const contracts = JSON.parse(
    await readFile(
      new URL("../../../scripts/fixtures/plugin-release/production-exports.json", import.meta.url),
      "utf8",
    ),
  );
  const files = new Map(),
    references = [],
    releases = [];
  for (const [index, name] of companyPackageNames.entries()) {
    const contract = contracts.find((row) => row.name === name),
      oldVersion = oldVersions[index],
      version = allUpdates
        ? ["1.1.0", "2.1.0", "3.1.0"][index]
        : index === 2
          ? "3.1.0"
          : oldVersion;
    const manifest = {
      name,
      version,
      dependencies: {},
      peerDependencies:
        releasePeers[name] ??
        (index === 2
          ? {
              [companyPackageNames[0]]: allUpdates ? "^1.0.0" : "1.0.0",
              [companyPackageNames[1]]: allUpdates ? "^2.0.0" : "2.0.0",
            }
          : {}),
      exports: contract.exports,
      dsh: contract.dsh,
    };
    const source = join(root, "archives", String(index), "package");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "package.json"), JSON.stringify(manifest));
    await writeFile(join(source, "cordis.patch.yml"), "[]");
    for (const declaration of Object.values(manifest.exports)) {
      const file = (typeof declaration === "string" ? declaration : declaration.default).slice(2);
      await mkdir(dirname(join(source, file)), { recursive: true });
      await writeFile(
        join(source, file),
        `export const pluginPackageVersion=${JSON.stringify({ name, version })};export default {};\n`,
      );
    }
    const archive = join(root, `${index}.tgz`);
    execFileSync("tar", ["-czf", archive, "-C", dirname(source), "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const bytes = await readFile(archive),
      sha256 = digest(bytes),
      url = `https://fixture.invalid/packages/${sha256}/plugin.tgz`;
    files.set(url, bytes);
    const release = projectPluginRelease({
      manifest,
      artifact: { url, size: bytes.length, sha256 },
      supportedCores: [{ head: "a".repeat(40), version: "0.2.0-rc.2" }],
      dataCompatibility: { kind: "preserve" },
      notes: "single-package fixture",
    });
    releases.push(release);
    const releaseBytes = Buffer.from(JSON.stringify(release)),
      releaseHash = digest(releaseBytes),
      releaseUrl = `https://fixture.invalid/releases/${releaseHash}/release.json`;
    files.set(releaseUrl, releaseBytes);
    references.push({ name, url: releaseUrl, sha256: releaseHash });
    const target = join(dir, "node_modules", name);
    await mkdir(target, { recursive: true });
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", target]);
    if (allUpdates || index === 2) {
      await writeFile(
        join(target, "package.json"),
        JSON.stringify({ ...manifest, version: oldVersion }),
      );
      await writeFile(
        join(target, "lib/host.js"),
        `export const pluginPackageVersion=${JSON.stringify({ name, version: oldVersion })};export const oldCode=true;\n`,
      );
      await writeFile(
        join(target, "lib/client.js"),
        `export const pluginPackageVersion=${JSON.stringify({ name, version: oldVersion })};\n`,
      );
    }
  }
  const profileManifest = {
    dependencies: Object.fromEntries(
      companyPackageNames.map((name, index) => [name, oldVersions[index]]),
    ),
    dsh: { profile: { bundles: [...companyPackageNames] } },
    retained: { draft: "keep", selection: "sales" },
  };
  await writeFile(join(dir, "package.json"), JSON.stringify(profileManifest));
  await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\nold: true\n");
  await writeFile(join(dir, "cordis.patch.yml"), "retained patch\n");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"),
    payload = Buffer.from(
      JSON.stringify({
        schema: 1,
        channel: "test",
        revision: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        releases: references,
      }),
    );
  const channel = "https://fixture.invalid/channels/test.json";
  files.set(
    channel,
    Buffer.from(
      JSON.stringify({
        keyId: "fixture",
        payloadBase64: payload.toString("base64"),
        signatureBase64: sign(null, payload, privateKey).toString("base64"),
      }),
    ),
  );
  const source = createPluginReleaseSource(
    {
      channel: "test",
      channelUrl: channel,
      authenticationRef: "fixture-read",
      allowed: [{ origin: "https://fixture.invalid", pathPrefix: "/" }],
      trustedKeys: [
        {
          keyId: "fixture",
          publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
        },
      ],
    },
    {
      trustDirectory: join(root, "source-trust"),
      fileCommit: fileCommit ?? { replace: rename },
      resolveAuthentication: async () => ({}),
      fetch: async (url) => {
        if (sourceFailure === "http")
          return new Response("secret-credential /private/path Authorization", {
            status: 503,
          });
        if (sourceFailure === "network")
          throw Error("secret-credential /private/path Authorization");
        if (sourceFailure === "signature" && url === channel) {
          const signed = JSON.parse(files.get(url).toString("utf8"));
          return new Response(
            JSON.stringify({
              ...signed,
              signatureBase64: Buffer.alloc(64).toString("base64"),
            }),
          );
        }
        return new Response(files.get(url));
      },
    },
  );
  const profile = {
    name: "fixture",
    dir,
    installAnchor: join(anchor, "package.json"),
    cwd: root,
    home: root,
    packageManager: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./package-manager.cjs", import.meta.url)), "--fixture-prefix"],
      env: {
        FIXTURE_MODE: mode,
        FIXTURE_LAUNCHER_MARKER: "launcher-provided",
        FIXTURE_LATE_FILE: join(dir, "late-write"),
      },
    },
  };
  const proofs = companyPackageNames.map((name, index) => ({
    name,
    resolvedDir: join(dir, "node_modules", name),
    host: {
      kind: "active",
      stamp: { name, version: oldVersions[index] },
      identity: "fixture-host-" + name,
    },
    client: {
      kind: "observed",
      stamp: { name, version: oldVersions[index] },
      identity: "fixture-client-" + name,
      binding: {
        hostProcessIdentity: `${process.pid}:${performance.timeOrigin}`,
        pageIdentity: "fixture-page",
        nonce: "fixture-nonce",
      },
    },
  }));
  return {
    root,
    files,
    privateKey,
    dir,
    profile,
    source,
    proofs,
    options: {
      profile,
      core: { head: "a".repeat(40), version: "0.2.0-rc.2", sdk: {} },
      runtimeDirectory: join(root, "updates"),
      source,
      readRuntimeProofs: async () => structuredClone(proofs),
      idleTimeoutMs: 2000,
      quiescenceWaitMs: 300,
    },
  };
}
export async function waitForStage(controller, stages, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const operation = controller.snapshot().operation;
    if (operation && stages.includes(operation.stage)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error("operation did not reach expected stage: " + JSON.stringify(controller.snapshot()));
}
