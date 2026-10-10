import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readSupportedCore, supportedCores } from "../scripts/supported-cores.mjs";

// The CI matrix supplies its real registered checkout; no fixture replaces the fixed source identity.
test("isolated admission accepts the actual selected registered Core without changing the current pointer", async () => {
  const core = process.env.GEA_TEST_REGISTERED_CORE ?? resolve("../../official-latest-standard");
  const actualHead = execFileSync("git", ["-C", core, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const expected = supportedCores.find((entry) => entry.head === actualHead);
  assert.ok(expected);
  const pointer = new URL("../scripts/current-core.json", import.meta.url);
  const before = await readFile(pointer);
  const admitted = await readSupportedCore(core);
  assert.deepEqual(admitted, expected);
  assert.deepEqual(await readFile(pointer), before);
});

test("an unregistered clean Core with a registered version is rejected", async (t) => {
  const core = await mkdtemp(join(tmpdir(), "gea-unknown-core-"));
  t.after(() => rm(core, { recursive: true, force: true }));
  await mkdir(join(core, "apps/cli"), { recursive: true });
  await writeFile(
    join(core, "apps/cli/package.json"),
    JSON.stringify({ version: supportedCores[0].version }),
  );
  await writeFile(
    join(core, "package.json"),
    JSON.stringify({ packageManager: supportedCores[0].packageManager }),
  );
  const git = (...args) => execFileSync("git", ["-C", core, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-qm",
    "unknown source",
  );
  assert.equal(git("status", "--porcelain"), "");
  await assert.rejects(
    readSupportedCore(core),
    /FIXED_OFFICIAL_INPUT_REQUIRED: unregistered Core head\/version/,
  );
});
