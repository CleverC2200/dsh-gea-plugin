import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const cases = [
  [
    "branch-stock-agent.test.mjs",
    "branch Agent preserves empty, missing, failed and revoked result meanings",
  ],
  [
    "branch-stock-ability-web.test.mjs",
    "branch stock filter, quote and two authorized Agents keep separate Sessions",
  ],
  [
    "branch-stock-upgrade-web.test.mjs",
    "supported stock combinations update and restore on the same durable profile",
  ],
  [
    "branch-stock-web.test.mjs",
    "branch stock migration preserves rows and runs authorized page and Agent reads",
  ],
  [
    "source-update-web.test.mjs",
    "real profiles load merged component updates and keep history through restart and guarded recovery",
  ],
  [
    "authorized-cube-loop.test.mjs",
    "native typed query exposes its schema, splits requests and refuses a revoked resource next turn",
  ],
  [
    "dealer-prompt.test.mjs",
    "dealer inventory uses the maintained skill in the real assembled prompt, without altering the sales-plan context",
  ],
  [
    "detail-summary-web.test.mjs",
    "Dashboard shows current SKU totals while monthly baseline and categories retain their own basis",
  ],
  [
    "genui-source-web.test.mjs",
    "source GenUI renders a persisted model reply and restores local input after refresh",
  ],
  [
    "lifecycle.test.mjs",
    "model authentication, rate limit, truncated stream, cancellation and explicit retry retain separate attempts",
  ],
  [
    "mcp-evidence-loop.test.mjs",
    "native model loop retains ordinary MCP evidence after later failure and resets next turn",
  ],
  [
    "model.test.mjs",
    "configured model receives the exact logged snapshot with the GEA read and skill tools and no duplicate title calls",
  ],
  ["model.test.mjs", "显式打开 agentSqlRead 时，受管只读 SQL 工具才回到工具清单"],
  [
    "page-interaction-web.test.mjs",
    "React table selection enters the native composer and can drive the existing page action",
  ],
  [
    "page-interaction-web.test.mjs",
    "opaque HTML frame quotes local content under the existing CSP without triggering its button",
  ],
  [
    "safety-stock-prompt.test.mjs",
    "safety stock uses the maintained skill in the real assembled prompt, without altering the sales-plan context",
  ],
  [
    "sales-result-runtime.test.mjs",
    "native result route, atomic skill load and structured evidence reuse retain authorization",
  ],
  [
    "shared-theme-source-web.test.mjs",
    "shared theme follows settings and survives stylesheet reorder and refresh",
  ],
  [
    "split-declarations-web.test.mjs",
    "两份临时分离声明在真实工作台显示，Agent 管理装载能力，调用保持受控",
  ],
  [
    "v16-web.test.mjs",
    "V1.6 Web: compact header, stable progress, inline SKU and approval editing",
  ],
];
async function probe(t, file, name, mode, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gea-config-probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout } = await run(
    process.execPath,
    [
      fileURLToPath(new URL("./fixtures/profile-configuration-probe.mjs", import.meta.url)),
      fileURLToPath(new URL(file, import.meta.url)),
      name,
      directory,
      ...(mode ? [mode] : []),
    ],
    { timeout: 15000, env: { ...process.env, ...env } },
  );
  return JSON.parse(stdout);
}
for (const [file, name] of cases)
  test(`${file} admits its declared fake key in parent and child and restores the parent`, async (t) => {
    const result = await probe(t, file, name);
    assert.equal(result.expectedBoundary, true, result.error);
    assert.equal(result.declaredFakeKey, true);
    assert.equal(result.parentAdmitted, true);
    assert.equal(result.childAdmitted, true);
    assert.equal(result.parentRestored, true);
    assert.equal(new URL(result.config.analysis.baseUrl).hostname, "127.0.0.1");
    assert.equal(result.hostStarts, 0);
    assert.equal(result.browserStarts, 0);
  });
test("branch data fixture closes its owned browser when navigation fails before the UI try block", async (t) => {
  const result = await probe(
    t,
    "branch-stock-web.test.mjs",
    "branch page distinguishes denied data",
    "early-ui-failure",
  );
  assert.equal(result.expectedBoundary, true, result.error);
  assert.equal(result.browserClosed, 1);
  assert.equal(result.hostStarts, 0);
  assert.equal(result.browserStarts, 0);
});
test("model fixture restores an existing parent value after admitting its own fake key", async (t) => {
  const [file, name] = cases[0];
  const result = await probe(t, file, name, "existing-parent");
  assert.equal(result.expectedBoundary, true, result.error);
  assert.equal(result.parentAdmitted, true);
  assert.equal(result.childAdmitted, true);
  assert.equal(result.parentRestored, true);
});
test("private profile credentials admit without replacing a different parent process key", async (t) => {
  const result = await probe(
    t,
    "sales-result-runtime.test.mjs",
    "native result route, atomic skill load and structured evidence reuse retain authorization",
    "existing-parent",
  );
  assert.equal(result.expectedBoundary, true, result.error);
  assert.equal(result.declaredFakeKey, true);
  assert.equal(result.parentAdmitted, true);
  assert.equal(result.childAdmitted, true);
  assert.equal(result.parentRestored, true);
  assert.equal(result.hostStarts, 0);
  assert.equal(result.browserStarts, 0);
});
test("configuration probe honors the Source fixture signal before deployment admission", async (t) => {
  const [file, name] = cases[0];
  const result = await probe(t, file, name, "credentials", { GEA_TEST_SOURCE_CORE: "1" });
  assert.equal(result.expectedBoundary, true, result.error);
  assert.equal(result.parentAdmitted, true);
  assert.equal(result.childAdmitted, true);
  assert.equal(result.parentRestored, true);
  assert.equal(result.hostStarts, 0);
  assert.equal(result.browserStarts, 0);
});
test("deployment refuses a missing effective parent key despite child-only fixture options", async (t) => {
  const [file, name] = cases[0];
  const result = await probe(t, file, name, "missing-parent");
  assert.equal(result.expectedBoundary, true, result.error);
  assert.equal(result.missingRejected, true);
  assert.equal(result.parentRestored, true);
});
