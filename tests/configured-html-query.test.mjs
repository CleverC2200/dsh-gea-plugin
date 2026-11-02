import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConfiguredHtmlQuery } from "../src/host/configured-html-query.ts";
import { createGeaSqlDatabase } from "../src/html-sql.ts";
const signal = () => new AbortController().signal;
test("configured Cube keeps installed members and Consumer, binds a leap month and preserves partial NULL", async (t) => {
  const r = await resource(t, "mps"),
    calls = [];
  const business = {
    pluginSql: async () => {
      throw Error("Cube must not use SQL");
    },
    moduleMcp: async (consumer, s) => {
      assert.equal(consumer, "mps");
      assert.equal(s, scope.signal);
      return {
        call: async (name, args) => {
          calls.push({ name, args });
          const q = args.queries[0];
          const columns = r.config.queries[q.name].columns;
          return JSON.stringify({
            action: "query",
            status: "completed",
            executedQueryCount: 1,
            datasets: [
              {
                name: q.name,
                rows: [
                  Object.fromEntries(
                    columns.map((key) => [
                      key,
                      key.endsWith("income_excl_tax_local_total") ? null : 0,
                    ]),
                  ),
                ],
                rowCount: 1,
                fields: columns.map((name) => ({ name })),
                dataStatus: "partial",
                totalRowCount: 1,
                offset: 0,
                hasMorePages: false,
                warnings: [{ code: "METRIC_VALUE_UNAVAILABLE" }],
              },
            ],
          });
        },
      };
    },
  };
  const scope = new AbortController();
  const input = {
    queryId: "facts.history",
    parameters: { month: "2024-02-01", page_size: 200, offset: 0 },
  };
  const result = await readConfiguredHtmlQuery(r, input, business, scope.signal);
  assert.equal(result.success, undefined);
  assert.equal(result.rows[0]["agents_scm_cust_deliv_daily_di.income_excl_tax_local_total"], null);
  assert.equal(result.dataStatus, "partial");
  assert.deepEqual(result.warnings, [{ code: "METRIC_VALUE_UNAVAILABLE" }]);
  assert.equal(calls[0].name, "query_business_data");
  assert.deepEqual(calls[0].args.queries[0].query.timeDimensions[0], {
    dimension: "agents_scm_cust_deliv_daily_di.shipment_date",
    dateRange: ["2024-02-01", "2024-02-29"],
  });
  for (const extra of [{ consumerCode: "other" }, { cube: {} }, { sql: "SELECT 1" }]) {
    const denied = await readConfiguredHtmlQuery(
      r,
      { ...input, parameters: { ...input.parameters, ...extra } },
      business,
      scope.signal,
    );
    assert.equal(denied.success, false);
  }
  assert.equal(calls.length, 1);
  const invalid = await readConfiguredHtmlQuery(
    r,
    { ...input, parameters: { ...input.parameters, month: "2024-02-02" } },
    business,
    scope.signal,
  );
  assert.equal(invalid.success, false);
  scope.abort();
  await assert.rejects(readConfiguredHtmlQuery(r, input, business, scope.signal), {
    name: "AbortError",
  });
});
async function resource(t, id) {
  const directory = await mkdtemp(join(tmpdir(), "configured-gea-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root =
    id === "mps"
      ? "../dsh-agent-workbench/static/mps"
      : "../dsh-agent-workbench/business/inventory-" + id;
  const manifest = JSON.parse(await readFile(root + "/plugin.json", "utf8"));
  const raw = await readFile(root + "/sql.config.json", "utf8");
  await writeFile(join(directory, "sql.config.json"), raw);
  return { directory, manifest, config: JSON.parse(raw) };
}
for (const id of ["fc", "aqkc", "qll", "dealer", "apsplan", "mps"])
  test(id + ": installed query uses its Consumer and binds fresh ten-row offsets", async (t) => {
    const r = await resource(t, id),
      calls = [];
    const business = {
      pluginSql: async (request, s, configured) => {
        s.throwIfAborted();
        calls.push({ request, configured });
        return { rows: [], returnedColumns: ["sku"], rejectedColumns: [] };
      },
    };
    const [queryId, q] = Object.entries(r.config.queries).find(([, q]) => q.pagination?.countQuery);
    const parameters = Object.fromEntries(
      Object.entries(q.parameterSpec).map(([key, s]) => [s.name, q.request.parameters?.[key]]),
    );
    parameters.page_size = 10;
    parameters.offset = 0;
    const first = await readConfiguredHtmlQuery(r, { queryId, parameters }, business, signal());
    const second = await readConfiguredHtmlQuery(
      r,
      { queryId, parameters: { ...parameters, offset: 10 } },
      business,
      signal(),
    );
    assert.equal(first.success, undefined);
    assert.equal(first.configVersion, second.configVersion);
    assert.match(first.configVersion, /^[a-f0-9]{64}$/);
    assert.equal(calls.length, 2);
    const offset = Object.entries(q.parameterSpec).find(([, s]) => s.name === "offset")[0];
    const size = Object.entries(q.parameterSpec).find(([, s]) => s.name === "page_size")[0];
    assert.equal(calls[0].request.parameters[offset], 0);
    assert.equal(calls[1].request.parameters[offset], 10);
    for (const { request, configured } of calls) {
      assert.equal(configured, true);
      assert.equal(request.consumerCode, r.manifest.gea.consumerCode);
      assert.equal(request.sql, q.request.sql);
      assert.equal(request.parameters[size], 10);
      assert.equal(request.pageNo, undefined);
      assert.equal(request.pageSize, undefined);
      assert.equal(request.includeTotal, false);
    }
    const denied = await readConfiguredHtmlQuery(
      r,
      { queryId, parameters, consumerCode: "forged" },
      business,
      signal(),
    );
    assert.equal(denied.success, false);
    assert.equal(calls.length, 2);
    const missing = await readConfiguredHtmlQuery(
      r,
      { queryId: "unknown", parameters: {} },
      business,
      signal(),
    );
    assert.equal(missing.errorCode, "QUERY_NOT_REGISTERED");
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      readConfiguredHtmlQuery(r, { queryId, parameters }, business, aborted.signal),
      { name: "AbortError" },
    );
  });
test("configured gateway transport preserves SQL-owned pagination without conflicting request pagination", async () => {
  const requests = [];
  const s = signal();
  const db = createGeaSqlDatabase(() => "private-fixture-token", {
    endpoint: "https://fixture.invalid/sql",
    signal: s,
    fetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      assert.equal(init.headers["X-Delegation-Token"], "private-fixture-token");
      return Response.json({
        success: true,
        result: {
          rows: [{ sku: "a" }],
          returnedColumns: ["sku"],
          rejectedColumns: [{ outputAlias: "qty", reason: "RETURN_PERMISSION_DENIED" }],
        },
      });
    },
  });
  const request = {
    sql: "SELECT t.sku AS sku FROM published AS t WHERE t.sku IN (:gea_p1) ORDER BY t.sku LIMIT :gea_p2 OFFSET :gea_p3",
    parameters: { gea_p1: ["a", "b"], gea_p2: 10, gea_p3: 10 },
    includeTotal: false,
  };
  const result = await db.queryConfigured(request);
  assert.deepEqual(requests, [request]);
  assert.equal(result.rejectedColumns[0].outputAlias, "qty");
});
test("configured 200-row SQL pages preserve the requested limit and offset", async () => {
  const request = {
    sql: "SELECT t.sku AS sku FROM published AS t ORDER BY t.sku LIMIT :gea_p1 OFFSET :gea_p2",
    parameters: { gea_p1: 200, gea_p2: 200 },
    includeTotal: false,
  };
  let envelope;
  const db = createGeaSqlDatabase(() => "fixture-token", {
    endpoint: "https://fixture.invalid/sql",
    signal: signal(),
    fetch: async (_url, init) => {
      envelope = JSON.parse(init.body);
      return Response.json({
        success: true,
        result: {
          rows: Array.from({ length: envelope.parameters.gea_p1 }, (_, i) => ({
            sku: String(200 + i),
          })),
        },
      });
    },
  });
  const result = await db.queryConfigured(request);
  assert.equal(result.rows.length, 200);
  assert.equal(envelope.pageNo, undefined, "SQL owns the offset");
  assert.equal(envelope.pageSize, undefined, "SQL owns the limit");
  assert.equal(envelope.sql, request.sql);
  assert.deepEqual(envelope.parameters, request.parameters);
});
test("structured permission failures survive configured transport with secret redaction and no retry", async () => {
  let calls = 0;
  const db = createGeaSqlDatabase(() => "private-fixture-token", {
    endpoint: "https://fixture.invalid/sql",
    signal: signal(),
    fetch: async () => {
      calls++;
      return Response.json(
        {
          success: false,
          errorCode: "AI_GATEWAY_DATA_PERMISSION_DENIED",
          failure: {
            stage: "BIND",
            reasonCode: "NO_RETURN_COLUMN_ALLOWED",
            statementPath: "select.items[0]",
            suggestedAction: "Do not expose private-fixture-token",
          },
          rejectedColumns: [{ outputAlias: "qty", reason: "RETURN_PERMISSION_DENIED" }],
        },
        { status: 403 },
      );
    },
  });
  await assert.rejects(
    db.queryConfigured({
      sql: "SELECT 1 AS qty",
      parameters: {},
      includeTotal: false,
    }),
    (e) => {
      assert.equal(e.code, "NO_RETURN_COLUMN_ALLOWED");
      assert.equal(e.failure.stage, "BIND");
      assert.equal(e.failure.statementPath, "select.items[0]");
      assert.ok(!JSON.stringify(e).includes("private-fixture-token"));
      return true;
    },
  );
  assert.equal(calls, 1);
});
test("installed config identity and path are checked before any SQL", async (t) => {
  const r = await resource(t, "fc");
  let calls = 0;
  const b = {
    pluginSql: async () => {
      calls++;
    },
  };
  const queryId = Object.keys(r.config.queries)[0];
  r.config.agentId = "inventory-qll";
  await writeFile(join(r.directory, "sql.config.json"), JSON.stringify(r.config));
  assert.equal(
    (await readConfiguredHtmlQuery(r, { queryId, parameters: {} }, b, signal())).errorCode,
    "INVALID_AGENT_SQL_CONFIG",
  );
  await rm(join(r.directory, "sql.config.json"));
  await symlink("/etc/hosts", join(r.directory, "sql.config.json"));
  assert.equal(
    (await readConfiguredHtmlQuery(r, { queryId, parameters: {} }, b, signal())).errorCode,
    "INVALID_SQL_CONFIG_PATH",
  );
  assert.equal(calls, 0);
});
for (const flag of [{ complete: false }, { truncated: true }, { hasMore: true }, { rowCount: 2 }])
  test("configured results reject incomplete metadata " + JSON.stringify(flag), async () => {
    const db = createGeaSqlDatabase(() => "fixture-token", {
      endpoint: "https://fixture.invalid/sql",
      signal: signal(),
      fetch: async () =>
        Response.json({
          success: true,
          result: { rows: [{ qty: 1 }], ...flag },
        }),
    });
    await assert.rejects(
      db.queryConfigured({
        sql: "SELECT 1 AS qty",
        parameters: {},
        includeTotal: false,
      }),
      (e) => ["GEA_SQL_RESULT_INCOMPLETE", "GEA_SQL_RESPONSE_INVALID"].includes(e.code),
    );
  });
test("configured result preserves envelope-level column permissions", async () => {
  const db = createGeaSqlDatabase(() => "fixture-token", {
    endpoint: "https://fixture.invalid/sql",
    signal: signal(),
    fetch: async () =>
      Response.json({
        success: true,
        returnedColumns: ["qty"],
        rejectedColumns: ["cost"],
        result: { rows: [{ qty: 1 }] },
      }),
  });
  const result = await db.queryConfigured({
    sql: "SELECT 1 AS qty",
    parameters: {},
    includeTotal: false,
  });
  assert.deepEqual(result.returnedColumns, ["qty"]);
  assert.deepEqual(result.rejectedColumns, ["cost"]);
});

for (const id of ["fc", "aqkc", "qll", "apsplan"])
  test(id + ": snapshot recovery is enabled only for initialization queries", async (t) => {
    const r = await resource(t, id);
    const source = Object.keys(r.config.queries).find((key) => key.startsWith("source."));
    assert.ok(source);
    const detail = Object.keys(r.config.queries).find(
      (key) => r.config.queries[key].pagination?.countQuery,
    );
    const cases = [
      ...new Set(
        [source, r.config.overviewQuickStock, "current-shortage.summary", detail].filter(
          (key) => r.config.queries[key],
        ),
      ),
    ];
    for (const queryId of cases) {
      const q = r.config.queries[queryId];
      const parameters = Object.fromEntries(
        Object.entries(q.parameterSpec).map(([key, s]) => [s.name, q.request.parameters?.[key]]),
      );
      let called = false;
      const result = await readConfiguredHtmlQuery(
        r,
        { queryId, parameters },
        {
          pluginSql: async (request, signal, configured, reportWrite, recovery) => {
            assert.equal(reportWrite, undefined);
            called = true;
            assert.equal(configured, true);
            assert.equal(recovery, queryId !== detail);
            assert.equal(request.consumerCode, r.manifest.gea.consumerCode);
            return { rows: [] };
          },
        },
        signal(),
      );
      assert.equal(result.success, undefined, JSON.stringify(result));
      assert.ok(called);
    }
  });

test("expired page Cube reads discard only the rejected cached connection and never retry the same request", async (t) => {
  const r = await resource(t, "mps");
  let calls = 0;
  const expired = {
    call: async () => {
      calls++;
      throw Object.assign(Error("AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED"), {
        code: "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED",
      });
    },
  };
  const cleared = [];
  const result = await readConfiguredHtmlQuery(
    r,
    { queryId: "facts.history", parameters: { month: "2026-06-01", page_size: 200, offset: 0 } },
    {
      moduleMcp: async () => expired,
      invalidateModuleMcp: (...args) => cleared.push(args),
    },
    signal(),
  );
  assert.equal(result.success, false);
  assert.equal(calls, 1);
  assert.deepEqual(cleared, [["mps", expired]]);
});
