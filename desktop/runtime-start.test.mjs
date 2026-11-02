import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("Desktop mounts installed personal memory as an ordinary optional bundle and preserves profile fields", async (t) => {
  const payload = await mkdtemp(join(tmpdir(), "gea-memory-runtime-"));
  t.after(() => rm(payload, { recursive: true, force: true }));
  const put = async (file, text) => {
    const path = join(payload, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
  };
  await put("start.mjs", await readFile(new URL("./runtime-start.mjs", import.meta.url), "utf8"));
  await put("onboarding.mjs", "export async function configureWelcomeNotice() {}\n");
  await put(
    "company-resources.mjs",
    "export const companySources=[]; export async function provisionCompanyResources() {}\n",
  );
  await put(
    "html-plugins.mjs",
    "export async function prepareHtmlPlugins() { return { roots: {} }; }\n",
  );
  await put(
    "core-runtime.mjs",
    "export async function openCoreRuntime() { throw Error('unexpected layered runtime'); }\n",
  );
  await put("gea.config.json", "{}");
  await put("node_modules/@cleverc2200/gea-dsh-prototype/package.json", '{"type":"module"}');
  await put(
    "node_modules/@cleverc2200/gea-dsh-prototype/scripts/deployment.mjs",
    "export async function readDeployment() { return {}; } export function deploymentPatch() { return []; } export async function prepareNativePreset() {}\n",
  );
  await put("node_modules/@deepseek-ai/dsh/lib/bin.js", "process.exitCode=0;\n");
  for (const [installed, enabled] of [
    [true, true],
    [true, false],
    [false, true],
  ]) {
    await put(
      "package.json",
      JSON.stringify({ dependencies: installed ? { "dsh-personal-memory": "0.1.0" } : {} }),
    );
    await put("optional-state.json", JSON.stringify({ "dsh-personal-memory": enabled }));
    await put(
      "data/home/profiles/full/package.json",
      JSON.stringify({ custom: "keep", dsh: { profile: { customProfile: "keep" } } }),
    );
    const env = {
      ...process.env,
      DSH_PLUGIN_GRAPH: payload,
      GEA_CONFIG: "gea.config.json",
      DSH_FULL_DATA_DIR: "data",
      DSH_OPTIONAL_STATE_PATH: join(payload, "optional-state.json"),
    };
    delete env.GEA_LAYERED_CORE;
    delete env.GEA_DESKTOP_DEV;
    const child = spawnSync(process.execPath, [join(payload, "start.mjs")], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const profile = JSON.parse(
      await readFile(join(payload, "data/home/profiles/full/package.json"), "utf8"),
    );
    assert.equal(profile.dsh.profile.bundles.includes("dsh-personal-memory"), installed && enabled);
    assert.equal(profile.custom, "keep");
    assert.equal(profile.dsh.profile.customProfile, "keep");
    assert.equal(profile.dsh.profile.bundles.includes("@cleverc2200/gea-dsh-prototype"), true);
  }
});
