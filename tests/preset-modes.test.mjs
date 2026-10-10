import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareSourcePlugins, readSourceCombination } from "../scripts/source-profile.mjs";
import { sourceAssemblyFixture } from "./fixtures/source-assembly.mjs";

test(
  "the source launcher defaults new tasks to orchestration without replacing saved preset preferences",
  { timeout: 180000 },
  async (t) => {
    const { root, sources } = await sourceAssemblyFixture(t);
    const core = resolve("../../official-latest-standard");
    const runtime = join(root, "runtime");
    const profile = join(runtime, "home/profiles/plugin-split-validation");
    await mkdir(profile, { recursive: true });
    const saved =
      "- id: agent-preset-registry\n  config:\n    selectedDefault: minimal\n- id: user-preference\n  config:\n    unrelated: retained\n";
    const preference = join(profile, "cordis.patch.yml");
    await writeFile(preference, saved);
    const prepared = await prepareSourcePlugins(core, runtime, undefined, { sources });
    const composition = await readSourceCombination(runtime, prepared.id, core);
    const rows = JSON.parse(await readFile(composition.patches[0], "utf8"));
    assert.deepEqual(rows.find((row) => row.id === "agent-preset-registry").config, {
      default: "auto-negotiation",
    });
    assert.equal(await readFile(preference, "utf8"), saved);
    assert.ok(
      !rows.some((row) => row.id === "agent-presets"),
      "current composition must not reinstate the retired directory registry",
    );
    assert.deepEqual(
      JSON.parse(await readFile(composition.profileDefaults, "utf8")).map((row) => row.id),
      ["agent-default-model"],
    );
  },
);
