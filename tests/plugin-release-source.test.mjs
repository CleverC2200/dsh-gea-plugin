import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  createPluginReleaseSource,
  inspectPluginArchive,
} from "../src/host/plugin-release-source.ts";
import {
  companyPackageNames,
  projectPluginRelease,
} from "../src/shared/plugin-release.mjs";
const digest = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "signed-plugin-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const objects = new Map();
  const releases = [];
  for (const name of companyPackageNames) {
    const packageRoot = join(dir, name.replaceAll("/", "-"), "package");
    await mkdir(join(packageRoot, "lib"), { recursive: true });
    const contracts = JSON.parse(
      await readFile(
        new URL(
          "../scripts/fixtures/plugin-release/production-exports.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const actual = contracts.find((row) => row.name === name);
    const manifest = {
      name,
      version: "1.1.0",
      peerDependencies: {},
      dependencies: {},
      exports: actual.exports,
      dsh: actual.dsh,
    };
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );
    for (const declaration of Object.values(manifest.exports)) {
      const relative = (
        typeof declaration === "string" ? declaration : declaration.default
      ).slice(2);
      await mkdir(dirname(join(packageRoot, relative)), { recursive: true });
      await writeFile(join(packageRoot, relative), "export default {};");
    }
    await writeFile(join(packageRoot, "cordis.patch.yml"), "[]");
    const archive = join(dir, `${releases.length}.tgz`);
    execFileSync("tar", [
      "-czf",
      archive,
      "-C",
      join(packageRoot, ".."),
      "package",
    ]);
    const archiveBytes = await readFile(archive),
      hash = digest(archiveBytes),
      url = `https://fixture.invalid/releases/${hash}/plugin.tgz`;
    objects.set(url, archiveBytes);
    const release = projectPluginRelease({
      manifest,
      artifact: { url, size: archiveBytes.length, sha256: hash },
      supportedCores: [{ head: "a".repeat(40), version: "0.2.0-rc.2" }],
      dataCompatibility: { kind: "preserve" },
      notes: "signed local fixture",
    });
    const bytes = Buffer.from(JSON.stringify(release)),
      releaseHash = digest(bytes),
      releaseUrl = `https://fixture.invalid/releases/${releaseHash}/release.json`;
    objects.set(releaseUrl, bytes);
    releases.push({ name, url: releaseUrl, sha256: releaseHash });
  }
  const payload = Buffer.from(
    JSON.stringify({
      schema: 1,
      channel: "test",
      revision: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      releases,
    }),
  );
  const channelUrl = "https://fixture.invalid/channels/test.json";
  objects.set(
    channelUrl,
    Buffer.from(
      JSON.stringify({
        keyId: "fixture",
        payloadBase64: payload.toString("base64"),
        signatureBase64: sign(null, payload, privateKey).toString("base64"),
      }),
    ),
  );
  const calls = [];
  const config = {
    channel: "test",
    channelUrl,
    allowed: [
      { origin: "https://fixture.invalid", pathPrefix: "/channels/" },
      { origin: "https://fixture.invalid", pathPrefix: "/releases/" },
    ],
    authenticationRef: "fixture-read",
    trustedKeys: [
      {
        keyId: "fixture",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      },
    ],
  };
  const source = createPluginReleaseSource(config, {
    trustDirectory: join(dir, "trust"),
    resolveAuthentication: async (ref, url) => {
      assert.equal(ref, "fixture-read");
      assert.equal(new URL(url).origin, "https://fixture.invalid");
      return { "X-Fixture-Read": "local-test" };
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(objects.get(url), {
        status: objects.has(url) ? 200 : 404,
      });
    },
  });
  return {
    dir,
    objects,
    channelUrl,
    source,
    calls,
    privateKey,
    config,
    releases,
  };
}
test("signed channel verifies raw bytes, release hashes and durable tgz manifest before returning file", async (t) => {
  const f = await fixture(t),
    releases = await f.source.check();
  assert.equal(releases.length, 3);
  const path = await f.source.download(releases[0], join(f.dir, "cache"));
  assert.equal(digest(await readFile(path)), releases[0].artifact.sha256);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    f.calls.every(
      (c) =>
        c.init.redirect === "error" &&
        c.init.headers["X-Fixture-Read"] === "local-test",
    ),
    true,
  );
});
test("source rejects tampering and clears previous execution authority while original inventory remains outside source", async (t) => {
  const f = await fixture(t),
    releases = await f.source.check();
  const envelope = JSON.parse(f.objects.get(f.channelUrl));
  envelope.payloadBase64 = Buffer.from("tampered").toString("base64");
  f.objects.set(f.channelUrl, Buffer.from(JSON.stringify(envelope)));
  await assert.rejects(f.source.check(), /SOURCE_SIGNATURE_INVALID/);
  await assert.rejects(
    f.source.download(releases[0], join(f.dir, "cache")),
    /SOURCE_RELEASE_NOT_VERIFIED/,
  );
});
test("source rejects mismatched release bytes and tgz hash without durable package", async (t) => {
  const f = await fixture(t),
    releases = await f.source.check();
  f.objects.set(releases[0].artifact.url, Buffer.from("bad archive"));
  await assert.rejects(
    f.source.download(releases[0], join(f.dir, "cache")),
    /SOURCE_ARTIFACT_HASH_MISMATCH/,
  );
  const releaseUrl = [...f.objects.keys()].find((url) =>
    url.endsWith("/release.json"),
  );
  f.objects.set(releaseUrl, Buffer.from("{}"));
  await assert.rejects(f.source.check(), /SOURCE_RELEASE_HASH_MISMATCH/);
});
function resign(f, change) {
  const envelope = JSON.parse(f.objects.get(f.channelUrl)),
    payload = JSON.parse(Buffer.from(envelope.payloadBase64, "base64"));
  change(payload);
  const bytes = Buffer.from(JSON.stringify(payload));
  f.objects.set(
    f.channelUrl,
    Buffer.from(
      JSON.stringify({
        keyId: "fixture",
        payloadBase64: bytes.toString("base64"),
        signatureBase64: sign(null, bytes, f.privateKey).toString("base64"),
      }),
    ),
  );
}
test("durable channel approval rejects signed replay, expiry, and corrupted trust after source recreation", async (t) => {
  const f = await fixture(t);
  resign(f, (p) => (p.revision = 2));
  await f.source.check();
  resign(f, (p) => (p.revision = 1));
  const reloaded = createPluginReleaseSource(f.config, {
    trustDirectory: join(f.dir, "trust"),
    resolveAuthentication: async () => ({}),
    fetch: async (url) => new Response(f.objects.get(url)),
  });
  await assert.rejects(reloaded.check(), /SOURCE_CHANNEL_REPLAY/);
  resign(f, (p) => {
    p.revision = 3;
    p.expiresAt = new Date(Date.now() - 1000).toISOString();
  });
  await assert.rejects(reloaded.check(), /SOURCE_CHANNEL_TIME_INVALID/);
  resign(f, (p) => (p.expiresAt = new Date(Date.now() + 10000).toISOString()));
  await writeFile(join(f.dir, "trust/approved-channel.json"), "broken");
  await assert.rejects(reloaded.check(), /Unexpected token/);
});
test("signed same-version new content and signed package rollback are rejected across approved revisions", async (t) => {
  const f = await fixture(t);
  await f.source.check();
  const ref = f.releases[0],
    old = JSON.parse(f.objects.get(ref.url));
  const changed = {
    ...old,
    artifact: {
      ...old.artifact,
      url: `https://fixture.invalid/releases/${"d".repeat(64)}/plugin.tgz`,
      sha256: "d".repeat(64),
    },
  };
  const bytes = Buffer.from(JSON.stringify(changed)),
    sha256 = digest(bytes),
    url = `https://fixture.invalid/releases/${sha256}/release.json`;
  f.objects.set(url, bytes);
  resign(f, (p) => {
    p.revision = 2;
    p.releases[0] = { ...ref, url, sha256 };
  });
  await assert.rejects(
    f.source.check(),
    /SOURCE_SAME_VERSION_CONTENT_MISMATCH/,
  );
  const rollback = Buffer.from(JSON.stringify({ ...old, version: "1.0.0" })),
    rollbackHash = digest(rollback),
    rollbackUrl = `https://fixture.invalid/releases/${rollbackHash}/release.json`;
  f.objects.set(rollbackUrl, rollback);
  resign(f, (p) => {
    p.releases[0] = { ...ref, url: rollbackUrl, sha256: rollbackHash };
  });
  await assert.rejects(f.source.check(), /SOURCE_VERSION_ROLLBACK/);
});

test("archive inspection rejects symlinks and supports real production conditional exports", async (t) => {
  const f = await fixture(t),
    releases = await f.source.check();
  const path = await f.source.download(releases[0], join(f.dir, "cache"));
  assert.equal((await inspectPluginArchive(path)).name, companyPackageNames[0]);
  const linkRoot = join(f.dir, "bad/package");
  await mkdir(linkRoot, { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink("/etc/passwd", join(linkRoot, "package.json"));
  const bad = join(f.dir, "symlink.tgz");
  execFileSync("tar", ["-czf", bad, "-C", join(linkRoot, ".."), "package"]);
  await assert.rejects(
    inspectPluginArchive(bad),
    /SOURCE_ARCHIVE_LINK_FORBIDDEN/,
  );
});
test("allowed-source policy rejects credential URLs and escapes before fetching", async (t) => {
  const f = await fixture(t);
  for (const channelUrl of [
    "https://fixture.invalid/channels/test.json?token=secret",
    "https://other.invalid/channels/test.json",
    "https://user:pass@fixture.invalid/channels/test.json",
    "https://fixture.invalid/channels/%2e%2e/releases/test.json",
  ])
    assert.throws(
      () =>
        createPluginReleaseSource(
          { ...f.config, channelUrl },
          {
            trustDirectory: join(f.dir, "trust"),
            resolveAuthentication: async () => ({}),
          },
        ),
      /SOURCE_URL_FORBIDDEN/,
    );
  assert.equal(f.calls.length, 0);
});

test("signed release cannot lie about the final tar peer graph", async (t) => {
  const f = await fixture(t),
    ref = f.releases[0],
    release = JSON.parse(f.objects.get(ref.url));
  release.peerDependencies = { "external-consumer": "^2.0.0" };
  const bytes = Buffer.from(JSON.stringify(release)),
    sha256 = digest(bytes),
    url = `https://fixture.invalid/releases/${sha256}/release.json`;
  f.objects.set(url, bytes);
  resign(f, (p) => (p.releases[0] = { ...ref, url, sha256 }));
  const releases = await f.source.check();
  await assert.rejects(
    f.source.download(releases[0], join(f.dir, "cache")),
    /SOURCE_ARCHIVE_RELEASE_MISMATCH/,
  );
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(join(f.dir, "cache")), []);
});
test("single release CLI reads final conditional tar manifest and accepts only registered Core identities", async (t) => {
  const f = await fixture(t),
    releases = await f.source.check(),
    release = releases[0];
  const archive = await f.source.download(release, join(f.dir, "cache"));
  const supported = JSON.parse(
    await readFile(
      new URL("../scripts/supported-cores.json", import.meta.url),
      "utf8",
    ),
  );
  const metadata = join(f.dir, "metadata.json");
  await writeFile(
    metadata,
    JSON.stringify({
      artifactUrl: release.artifact.url,
      supportedCores: [supported[0]],
      dataCompatibility: { kind: "preserve" },
      notes: "independent release",
    }),
  );
  const entry = fileURLToPath(
    new URL("../scripts/create-plugin-release.mjs", import.meta.url),
  );
  const receipt = JSON.parse(
    execFileSync(
      process.execPath,
      [
        entry,
        "--archive",
        archive,
        "--metadata",
        metadata,
        "--destination",
        join(f.dir, "release-output"),
      ],
      { encoding: "utf8" },
    ),
  );
  const content = await readFile(receipt.path),
    projected = JSON.parse(content);
  assert.equal(receipt.sha256, digest(content));
  assert.equal(projected.name, release.name);
  assert.equal(projected.version, release.version);
  assert.deepEqual(projected.requires, {});
  assert.equal(receipt.published, false);
  await writeFile(
    metadata,
    JSON.stringify({
      artifactUrl: release.artifact.url,
      supportedCores: [{ ...supported[0], head: "c".repeat(40) }],
      dataCompatibility: { kind: "preserve" },
      notes: "invalid fixed input",
    }),
  );
  const { spawnSync } = await import("node:child_process");
  const failed = spawnSync(
    process.execPath,
    [
      entry,
      "--archive",
      archive,
      "--metadata",
      metadata,
      "--destination",
      join(f.dir, "invalid-output"),
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /RELEASE_CORE_UNSUPPORTED/);
});
test("an older delayed check cannot replace the newer verified channel receipt", async (t) => {
  const f = await fixture(t);
  let releaseOld, startedResolve;
  const gate = new Promise((resolve) => (releaseOld = resolve)),
    started = new Promise((resolve) => (startedResolve = resolve));
  let first = true;
  const source = createPluginReleaseSource(f.config, {
    trustDirectory: join(f.dir, "trust"),
    resolveAuthentication: async () => ({}),
    fetch: async (url) => {
      const bytes = f.objects.get(url);
      if (url === f.channelUrl && first) {
        first = false;
        startedResolve();
        await gate;
      }
      return new Response(bytes);
    },
  });
  const old = source.check();
  const rejection = assert.rejects(old, /SOURCE_CHECK_SUPERSEDED/);
  await started;
  resign(f, (p) => (p.revision = 2));
  const fresh = source.check();
  releaseOld();
  await rejection;
  const releases = await fresh;
  assert.equal(
    JSON.parse(
      await readFile(join(f.dir, "trust/approved-channel.json"), "utf8"),
    ).revision,
    2,
  );
  assert.equal(releases.length, 3);
});
test("signed approval expires between check and download and cannot authorize a stale plan", async (t) => {
  const f = await fixture(t);
  let now = Date.now();
  const source = createPluginReleaseSource(f.config, {
    trustDirectory: join(f.dir, "ttl-trust"),
    now: () => now,
    resolveAuthentication: async () => ({}),
    fetch: async url => new Response(f.objects.get(url)),
  });
  const releases = await source.check();
  source.assertCurrentRelease(releases[0]);
  now += 7200000;
  assert.throws(() => source.assertCurrentRelease(releases[0]), /SOURCE_APPROVAL_EXPIRED/);
  await assert.rejects(source.download(releases[0], join(f.dir, "cache")), /SOURCE_APPROVAL_EXPIRED/);
});
