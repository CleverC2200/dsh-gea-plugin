import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
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

// 切换已准备版本时，native-presets 里的组合软链仍指向上一版目录；必须替换而不是 EEXIST 崩掉，
// 否则新组合起不来、桌面壳会判定启动失败并回滚（现场日志里的 UPDATE_ROLLED_BACK）。
test("切换组合时替换上一版的 preset 软链，并且可以重复执行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gea-presets-switch-"));
  try {
    const version = async (name) => {
      const path = join(dir, name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "agent.cordis.yml"), `composition ${name}\n`);
      await writeFile(join(path, "preset.yml"), "name: 标准模式\n");
      return path;
    };
    const previous = await version("version-a");
    const next = await version("version-b");
    const runtime = join(dir, "runtime");
    await prepareNativePreset(runtime, previous);
    await prepareNativePreset(runtime, next);
    const link = join(runtime, "native-presets", DEFAULT_PRESET_ID, "agent.cordis.yml");
    assert.equal(await realpath(link), await realpath(join(next, "agent.cordis.yml")));
    assert.equal(await readFile(link, "utf8"), "composition version-b\n");
    await prepareNativePreset(runtime, next);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
