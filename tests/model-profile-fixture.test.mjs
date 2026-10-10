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
];
async function probe(t, file, name, mode) {
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
    { timeout: 15000 },
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
test("deployment still refuses a missing parent key despite child-only fixture options", async (t) => {
  const [file, name] = cases[0];
  const result = await probe(t, file, name, "missing-parent");
  assert.equal(result.expectedBoundary, true, result.error);
  assert.equal(result.missingRejected, true);
  assert.equal(result.parentRestored, true);
});
