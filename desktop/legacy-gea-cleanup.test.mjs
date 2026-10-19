import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  access,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { cleanupLegacyGea } from "./legacy-gea-cleanup.mjs";

const gea = "@cleverc2200/gea-dsh-prototype";
const id = (n) => "channel-00000000-0000-4000-8000-" + String(n).padStart(12, "0");
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gea-legacy-cleanup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "dsh-gea-desktop"),
    home = join(root, "new-home");
  const plugins = join(data, "plugins"),
    versions = join(plugins, "versions");
  await mkdir(versions, { recursive: true });
  await writeFile(
    join(data, "gea.config.json"),
    JSON.stringify({ geaBaseUrl: "https://example.test", analysis: {} }),
  );
  await writeFile(
    join(plugins, "selection.json"),
    JSON.stringify({ active: id(4), previous: id(3), verified: id(4) }),
  );
  for (let n = 1; n <= 4; n++) {
    const path = join(versions, id(n));
    await mkdir(join(path, "node_modules", gea), { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ name: "gea-desktop-runtime", dependencies: { [gea]: "0.0.130" } }),
    );
    const lock = "lockfileVersion: 9\n";
    await writeFile(join(path, "pnpm-lock.yaml"), lock);
    await writeFile(
      join(path, "version.json"),
      JSON.stringify({
        id: id(n),
        state: "prepared",
        versions: { [gea]: "0.0.130" },
        lockSha256: createHash("sha256").update(lock).digest("hex"),
      }),
    );
    await writeFile(
      join(path, "node_modules", gea, "package.json"),
      JSON.stringify({ name: gea, version: "0.0.130" }),
    );
  }
  const preserved = [
    "login.encrypted",
    "data/home/agent-plugins/state.json",
    "data/home/profiles/full/session.json",
    "data/workspace/my-skill.md",
  ];
  for (const file of preserved) {
    await mkdir(join(data, file, ".."), { recursive: true });
    await writeFile(join(data, file), "user-owned " + file);
  }
  return { data, home, plugins, versions, preserved, isInUse: async () => false };
}

test("preview is read-only and cleanup only removes unreferenced owned GEA versions", async (t) => {
  const f = await fixture(t);
  const preview = await cleanupLegacyGea(f);
  assert.deepEqual(preview.candidates, [id(1), id(2)]);
  assert.deepEqual(await readdir(f.plugins), ["selection.json", "versions"]);
  await assert.rejects(access(f.home), { code: "ENOENT" });
  const result = await cleanupLegacyGea({ ...f, apply: true });
  assert.deepEqual(result.removed, [id(1), id(2)]);
  assert.deepEqual(await readdir(f.versions), [id(3), id(4)]);
  for (const file of f.preserved)
    assert.equal(await readFile(join(f.data, file), "utf8"), "user-owned " + file);
  const receipt = JSON.parse(
    await readFile(join(f.home, "profiles/desktop/gea/legacy-cleanup/latest.json")),
  );
  assert.deepEqual(receipt.removed, result.removed);
  assert.deepEqual((await cleanupLegacyGea({ ...f, apply: true })).removed, []);
});

test("custom plugins, unknown files, modified locks and pinned versions are preserved", async (t) => {
  for (const variant of [
    "custom-plugin",
    "official-extra-plugin",
    "custom-file",
    "modified-lock",
    "pinned",
  ]) {
    const f = await fixture(t);
    const path = join(f.versions, id(1));
    if (variant === "custom-plugin" || variant === "official-extra-plugin")
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({
          name: "gea-desktop-runtime",
          dependencies: {
            [gea]: "0.0.130",
            [variant === "custom-plugin" ? "my-plugin" : "@deepseek-ai/my-plugin"]: "1.0.0",
          },
        }),
      );
    if (variant === "custom-file") await writeFile(join(path, "my-skill.md"), "keep");
    if (variant === "modified-lock") await writeFile(join(path, "pnpm-lock.yaml"), "user change");
    if (variant === "pinned") {
      const receipt = JSON.parse(await readFile(join(path, "version.json")));
      await writeFile(join(path, "version.json"), JSON.stringify({ ...receipt, pinned: true }));
    }
    const result = await cleanupLegacyGea({ ...f, apply: true });
    assert.deepEqual(result.removed, [id(2)], variant);
    await access(path);
  }
});

test("live or unconfirmed processes, pending updates and a busy writer prevent cleanup", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await cleanupLegacyGea({ ...f, apply: true, isInUse: async () => true })).skipped,
    "legacy-in-use-or-unknown",
  );
  await writeFile(
    join(f.plugins, "update-state.json"),
    JSON.stringify({ phase: "pending", pending: id(1) }),
  );
  assert.deepEqual((await cleanupLegacyGea({ ...f, apply: true })).removed, [id(2)]);
  await writeFile(
    join(f.plugins, "prepare.lock"),
    JSON.stringify({ pid: process.pid, token: "other", purpose: "write" }),
  );
  assert.equal((await cleanupLegacyGea({ ...f, apply: true })).skipped, "store-busy");
  await access(join(f.versions, id(1)));
});

test("symlinked legacy roots, shared current homes and unknown directories are never swept", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await cleanupLegacyGea({ ...f, home: join(f.data, "data/home"), apply: true })).skipped,
    "protected-data-root",
  );
  const outside = f.data + "-actual";
  await rename(f.data, outside);
  await symlink(outside, f.data, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await cleanupLegacyGea({ ...f, apply: true })).skipped, "unsafe-legacy-root");
});

test("a current home linked into the old directory and a linked report destination both prevent deletion", async (t) => {
  const f = await fixture(t);
  await symlink(
    join(f.data, "data/home"),
    f.home,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal((await cleanupLegacyGea({ ...f, apply: true })).skipped, "protected-data-root");
  await rm(f.home);
  await mkdir(join(f.home, "profiles/desktop"), { recursive: true });
  await symlink(
    join(f.data, "data/home"),
    join(f.home, "profiles/desktop/gea"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal((await cleanupLegacyGea({ ...f, apply: true })).skipped, "unsafe-report-root");
  assert.equal((await readdir(f.versions)).length, 4);
});
