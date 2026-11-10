import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { prepareDesktopRelease, publishDesktopRelease } from "./desktop-release.mjs";

const source = "1".repeat(40);
const version = "0.2.0-rc.2.20261109.2";
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

async function fixture(t, mac = true) {
  const directory = await mkdtemp(join(tmpdir(), "gea-desktop-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stem = `GEA-Desktop-${version}-${mac ? "mac-arm64" : "win-x64"}-signed`;
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
