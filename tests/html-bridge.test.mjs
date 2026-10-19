import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareHtmlQuery, readHtmlQuery } from "../src/html-query.ts";
import { createHtmlSessions } from "../../dsh-agent-workbench/src/html-sessions.ts";
const session = "session-11111111-1111-1111-1111-111111111111";
test("active leases renew but idle expiry and wrong-plugin isolation remain enforced", async () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const pages = createHtmlSessions();
  try {
    const lease = pages.open("inventory-aqkc", session, randomUUID());
    now += 299000;
    pages.consume(lease);
    now += 299000;
    assert.deepEqual(pages.consume(lease), []);
    await assert.rejects(
      pages.invoke("inventory-other", session, "context", {}, new AbortController().signal),
      /还没有打开业务页面/,
    );
    now += 300001;
    assert.throws(() => pages.consume(lease), /PAGE_LEASE_EXPIRED/);
  } finally {
    pages.clear();
    Date.now = originalNow;
  }
});
test("a conversation without an open page reports it instead of a raw failure", async () => {
  const pages = createHtmlSessions();
  try {
    await assert.rejects(
      () => pages.invoke("inventory-aqkc", session, "context", {}, new AbortController().signal),
      /还没有打开业务页面/,
    );
    const lease = pages.open("inventory-aqkc", session, randomUUID());
    pages.syncContext(lease, { sku: "A" });
    const observed = await pages.invoke(
      "inventory-aqkc",
      session,
      "context",
      {},
      new AbortController().signal,
    );
    assert.deepEqual(observed.context, { sku: "A" });
    await assert.rejects(
      pages.invoke("inventory-other", session, "context", {}, new AbortController().signal),
      /还没有打开业务页面/,
    );
    pages.close(lease);
    await assert.rejects(
      pages.invoke("inventory-aqkc", session, "context", {}, new AbortController().signal),
      /还没有打开业务页面/,
    );
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
    prepareHtmlQuery({ sql: "SELECT * FROM x WHERE a=$1", values: ["中文"] }).values[0],
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
            rows: Array.from({ length: Math.min(200, 401 - offset) }, (_, i) => ({
              sku: i + offset,
            })),
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
    lease = pages.open("inventory-fc", session, randomUUID());
  await assert.rejects(
    pages.invoke("inventory-dealer", session, "context", {}, new AbortController().signal),
    /还没有打开业务页面/,
  );
  await assert.rejects(
    pages.invoke(
      "inventory-fc",
      "session-22222222-2222-2222-2222-222222222222",
      "context",
      {},
      new AbortController().signal,
    ),
  );
  pages.registerAction(lease, "refresh", "Refresh inventory");
  const pending = pages.invoke(
    "inventory-fc",
    session,
    "refresh",
    {},
    new AbortController().signal,
  );
  pages.clear();
  await assert.rejects(pending, /关闭|登录/);
  assert.throws(() => pages.consume(lease));
});
test("registered page action returns through correlated reply; cancellation clears queue", async () => {
  const pages = createHtmlSessions(),
    lease = pages.open("inventory-fc", session, randomUUID());
  pages.registerAction(lease, "filter", "Filter warehouse");
  const response = pages.invoke(
      "inventory-fc",
      session,
      "filter",
      { warehouseId: "A" },
      new AbortController().signal,
    ),
    event = pages.consume(lease)[0];
  pages.reply(lease, { id: event.id, result: { status: "filtered" } });
  assert.deepEqual(await response, { status: "filtered" });
  const abort = new AbortController();
  const cancelled = pages.invoke("inventory-fc", session, "filter", {}, abort.signal);
  abort.abort();
  await assert.rejects(cancelled, /CANCELLED/);
  assert.equal(pages.consume(lease).length, 0);
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
        fetch: async () => Response.json({ success: false, code: 403 }, { status: 403 }),
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

test("upstream SQL errors retain a bounded diagnostic and redact delegation tokens", async () => {
  await assert.rejects(
    () =>
      readHtmlQuery(
        { sql: "SELECT sku FROM published_resource" },
        {
          endpoint: "https://gea.test",
          token: "private-token",
          signal: new AbortController().signal,
          fetch: async () =>
            Response.json(
              {
                success: false,
                errorCode: "SQL_POLICY_DENIED",
                message: "Policy refused private-token",
              },
              { status: 400 },
            ),
        },
      ),
    (error) => {
      assert.equal(error.code, "SQL_POLICY_DENIED");
      assert.match(error.message, /SQL_POLICY_DENIED/);
      assert.ok(!error.message.includes("private-token"));
      assert.match(error.message, /REDACTED/);
      return true;
    },
  );
});

test("partial RETURN permissions preserve allowed fields and rejection metadata", async () => {
  const rejectedColumns = [{ alias: "amount", reason: "RETURN_PERMISSION_DENIED" }];
  const result = await readHtmlQuery(
    { sql: "SELECT code AS code, amount AS amount FROM published ORDER BY code" },
    {
      endpoint: "https://gea.test",
      token: "private-token",
      signal: new AbortController().signal,
      fetch: async () =>
        Response.json({
          success: true,
          code: 200,
          result: { rows: [{ code: "A" }], total: 1, returnedColumns: ["code"], rejectedColumns },
        }),
    },
  );
  assert.deepEqual(result.rows, [{ code: "A" }]);
  assert.deepEqual(result.returnedColumns, ["code"]);
  assert.deepEqual(result.rejectedColumns, rejectedColumns);
});
test("structured authorization failures keep reasonCode and never retry", async () => {
  let calls = 0;
  await assert.rejects(
    readHtmlQuery(
      { sql: "SELECT amount AS amount FROM published" },
      {
        endpoint: "https://gea.test",
        token: "private-token",
        signal: new AbortController().signal,
        fetch: async () => {
          calls++;
          return Response.json({
            success: false,
            code: 200,
            result: {
              failure: {
                stage: "AUTHORIZE",
                reasonCode: "NO_RETURN_COLUMN_ALLOWED",
                target: "amount",
              },
            },
          });
        },
      },
    ),
    (error) => error.code === "NO_RETURN_COLUMN_ALLOWED" && error.retryable === false,
  );
  assert.equal(calls, 1);
});

test("gateway page limit is enforced without changing row order or permission metadata", async () => {
  const offsets = [];
  const transport = {
    endpoint: "https://gea.test",
    token: "private-token",
    signal: new AbortController().signal,
    fetch: async (_url, init) => {
      const { parameters, includeTotal } = JSON.parse(init.body);
      const offset = parameters.fc_page_offset,
        limit = parameters.fc_page_limit;
      offsets.push(offset);
      assert.equal(limit, 200);
      return Response.json({
        success: true,
        code: 200,
        result: {
          rows: Array.from({ length: Math.min(limit, 501 - offset) }, (_, i) => ({
            sku: String(offset + i),
          })),
          ...(includeTotal ? { total: 501 } : {}),
          returnedColumns: ["sku"],
          rejectedColumns: ["amount"],
        },
      });
    },
  };
  const result = await readHtmlQuery(
    { sql: "SELECT sku AS sku FROM published ORDER BY sku", pageSize: 200 },
    transport,
  );
  assert.equal(result.rows.length, 501);
  assert.deepEqual(
    result.rows.map((r) => r.sku),
    Array.from({ length: 501 }, (_, i) => String(i)),
  );
  assert.deepEqual(offsets, [0, 200, 400]);
  assert.deepEqual(result.rejectedColumns, ["amount"]);
  await assert.rejects(
    readHtmlQuery(
      { sql: "SELECT sku AS sku FROM published ORDER BY sku", pageSize: 201 },
      transport,
    ),
    /INVALID_PAGE/,
  );
});
