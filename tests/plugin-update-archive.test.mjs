import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { c } from "tar";
import { archiveMatches } from "../src/host/plugin-update-archive.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    installed = join(root, "installed");
  await mkdir(join(source, "package"), { recursive: true });
  await mkdir(installed);
  for (const name of ["index.js", "中文 模板.md"]) {
    await writeFile(join(source, "package", name), "original " + name);
    await writeFile(join(installed, name), "original " + name);
  }
  const archive = join(root, "package.tgz");
  await c({ cwd: source, file: archive, gzip: true }, ["package"]);
  return { root, source, installed, archive };
}

test("checks every file using archive UTF-8 names and rejects changed bytes", async (t) => {
  const f = await fixture(t);
  assert.equal(await archiveMatches(f.archive, f.installed), true);
  await writeFile(join(f.installed, "中文 模板.md"), "changed");
  assert.equal(await archiveMatches(f.archive, f.installed), false);
});

test("rejects installed symlinks and honors cancellation", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    archiveMatches(f.archive, f.installed, controller.signal),
    { name: "AbortError" },
  );
  await rm(join(f.installed, "index.js"));
  await symlink(
    join(f.source, "package/index.js"),
    join(f.installed, "index.js"),
  );
  assert.equal(await archiveMatches(f.archive, f.installed), false);
});

test("rejects links in the archive and packages with no files", async (t) => {
  const f = await fixture(t);
  await symlink("index.js", join(f.source, "package/link.js"));
  await c({ cwd: f.source, file: f.archive, gzip: true }, ["package"]);
  assert.equal(await archiveMatches(f.archive, f.installed), false);
  const empty = join(f.root, "empty");
  await mkdir(join(empty, "package"), { recursive: true });
  await c({ cwd: empty, file: f.archive, gzip: true }, ["package"]);
  assert.equal(await archiveMatches(f.archive, f.installed), false);
});
