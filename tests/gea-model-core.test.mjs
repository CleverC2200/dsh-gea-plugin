import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

test(
  "GEA model contract through the shared real Core Session fixture",
  { timeout: 90000 },
  async (t) => {
    const root = resolve(import.meta.dirname, "..");
    const peerRequire = createRequire(resolve(root, "../dsh-agent-manage/package.json"));
    const manifest = peerRequire("vitest/package.json");
    const bin = resolve(dirname(peerRequire.resolve("vitest/package.json")), manifest.bin.vitest);
    const child = spawn(
      process.execPath,
      [bin, "run", "tests/fixtures/gea-model-core.mjs", "--config", "vitest.model-core.config.mjs"],
      {
        cwd: root,
        env: {
          ...process.env,
          DSH_GEA_CHECKOUT: root,
          DSH_WORKBENCH_CHECKOUT: resolve(root, "../dsh-agent-workbench"),
        },
        signal: t.signal,
        stdio: "inherit",
      },
    );
    const result = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
  },
);
