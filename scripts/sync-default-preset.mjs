/** 用当前锁定的 DSH 标准预设刷新 default-presets/（只改显示名，组合字节不变）。 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PRESET_ID, DEFAULT_PRESET_NAME } from "./deployment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const source = resolve(
  dirname(require.resolve("@deepseek-ai/dsh-agent-presets/package.json")),
  "presets/standard",
);
const target = resolve(root, "default-presets", DEFAULT_PRESET_ID);
await mkdir(target, { recursive: true });
await copyFile(resolve(source, "agent.cordis.yml"), resolve(target, "agent.cordis.yml"));
const preset = await readFile(resolve(source, "preset.yml"), "utf8");
await writeFile(
  resolve(target, "preset.yml"),
  preset.replace(/^name:.*$/m, `name: ${DEFAULT_PRESET_NAME}`),
  { mode: 0o644 },
);
console.log(JSON.stringify({ source, target, name: DEFAULT_PRESET_NAME }));
