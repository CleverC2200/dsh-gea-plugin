import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { applySourceUpdate, readSourceUpdateBaseline } from "../scripts/source-update.mjs";
import { sourceUpdateFixture, core, gea, workbench, manage } from "./fixtures/source-updates.mjs";

test("one prepared candidate serves separate updates and rejects corruption without changing the active profile", async (t) => {
  const f = await sourceUpdateFixture(t);
  const candidate = await f.snapshot({
    [gea]: { version: "1.1.0" },
    [workbench]: { version: "1.1.0" },
  });
  const first = await f.proposal(candidate, [gea]);
  const second = await f.proposal(candidate, [workbench]);
  const directory = join(f.runtime, "source-combinations", candidate);
  const manifest = await fs.readFile(join(directory, "combination.json"));
  const resource = join(directory, "node_modules", gea, "lib/host.js");
  const bytes = await fs.readFile(resource);
  assert.equal((await applySourceUpdate(f.runtime, first, { core })).phase, "succeeded");
  const partial = await readSourceUpdateBaseline(f.runtime, core);
  assert.equal(partial.components[gea].version, "1.1.0");
  assert.equal(partial.components[workbench].version, "1.0.0");
  await fs.writeFile(resource, "corrupted prepared candidate");
  const rejected = await applySourceUpdate(f.runtime, second, { core });
  assert.notEqual(rejected.phase, "succeeded");
  assert.equal(rejected.failed[0].error, "SOURCE_COMBINATION_DIGEST_MISMATCH");
  assert.deepEqual(await readSourceUpdateBaseline(f.runtime, core), partial);
  await fs.writeFile(resource, bytes);
  assert.equal((await applySourceUpdate(f.runtime, second, { core })).phase, "succeeded");
  const current = await readSourceUpdateBaseline(f.runtime, core);
  assert.equal(current.components[gea].version, "1.1.0");
  assert.equal(current.components[workbench].version, "1.1.0");
  assert.deepEqual(current.components[manage], f.baseline.components[manage]);
  assert.deepEqual(await fs.readFile(join(directory, "combination.json")), manifest);
});
