import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareSourcePlugins, readSourceCombination } from "../scripts/source-profile.mjs";
import { sourceAssemblyFixture, names } from "./fixtures/source-assembly.mjs";

test(
  "the single assembler verifies reused published assets without source locks, while source-lock changes remain rejected",
  { timeout: 180000 },
  async (t) => {
    const { root, sources } = await sourceAssemblyFixture(t);
    const core = resolve("../../official-latest-standard"),
      runtime = join(root, "own-runtime");
    await mkdir(runtime);
    const composition = await prepareSourcePlugins(core, runtime, undefined, {
      sources,
    });
    assert.deepEqual(Object.keys(composition.dependencies), names);
    assert.deepEqual(new Set(composition.bundles), new Set(names));
    assert.equal(composition.patches.length, 1);
    assert.deepEqual(await readSourceCombination(runtime, composition.id, core), composition);
    const directory = join(runtime, "source-combinations", composition.id);
    await assert.rejects(access(join(directory, "presets.patch.yml")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(runtime, "home")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(composition.profileDefaults, "utf8")), [
      {
        id: "agent-default-model",
        config: { provider: "fixture", model: "fixture" },
      },
    ]);
    const patch = JSON.parse(await readFile(composition.patches[0], "utf8"));
    assert.equal(
      patch.find((row) => row.id === "agent-preset-registry").config.default,
      "auto-negotiation",
    );
    assert.ok(!JSON.stringify(composition).includes("dsh-plugin-hub"));
    assert.ok(!JSON.stringify(composition).includes("skill-reference"));
    const record = JSON.parse(await readFile(join(directory, "combination.json"), "utf8"));
    const originalLock = join(sources[3].source, "pnpm-lock.yaml");
    assert.ok(record.externalLockFiles.includes(originalLock));
    assert.equal(record.externalFiles[originalLock], record.locks[names[3]]["pnpm-lock.yaml"]);
    assert.match(record.externalFiles[originalLock], /^[a-f0-9]{64}$/);
    await writeFile(originalLock, "changed source dependency input\n");
    await assert.rejects(
      readSourceCombination(runtime, composition.id, core),
      /SOURCE_DEPENDENCY_DIGEST_MISMATCH/,
    );
  },
);
