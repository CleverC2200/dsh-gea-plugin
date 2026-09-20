import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareHtmlQuery,
  readHtmlQuery,
} from "../src/html-query.ts";
import { createHtmlSessions } from "../src/html-sessions.ts";
const session = "session-11111111-1111-1111-1111-111111111111";
test("active leases renew but idle expiry and wrong-plugin isolation remain enforced", () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const pages = createHtmlSessions();
  try {
    const lease = pages.open("inventory-aqkc", session, {}, {});
    now += 299000;
    pages.get(lease, "inventory-aqkc");
    now += 299000;
    assert.ok(pages.get(lease, "inventory-aqkc"));
    assert.throws(() => pages.get(lease, "inventory-other"), /WRONG_PLUGIN/);
    now += 300001;
    assert.throws(() => pages.get(lease), /PAGE_LEASE_EXPIRED/);
  } finally {
    pages.clear();
    Date.now = originalNow;
  }
});
test("a conversation without an open page reports it instead of a raw failure", async () => {
  const pages = createHtmlSessions();
  try {
    assert.equal(pages.has("inventory-aqkc", session), false);
    await assert.rejects(
      () => pages.invoke("inventory-aqkc", session, "context", {}, new AbortController().signal),
      /还没有打开业务页面/,
    );
    const lease = pages.open("inventory-aqkc", session, {}, {});
    assert.equal(pages.has("inventory-aqkc", session), true);
    assert.equal(pages.has("inventory-other", session), false);
    pages.close(lease);
    assert.equal(pages.has("inventory-aqkc", session), false);
  } finally {
    pages.clear();
  }
});
test("named and positional parameters are bound without inserting data in SQL", () => {
  const query = prepareHtmlQuery({
    sql: "SELECT * FROM example WHERE a=:value AND b=':ignored' AND c::text=:value",
    parameters: { value: "x';DELETE FROM example;--" },
  });
  assert.equal(query.values.length, 1);
  assert.match(query.sql, /a=\$1/);
  assert.match(query.sql, /c::text=\$1/);
  assert.equal(
    prepareHtmlQuery({ sql: "SELECT * FROM x WHERE a=$1", values: ["中文"] })
      .values[0],
    "中文",
  );
});
test("reject writes, multiple statements, unsafe functions and missing parameters", () => {
  for (const sql of [
    "DELETE FROM x",
    "WITH deleted AS (DELETE FROM x RETURNING *) SELECT * FROM deleted",
    "SELECT * INTO other FROM x",
    "SELECT pg_sleep(2)",
    "SELECT 1;SELECT 2",
  ])
    assert.throws(() => prepareHtmlQuery({ sql }));
  assert.throws(() => prepareHtmlQuery({ sql: "SELECT :a", parameters: {} }));
});
test("one explicit page requires one GEA request and delegation token stays in host request", async () => {
  const requests = [];
  const result = await readHtmlQuery(
    {
      sql: "SELECT sku FROM published_resource WHERE base=:base",
      parameters: { base: "长沙" },
      pageNo: 2,
      pageSize: 20,
    },
    {
      endpoint: "https://gea.test/ai/gateway/sql/execute",
      token: "private-token",
      signal: new AbortController().signal,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return Response.json({
          success: true,
          code: 200,
          result: { rows: [{ sku: "A" }], total: 21 },
        });
      },
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers["X-Delegation-Token"], "private-token");
  assert.match(JSON.parse(requests[0].init.body).sql, /OFFSET/);
  assert.deepEqual(result, {
    rows: [{ sku: "A" }],
    records: [{ sku: "A" }],
    total: 21,
  });
  assert.ok(!JSON.stringify(result).includes("private-token"));
});
test("full pagination preserves order and checks final total", async () => {
  let calls = 0;
  const out = await readHtmlQuery(
    { sql: "SELECT sku FROM published_resource ORDER BY sku" },
    {
      endpoint: "https://gea.test",
      token: "secret",
      signal: new AbortController().signal,
      fetch: async (_url, init) => {
        const request = JSON.parse(init.body),
          offset = request.parameters.fc_page_offset;
        calls++;
        return Response.json({
          success: true,
          code: 200,
          result: {
            rows: Array.from(
              { length: Math.min(200, 401 - offset) },
              (_, i) => ({ sku: i + offset }),
            ),
            ...(request.includeTotal ? { total: 401 } : {}),
          },
        });
      },
    },
  );
  assert.equal(calls, 3);
  assert.equal(out.rows.length, 401);
  assert.deepEqual(
    out.rows.map((r) => r.sku),
    Array.from({ length: 401 }, (_, i) => i),
  );
});
test("page capabilities cannot cross plugins/conversations; logout rejects queued work", async () => {
  const pages = createHtmlSessions(),
    lease = pages.open("inventory-fc", session, {}, {});
  assert.throws(() => pages.get(lease, "inventory-dealer"));
  await assert.rejects(
    pages.invoke(
      "inventory-fc",
      "session-22222222-2222-2222-2222-222222222222",
      "context",
      {},
      new AbortController().signal,
    ),
  );
  pages.get(lease).actions = [{ name: "refresh" }];
  const pending = pages.invoke(
    "inventory-fc",
    session,
    "refresh",
    {},
    new AbortController().signal,
  );
  pages.clear();
  await assert.rejects(pending, /关闭|登录/);
  assert.throws(() => pages.get(lease));
});
test("registered page action returns through correlated reply; cancellation clears queue", async () => {
  const pages = createHtmlSessions(),
    lease = pages.open("inventory-fc", session, {}, {});
  pages.get(lease).actions = [{ name: "filter" }];
  const response = pages.invoke(
      "inventory-fc",
      session,
      "filter",
      { warehouseId: "A" },
      new AbortController().signal,
    ),
    event = pages.get(lease).queue[0];
  pages.reply(lease, { id: event.id, result: { status: "filtered" } });
  assert.deepEqual(await response, { status: "filtered" });
  const abort = new AbortController();
  const cancelled = pages.invoke(
    "inventory-fc",
    session,
    "filter",
    {},
    abort.signal,
  );
  abort.abort();
  await assert.rejects(cancelled, /CANCELLED/);
  assert.equal(pages.get(lease).queue.length, 0);
  pages.clear();
});

test("GEA denial never becomes an empty successful snapshot", async () => {
  await assert.rejects(
    readHtmlQuery(
      { sql: "SELECT sku FROM published_resource" },
      {
        endpoint: "https://gea.test",
        token: "secret",
        signal: new AbortController().signal,
        fetch: async () =>
          Response.json({ success: false, code: 403 }, { status: 403 }),
      },
    ),
    /权限/,
  );
});
test("identity cancellation rejects a late GEA response", async () => {
  const controller = new AbortController();
  await assert.rejects(
    readHtmlQuery(
      { sql: "SELECT sku FROM published_resource" },
      {
        endpoint: "https://gea.test",
        token: "secret",
        signal: controller.signal,
        fetch: async () => {
          controller.abort();
          return Response.json({
            success: true,
            code: 200,
            result: { rows: [], total: 0 },
          });
        },
      },
    ),
  );
});

test('upstream SQL errors retain a bounded diagnostic and redact delegation tokens',async()=>{
 await assert.rejects(()=>readHtmlQuery({sql:'SELECT sku FROM published_resource'}, {endpoint:'https://gea.test',token:'private-token',signal:new AbortController().signal,fetch:async()=>Response.json({success:false,errorCode:'SQL_POLICY_DENIED',message:'Policy refused private-token'},{status:400})}),error=>{assert.equal(error.code,'SQL_POLICY_DENIED');assert.match(error.message,/SQL_POLICY_DENIED/);assert.ok(!error.message.includes('private-token'));assert.match(error.message,/REDACTED/);return true;});
});
