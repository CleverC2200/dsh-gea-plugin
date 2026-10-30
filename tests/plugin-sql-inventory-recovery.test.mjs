import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts';export {createCapabilityRegistry} from './src/capability/registry.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { Business, createCapabilityRegistry } = module.exports;
function setup(t) {
  const business = new Business({ geaBaseUrl: "https://fixture-gea.test", requestTimeoutMs: 1000 });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://fixture-gea.test",
    auth: { token: "fixture", tenantId: "0", id: "U1", name: "Fixture", username: "fixture" },
  });
  business.setCapabilities(
    createCapabilityRegistry([
      {
        id: "inventory-fc",
        label: "FC",
        enabled: true,
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "FC" },
        data: { consumerCode: "branch-inventory", tables: [], rules: [] },
      },
    ]),
  );
  t.after(() => business.dispose());
  return business;
}
test("parallel inventory sections share one delegation; expiry renews without logging out", async (t) => {
  const b = setup(t);
  let sessions = 0,
    expire = false;
  const tokens = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/agent/session")) {
      sessions++;
      await new Promise(setImmediate);
      return Response.json({
        success: true,
        result: { accessDecision: { allowed: true }, delegationToken: "d" + sessions },
      });
    }
    tokens.push(init.headers["X-Delegation-Token"]);
    if (expire && init.headers["X-Delegation-Token"] === "d1")
      return Response.json(
        { success: false, errorCode: "AI_GATEWAY_SESSION_EXPIRED" },
        { status: 401 },
      );
    return Response.json({ success: true, result: { rows: [{ qty: 1 }] } });
  });
  const read = (n) =>
    b.pluginSql(
      {
        consumerCode: "branch-inventory",
        sql: "SELECT CAST(:gea_p1 AS INTEGER) AS qty",
        parameters: { gea_p1: n },
      },
      new AbortController().signal,
      true,
    );
  await Promise.all([1, 2, 3].map(read));
  assert.equal(sessions, 1);
  expire = true;
  await Promise.all([4, 5, 6].map(read));
  assert.equal(sessions, 2);
  assert.equal(b.status().authenticated, true);
});

test("an empty cached atomic page is re-read and successful inventory remains cached", async (t) => {
  const b = setup(t);
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/agent/session"))
      return Response.json({
        success: true,
        result: { accessDecision: { allowed: true }, delegationToken: "d1" },
      });
    reads++;
    return Response.json({
      success: true,
      result: {
        rows:
          reads === 1
            ? [{ page_scope_total: 0, page_row_present: null, sku: null }]
            : [{ page_scope_total: 1, page_row_present: 1, sku: "SKU1" }],
      },
    });
  });
  const read = () =>
    b.pluginSql(
      { consumerCode: "branch-inventory", sql: "SELECT qty FROM fixture", parameters: {} },
      new AbortController().signal,
      true,
    );
  assert.equal((await read()).rows[0].page_scope_total, 0);
  assert.equal((await read()).rows[0].sku, "SKU1");
  assert.equal((await read()).rows[0].sku, "SKU1");
  assert.equal(reads, 2);
});

test("cancelling one page does not cancel the shared delegation for another page", async (t) => {
  const b = setup(t);
  let finish, sessionSignal;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/agent/session")) {
      sessionSignal = init.signal;
      await new Promise((resolve) => (finish = resolve));
      return Response.json({
        success: true,
        result: { accessDecision: { allowed: true }, delegationToken: "d1" },
      });
    }
    return Response.json({ success: true, result: { rows: [{ qty: 1 }] } });
  });
  const first = new AbortController();
  const q = { consumerCode: "branch-inventory", sql: "SELECT qty FROM fixture", parameters: {} };
  const one = b.pluginSql(q, first.signal, true),
    two = b.pluginSql(q, new AbortController().signal, true);
  const cancelled = assert.rejects(one, { name: "AbortError" });
  await new Promise(setImmediate);
  first.abort();
  assert.equal(sessionSignal.aborted, false);
  finish();
  await cancelled;
  assert.equal((await two).rows[0].qty, 1);
});
