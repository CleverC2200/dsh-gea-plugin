import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { compiledSource } from "./fixtures/compiled-source.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-compiled-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "admitted-manage"),
    dependencies = join(root, "fixed-dependencies"),
    parent = join(root, "owned-output");
  await mkdir(source);
  await mkdir(parent);
  await mkdir(join(dependencies, "fixed-peer"), { recursive: true });
  await writeFile(
    join(source, "entry.mjs"),
    "export { value } from 'fixed-peer';\nexport const origin = import.meta.url;\n",
  );
  await writeFile(
    join(dependencies, "fixed-peer/package.json"),
    '{"name":"fixed-peer","type":"module","exports":"./index.js"}',
  );
  await writeFile(
    join(dependencies, "fixed-peer/index.js"),
    "export const value = 'fixed dependency';\n",
  );
  const git = (...args) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-qm",
    "fixed source",
  );
  return { source, dependencies, parent, url: join(source, "entry.mjs"), git };
}

test("cold compiled fixture output resolves the declared dependencies without writing to its admitted peer", async (t) => {
  const input = await fixture(t);
  await t.test("fixture lifetime", async (child) => {
    const result = await compiledSource(child, {
      ...input,
      contents: "export * from './entry.mjs';",
    });
    assert.equal(result.value, "fixed dependency");
    assert.equal(result.origin, new URL("file://" + input.url).href);
    assert.equal(input.git("status", "--porcelain", "--untracked-files=all"), "");
    assert.equal((await readdir(input.parent)).length, 1);
  });
  assert.deepEqual(await readdir(input.parent), []);
});

test("failed source compilation also cleans fixture-owned output and leaves peer admission clean", async (t) => {
  const input = await fixture(t);
  await t.test("failed fixture lifetime", async (child) => {
    await assert.rejects(compiledSource(child, { ...input, contents: "export const = invalid;" }));
    assert.equal(input.git("status", "--porcelain", "--untracked-files=all"), "");
  });
  assert.deepEqual(await readdir(input.parent), []);
});
