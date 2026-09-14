import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareNativePreset,
  deploymentPatch,
} from "../scripts/deployment.mjs";

test("native standard stays byte-identical and discoverable as a real preset directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gea-presets-"));
  try {
    const source = join(dir, "source");
    const native = join(
      source,
      "packages/preset/agent-presets/presets/standard",
    );
    await mkdir(native, { recursive: true });
    await writeFile(
      join(native, "agent.cordis.yml"),
      "original standard composition\n",
    );
    await writeFile(join(native, "preset.yml"), "name: 标准模式\n");
    await prepareNativePreset(join(dir, "runtime"), native);
    await prepareNativePreset(join(dir, "runtime"), native);
    const entries = await readdir(join(dir, "runtime/native-presets"), {
      withFileTypes: true,
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].isDirectory(), true);
    assert.equal(
      await readFile(
        join(dir, "runtime/native-presets/standard/agent.cordis.yml"),
        "utf8",
      ),
      "original standard composition\n",
    );
    const config = deploymentPatch(
      { analysis: { mode: "receipt" } },
      dir,
      join(dir, "runtime"),
    ).find((r) => r.id === "agent-presets").config;
    assert.equal(config.default, "standard");
    assert.equal(config.includeShippedRoot, false);
    assert.equal(config.roots.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
