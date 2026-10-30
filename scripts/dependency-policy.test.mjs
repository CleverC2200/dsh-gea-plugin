import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareDependencyPolicy, restoreDependencyPolicy } from "./dependency-policy.mjs";

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function command(root, args, environment = {}) {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn("corepack", ["pnpm", ...args], {
      cwd: root,
      env: { ...process.env, ...environment, CI: "true" },
    });
    child.stdout.on("data", (value) => (output += value));
    child.stderr.on("data", (value) => (output += value));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "gea-dependency-policy-"));
  let requests = 0;
  const integrity = "sha512-" + createHash("sha512").update("fixture artifact").digest("base64");
  let origin;
  const server = createServer((req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: "policy-fixture",
        versions: {
          "1.0.0": {
            name: "policy-fixture",
            version: "1.0.0",
            dist: { integrity, tarball: origin + "/policy-fixture/-/policy-fixture-1.0.0.tgz" },
            _npmUser: { name: "fixture" },
          },
        },
        time: { created: "2020-01-01T00:00:00Z", "1.0.0": "2020-01-01T00:00:00Z" },
        "dist-tags": { latest: "1.0.0" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const lock = `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      policy-fixture:\n        specifier: 1.0.0\n        version: 1.0.0\npackages:\n  policy-fixture@1.0.0:\n    resolution: {integrity: ${integrity}}\nsnapshots:\n  policy-fixture@1.0.0: {}\n`;
  const roots = {};
  for (const name of ["gea", "core"]) {
    const directory = join(root, "producer", name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        packageManager: name === "core" ? "pnpm@11.7.0" : "pnpm@11.27.0",
        dependencies: { "policy-fixture": "1.0.0" },
      }),
    );
    await fs.writeFile(join(directory, "pnpm-lock.yaml"), lock);
    await fs.writeFile(
      join(directory, ".npmrc"),
      `registry=${origin}\nfetch-retries=0\nfetch-timeout=2000\n`,
    );
    const bootstrap = await command(directory, [
      "install",
      "--lockfile-only",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--cache-dir",
      join(root, "bootstrap-" + name),
    ]);
    assert.equal(bootstrap.code, 0, bootstrap.output);
    git(directory, "init", "--quiet");
    git(directory, "add", ".");
    git(
      directory,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    roots[name] = directory;
  }
  const context = { ...roots, directory: join(root, "artifact"), runId: "42", runAttempt: "1" };
  const clone = async (name) => {
    const values = { ...context, cache: join(root, name + "-cache") };
    for (const repo of ["gea", "core"]) {
      const target = join(root, name, repo);
      await fs.mkdir(join(target, ".."), { recursive: true });
      execFileSync("git", ["clone", "--quiet", "--no-hardlinks", roots[repo], target], {
        stdio: "pipe",
      });
      values[repo] = target;
    }
    return values;
  };
  return { root, context, clone, requests: () => requests };
}

test("fresh native policy checks can be reused by a private consumer without registry requests", async (t) => {
  const f = await fixture(t);
  const initialRequests = f.requests();
  const prepared = await prepareDependencyPolicy(f.context);
  assert.equal(prepared.status, "prepared");
  assert.ok(f.requests() > initialRequests);
  assert.equal(
    await fs.stat(join(f.context.gea, "node_modules")).then(
      () => true,
      () => false,
    ),
    false,
  );
  const consumer = await f.clone("first");
  const restored = await restoreDependencyPolicy(consumer);
  assert.equal(restored.status, "restored");
  const before = f.requests();
  const result = await command(
    consumer.gea,
    ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"],
    { PNPM_CONFIG_CACHE_DIR: consumer.cache },
  );
  assert.equal(result.code, 0, result.output);
  assert.equal(f.requests(), before);
  assert.match(result.output, /verified .* ago/);
  const nativeRows = (await fs.readFile(join(consumer.cache, "lockfile-verified.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const consumerLock = await fs.realpath(join(consumer.gea, "pnpm-lock.yaml"));
  assert.ok(nativeRows.some((row) => row.lockfile.path === consumerLock));
  const stricter = await command(consumer.gea, [
    "install",
    "--lockfile-only",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--minimum-release-age=999999999",
    "--cache-dir",
    consumer.cache,
  ]);
  assert.notEqual(stricter.code, 0, stricter.output);
  assert.match(stricter.output, /MINIMUM_RELEASE_AGE|minimum.*age/i);
});

test("policy transport rejects drift and tampering before creating a consumer cache", async (t) => {
  const f = await fixture(t);
  await prepareDependencyPolicy(f.context);
  const consumer = await f.clone("guards");
  const file = join(f.context.directory, "policy-cache.jsonl");
  const bytes = await fs.readFile(file);
  await fs.writeFile(file, Buffer.concat([bytes, Buffer.from("\n")]));
  await assert.rejects(restoreDependencyPolicy(consumer), /cache digest/);
  await fs.writeFile(file, bytes);
  await assert.rejects(restoreDependencyPolicy({ ...consumer, runAttempt: "2" }), /input binding/);
  await assert.rejects(restoreDependencyPolicy({ ...consumer, runId: "other" }), /input binding/);
  const receiptFile = join(f.context.directory, "receipt.json");
  const receiptBytes = await fs.readFile(receiptFile);
  for (const key of ["node", "platform", "arch"]) {
    const changed = JSON.parse(receiptBytes);
    changed.binding[key] = "different";
    await fs.writeFile(receiptFile, JSON.stringify(changed));
    await assert.rejects(restoreDependencyPolicy(consumer), /input binding/);
  }
  await fs.writeFile(receiptFile, receiptBytes);
  const lock = join(consumer.gea, "pnpm-lock.yaml");
  const original = await fs.readFile(lock);
  await fs.writeFile(lock, Buffer.concat([original, Buffer.from("\n")]));
  await assert.rejects(restoreDependencyPolicy(consumer), /dirty gea/);
  await fs.writeFile(lock, original);
  await assert.rejects(
    restoreDependencyPolicy({ ...f.context, cache: consumer.cache }),
    /native content verification/,
  );
  assert.equal(
    await fs.stat(consumer.cache).then(
      () => true,
      () => false,
    ),
    false,
  );
  await restoreDependencyPolicy(consumer);
  assert.deepEqual(await fs.readFile(join(consumer.cache, "lockfile-verified.jsonl")), bytes);
});

test("parallel consumers have independent policy caches", async (t) => {
  const f = await fixture(t);
  await prepareDependencyPolicy(f.context);
  const a = await f.clone("parallel-a");
  const b = await f.clone("parallel-b");
  await Promise.all([restoreDependencyPolicy(a), restoreDependencyPolicy(b)]);
  const before = await fs.readFile(join(b.cache, "lockfile-verified.jsonl"));
  await fs.writeFile(join(a.cache, "lockfile-verified.jsonl"), "private mutation");
  assert.deepEqual(await fs.readFile(join(b.cache, "lockfile-verified.jsonl")), before);
  assert.deepEqual(await fs.readFile(join(f.context.directory, "policy-cache.jsonl")), before);
});

test("a failed native security check cannot publish a reusable receipt", async (t) => {
  const f = await fixture(t);
  const failed = await f.clone("failed-producer");
  await fs.writeFile(join(failed.gea, "pnpm-workspace.yaml"), "minimumReleaseAge: 999999999\n");
  git(failed.gea, "add", "pnpm-workspace.yaml");
  git(
    failed.gea,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "strict policy",
  );
  failed.directory = join(f.root, "failed-artifact");
  await assert.rejects(prepareDependencyPolicy(failed), /DEPENDENCY_POLICY_CHECK_FAILED/);
  assert.equal(
    await fs.stat(join(failed.directory, "receipt.json")).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.equal(
    await fs.stat(join(failed.directory, "policy-cache.jsonl")).then(
      () => true,
      () => false,
    ),
    false,
  );
});
