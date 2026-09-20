import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_NAME,
  prepareNativePreset,
  deploymentPatch,
} from "../scripts/deployment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const shippedStandard = resolve(
  dirname(require.resolve("@deepseek-ai/dsh-agent-presets/package.json")),
  "presets/standard",
);

test("默认预设随插件包分发：显示名自动协商，组合与 DSH 标准预设逐字节一致", async () => {
  const directory = join(root, "default-presets", DEFAULT_PRESET_ID);
  assert.match(
    await readFile(join(directory, "preset.yml"), "utf8"),
    new RegExp(`^name: ${DEFAULT_PRESET_NAME}$`, "m"),
  );
  assert.equal(
    await readFile(join(directory, "agent.cordis.yml"), "utf8"),
    await readFile(join(shippedStandard, "agent.cordis.yml"), "utf8"),
  );
});

test("开发/桌面两种布局都能发现默认预设，且清得掉旧的 standard 目录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gea-presets-"));
  try {
    const source = join(dir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "agent.cordis.yml"), "original standard composition\n");
    await writeFile(join(source, "preset.yml"), "name: 标准模式\n");
    const runtime = join(dir, "runtime");

    // 旧安装留下的 native-presets/standard（目录 与 指向源目录的软链两种形态）都会被清掉。
    await mkdir(join(runtime, "native-presets/standard"), { recursive: true });
    await writeFile(join(runtime, "native-presets/standard/preset.yml"), "name: 标准模式\n");
    await prepareNativePreset(runtime, source);
    assert.equal(
      (await readdir(join(runtime, "native-presets"))).includes("standard"),
      false,
      "旧目录应被清理",
    );
    await symlink(source, join(runtime, "native-presets/standard"), "dir");
    await prepareNativePreset(runtime, source);
    assert.equal(
      (await readdir(join(runtime, "native-presets"))).includes("standard"),
      false,
      "旧软链应被清理且不删源目录",
    );
    assert.equal(
      await readFile(join(source, "agent.cordis.yml"), "utf8"),
      "original standard composition\n",
    );

    // 发布补丁：默认指向 auto-negotiation；根目录按实际存在的目录登记。
    const patch = () =>
      deploymentPatch({ analysis: { mode: "receipt" } }, dir, runtime).find(
        (row) => row.id === "agent-presets",
      ).config;
    assert.equal(patch().default, DEFAULT_PRESET_ID);
    assert.equal(patch().includeShippedRoot, false);
    assert.deepEqual(
      patch().roots.map((entry) => entry.path),
      [join(runtime, "native-presets")],
    );
    await mkdir(join(dir, "default-presets", DEFAULT_PRESET_ID), { recursive: true });
    assert.deepEqual(
      patch().roots.map((entry) => entry.path),
      [join(runtime, "native-presets"), join(dir, "default-presets")],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
