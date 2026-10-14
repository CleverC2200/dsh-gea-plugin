import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium } from "@playwright/test";
import { resolveSourceInputs } from "./source-profile.mjs";

test(
  "Workbench tarball installs without GEA and exposes the picker and shared bridge",
  { timeout: 180000 },
  async (t) => {
    const root = resolve(import.meta.dirname, "..");
    const entries = await resolveSourceInputs(
      JSON.parse(await readFile(process.env.GEA_TEST_SOURCE_INPUTS, "utf8")),
      { requireEntries: true },
    );
    const workbench = entries.find((entry) => entry.repo === "dsh-agent-workbench");
    const directory = await mkdtemp(join(tmpdir(), "dsh-page-package-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const [raw] = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], {
        cwd: workbench.assetRoot,
        encoding: "utf8",
      }),
    );
    const versions = join(directory, "versions.json");
    await writeFile(
      versions,
      JSON.stringify({ [workbench.manifest.name]: workbench.manifest.version }),
    );
    const curated = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "scripts/package-companion.mjs",
          "--input",
          join(directory, raw.filename),
          "--versions",
          versions,
          "--destination",
          join(directory, "curated"),
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "page-package-consumer",
        private: true,
        dependencies: { [workbench.manifest.name]: "file:" + curated.artifact },
      }),
    );
    await writeFile(
      join(directory, "pnpm-workspace.yaml"),
      "packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    );
    execFileSync(
      process.execPath,
      [
        process.env.GEA_PACKAGE_PNPM,
        "install",
        "--ignore-scripts",
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: directory, timeout: 120000, stdio: "pipe" },
    );
    const installed = join(directory, "node_modules", workbench.manifest.name);
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.name, "@cleverc2200/dsh-agent-workbench");
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.scripts, undefined);
    await assert.rejects(access(join(directory, "node_modules/@cleverc2200/gea-dsh-prototype")), {
      code: "ENOENT",
    });
    const picker = await readFile(
      join(installed, manifest.exports["./page-interaction/picker"].default),
      "utf8",
    );
    const bridge = await readFile(
      join(installed, manifest.exports["./page-interaction/bridge"].default),
      "utf8",
    );
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const observed = await page.evaluate(
      async ({ picker, bridge }) => {
        const module = await import("data:text/javascript;base64," + picker);
        const dispose = module.mountPicker();
        const mounted = Boolean(document.querySelector(".dspi"));
        dispose();
        const { startPageBridgeClient } = await import("data:text/javascript;base64," + bridge);
        const calls = [];
        let acknowledge;
        const acknowledged = new Promise((resolve) => {
          acknowledge = resolve;
        });
        const stop = startPageBridgeClient({
          endpoint: "owned-page",
          sessionId: "packaged-page",
          initialDelayMs: 0,
          pollMs: 0,
          apply: async (args, meta) => {
            calls.push({ args, meta });
            return { applied: true };
          },
          request: async (_endpoint, payload) => {
            if (payload.toolMessages.length) acknowledge(payload.toolMessages[0]);
            return {
              events: calls.length
                ? []
                : [
                    {
                      type: "TOOL_CALL_START",
                      toolCallId: "packaged-call",
                      toolCallName: "packaged_action",
                    },
                    { type: "TOOL_CALL_ARGS", toolCallId: "packaged-call", delta: '{"value":42}' },
                    { type: "TOOL_CALL_END", toolCallId: "packaged-call" },
                  ],
            };
          },
        });
        const receipt = await acknowledged;
        stop();
        return {
          mounted,
          cleared: !document.querySelector(".dspi"),
          describe: typeof module.describeElement,
          calls,
          receipt,
        };
      },
      {
        picker: Buffer.from(picker).toString("base64"),
        bridge: Buffer.from(bridge).toString("base64"),
      },
    );
    assert.equal(observed.mounted, true);
    assert.equal(observed.cleared, true);
    assert.equal(observed.describe, "function");
    assert.deepEqual(observed.calls, [
      {
        args: { value: 42 },
        meta: { toolCallId: "packaged-call", toolCallName: "packaged_action" },
      },
    ]);
    assert.equal(observed.receipt.tool_call_id, "packaged-call");
    assert.deepEqual(JSON.parse(observed.receipt.content), {
      toolCallId: "packaged-call",
      applied: true,
    });
  },
);
