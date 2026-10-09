import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { prepareSourcePlugins, readSourceCombination } from "../scripts/source-profile.mjs";
import {
  DEFAULT_PRESET_ID,
  DEFAULT_PRESET_NAME,
  prepareNativePreset,
  deploymentPatch,
} from "../scripts/deployment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("the current source reader binds the official standard patch and selects the standard registry default", async (t) => {
  if (!process.env.GEA_TEST_SOURCE_INPUTS) throw Error("EXPLICIT_SOURCE_INPUTS_REQUIRED");
  const runtime = await mkdtemp(join(tmpdir(), "gea-current-preset-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const core = resolve(root, "../../official-latest-standard");
  const sources = JSON.parse(await readFile(process.env.GEA_TEST_SOURCE_INPUTS, "utf8"));
  const prepared = await prepareSourcePlugins(core, runtime, undefined, { sources });
  const current = await readSourceCombination(runtime, prepared.id, core);
  const record = JSON.parse(
    await readFile(join(runtime, "source-combinations", current.id, "combination.json"), "utf8"),
  );
  const standard = await realpath(join(core, "packages/bundle/web-app/presets/standard.patch.yml"));
  assert.equal(
    record.externalFiles[standard],
    createHash("sha256")
      .update(await readFile(standard))
      .digest("hex"),
  );
  const patch = JSON.parse(await readFile(current.patches[0], "utf8"));
  assert.equal(patch.find((row) => row.id === "agent-preset-registry").config.default, "standard");
  assert.equal(
    patch.some((row) => row.id === "agent-presets"),
    false,
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
    assert.equal(
      await readFile(join(runtime, "native-presets", DEFAULT_PRESET_ID, "preset.yml"), "utf8"),
      `name: ${DEFAULT_PRESET_NAME}\n`,
    );
    await prepareNativePreset(runtime, next);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 0.0.13 及更早的桌面把标准预设复制成真实目录（不是软链）。升级到软链布局后这里曾经直接抛
// EEXIST 让工作台起不来；内容一致的副本必须原样沿用。
test("旧版复制布局留下的组合副本直接沿用，不再 EEXIST 崩启动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gea-presets-copy-"));
  try {
    const source = join(dir, "version-a");
    await mkdir(source, { recursive: true });
    const composition = "composition version-a\n";
    await writeFile(join(source, "agent.cordis.yml"), composition);
    await writeFile(join(source, "preset.yml"), "name: 标准模式\n");
    const runtime = join(dir, "runtime");
    const copied = join(runtime, "native-presets", DEFAULT_PRESET_ID);
    await mkdir(copied, { recursive: true });
    await writeFile(join(copied, "agent.cordis.yml"), composition);
    await prepareNativePreset(runtime, source);
    assert.equal(await readFile(join(copied, "agent.cordis.yml"), "utf8"), composition);
    assert.equal((await lstat(join(copied, "agent.cordis.yml"))).isSymbolicLink(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 副本落后于当前 DSH 包时按原始内容刷新，不能继续用上一版组合。
test("旧副本落后于当前组合时按 DSH 原始内容刷新", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gea-presets-refresh-"));
  try {
    const source = join(dir, "version-b");
    await mkdir(source, { recursive: true });
    const composition = "composition version-b\n";
    await writeFile(join(source, "agent.cordis.yml"), composition);
    await writeFile(join(source, "preset.yml"), "name: 标准模式\n");
    const runtime = join(dir, "runtime");
    const stale = join(runtime, "native-presets", DEFAULT_PRESET_ID);
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "agent.cordis.yml"), "composition version-a\n");
    await prepareNativePreset(runtime, source);
    assert.equal(await readFile(join(stale, "agent.cordis.yml"), "utf8"), composition);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Windows 普通账户没有 SeCreateSymbolicLinkPrivilege 时 symlink 抛 EPERM（现场日志里的
// `EPERM: operation not permitted, symlink`）；必须退回内容相同的副本，不能把工作台打死。
test("没有文件软链权限时退回写副本，并且可以重复执行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gea-presets-eperm-"));
  try {
    const source = join(dir, "version-a");
    await mkdir(source, { recursive: true });
    const composition = "composition version-a\n";
    await writeFile(join(source, "agent.cordis.yml"), composition);
    await writeFile(join(source, "preset.yml"), "name: 标准模式\n");
    const runtime = join(dir, "runtime");
    const denied = async () => {
      const error = new Error("EPERM: operation not permitted, symlink");
      error.code = "EPERM";
      throw error;
    };
    await prepareNativePreset(runtime, source, { createLink: denied });
    const link = join(runtime, "native-presets", DEFAULT_PRESET_ID, "agent.cordis.yml");
    assert.equal(await readFile(link, "utf8"), composition);
    assert.equal((await lstat(link)).isSymbolicLink(), false);
    // 第二次启动看到的是上一轮留下的真实文件，不能再抛 EEXIST。
    await prepareNativePreset(runtime, source, { createLink: denied });
    assert.equal(await readFile(link, "utf8"), composition);
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
