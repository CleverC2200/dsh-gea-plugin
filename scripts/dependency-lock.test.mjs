import YAML from "yaml";
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));

// Development pnpm inputs and the generated ordinary production shrinkwrap are different graphs.
// Production lock/manifest checks live in package-smoke.test.mjs at the actual artifact seam.

test("GEA and the pinned workbench resolve the same Cordis instance", () => {
  const fromRoot = createRequire(join(root, "package.json"));
  const fromWorkbench = createRequire(fromRoot.resolve("@cleverc2200/dsh-agent-workbench"));
  assert.equal(
    fromRoot.resolve("@deepseek-ai/cordis"),
    fromWorkbench.resolve("@deepseek-ai/cordis"),
  );
});

test(
  "stale dependencies fail without implicit installation or running the script",
  { timeout: 30000 },
  async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), "gea-explicit-install-"));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "gea-explicit-install-test",
        private: true,
        packageManager: manifest.packageManager,
        dependencies: { yaml: "2.9.0" },
        scripts: { probe: "node -e \"console.log('UNEXPECTED_SCRIPT_RUN')\"" },
      }),
    );
    const workspace = YAML.parse(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"));
    await writeFile(
      join(fixture, "pnpm-workspace.yaml"),
      YAML.stringify({ verifyDepsBeforeRun: workspace.verifyDepsBeforeRun }),
    );
    // pnpm run 对子脚本注入 false，避免重复检查；独立空目录应使用自己的配置。
    const fixtureEnv = { ...process.env };
    delete fixtureEnv.pnpm_config_verify_deps_before_run;
    const child = spawn(
      process.platform === "win32" ? "corepack.cmd" : "corepack",
      ["pnpm", "run", "probe"],
      {
        cwd: fixture,
        env: fixtureEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        timeout: 25000,
      },
    );
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.notEqual(code, 0, output);
    assert.match(output, /ERR_PNPM_VERIFY_DEPS_BEFORE_RUN/);
    assert.doesNotMatch(output, /UNEXPECTED_SCRIPT_RUN/);
    await assert.rejects(access(join(fixture, "node_modules")));
    await assert.rejects(access(join(fixture, "pnpm-lock.yaml")));
  },
);
