import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = await build({
  entryPoints: ["src/host/business.ts"],
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const module = { exports: {} };
new Function("require", "module", "exports", output.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);

async function fixture(t) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-draft-status-"));
  const business = new module.exports.Business({
    geaBaseUrl: "https://localhost",
    analysisAgentCode: "sales_forecast",
    runtimeDir,
    requestTimeoutMs: 2000,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://localhost",
    auth: { token: "fixture-token", tenantId: "1", id: "user", name: "Test", username: "test" },
  });
  t.after(async () => {
    business.dispose();
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const detail = {
    currentVersion: {
      id: "v",
      planId: "p",
      status: 1,
      effective: true,
      planTypeCode: "Y",
      orderType: "Z",
    },
    skus: [{ id: "s", versionId: "v", skuCode: "1001", qty: "30", price: "2", amt: "60" }],
    versions: [],
    logs: [],
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(new URL(url).pathname, "/sales-plan/plans/p");
    return Response.json({ success: true, result: detail });
  });
  const signal = new AbortController().signal;
  const read = () => business.salesPlanDraft({ planId: "p", versionId: "v" }, signal);
  const save = (sourceSnapshot, status, role, adjustQty) =>
    business.salesPlanDraft(
      {
        planId: "p",
        versionId: "v",
        approvalRole: role,
        draft: {
          planId: "p",
          versionId: "v",
          status,
          role,
          sourceSnapshot,
          adjustments: [{ skuCode: "1001", adjustQty }],
          remark: "",
        },
      },
      signal,
    );
  const source = await read();
  const saved = await save(source.sourceSnapshot, 1, "region", "2");
  return { runtimeDir, detail, read, save, saved };
}

test("a previous approval status has no applicable draft and reading it preserves saved content", async (t) => {
  const f = await fixture(t);
  f.detail.currentVersion.status = 2;
  f.detail.skus[0].regionConfirmedQty = "32";
  const province = await f.read();
  assert.equal(province.draft, null);
  assert.equal(province.stale, undefined);
  assert.equal(typeof province.sourceSnapshot, "string");

  f.detail.currentVersion.status = 1;
  delete f.detail.skus[0].regionConfirmedQty;
  assert.deepEqual((await f.read()).draft, f.saved.draft);

  f.detail.currentVersion.status = 2;
  f.detail.skus[0].regionConfirmedQty = "32";
  const next = await f.read();
  const saved = await f.save(next.sourceSnapshot, 2, "province", "3");
  assert.deepEqual((await f.read()).draft, saved.draft);
});

test("source changes at the same approval status keep the stale draft protection", async (t) => {
  const f = await fixture(t);
  f.detail.skus[0].qty = "31";
  const changed = await f.read();
  assert.equal(changed.draft, null);
  assert.equal(changed.stale, true);
  await assert.rejects(f.save(f.saved.draft.sourceSnapshot, 1, "region", "8"), /STALE_DRAFT/);
  f.detail.skus[0].qty = "30";
  assert.deepEqual((await f.read()).draft, f.saved.draft);
});

test("malformed persisted content is not treated as a harmless previous-status draft", async (t) => {
  const f = await fixture(t);
  const directory = join(f.runtimeDir, "approval-drafts");
  const [file] = await readdir(directory);
  await writeFile(
    join(directory, file),
    JSON.stringify({ ...f.saved, draft: { ...f.saved.draft, adjustments: "invalid" } }),
  );
  f.detail.currentVersion.status = 2;
  const changed = await f.read();
  assert.equal(changed.draft, null);
  assert.equal(changed.stale, true);
});
