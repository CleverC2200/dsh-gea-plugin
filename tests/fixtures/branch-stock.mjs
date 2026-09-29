/** Fixed non-production rows; every external data/model endpoint stays on loopback. */
export const stock = [
  {
    snapshot_date: "2026-09-29",
    material_code: "FC001",
    material_name: "测试常温奶",
    product_categ_name: "常温",
    prod_date: "2026-09-01",
    live_qty: 120,
    available_qty: 100,
    updated_time: "2026-09-29 08:00:00",
  },
  {
    snapshot_date: "2026-09-29",
    material_code: "FC002",
    material_name: "测试酸奶",
    product_categ_name: "低温",
    prod_date: "2026-09-20",
    live_qty: 40,
    available_qty: 30,
    updated_time: "2026-09-29 08:00:00",
  },
];
export function stockRows(sql, mode = "ok", parameters = {}) {
  const empty = mode === "empty" && !Object.values(parameters).includes("34");
  let rows;
  if (sql.includes("SELECT DISTINCT branch_pickup_point, branch_name"))
    rows = [
      { branch_pickup_point: "06", branch_name: "长沙分仓" },
      ...(mode === "empty"
        ? [{ branch_pickup_point: "34", branch_name: "郑州分仓" }]
        : []),
    ];
  else if (
    sql.includes("SELECT DISTINCT pickup_code, warehouseid, warehouse_name")
  )
    rows = [
      { pickup_code: "06", warehouseid: "FC06", warehouse_name: "长沙分仓" },
      ...(mode === "empty"
        ? [
            {
              pickup_code: "34",
              warehouseid: "FC34",
              warehouse_name: "郑州分仓",
            },
          ]
        : []),
    ];
  else if (sql.includes("p.plan_snapshot_date::text AS plan_snapshot_date"))
    rows = empty
      ? []
      : stock.map((r) => ({
          ...r,
          plan_snapshot_date: "2026-09-29",
          target_month: "2026-09-01",
          plan_version: "MONTH_START",
          plan_source: "fixture",
          plan_status: "READY",
          bi_target_status: "READY",
          current_inventory_qty: r.live_qty,
          replenishment_cycle_days: 7,
          cycle_rule_source: "fixture",
          shipment_plan_qty: 300,
          transfer_plan_qty: 0,
          expected_month_end_inventory_qty: 100,
          bi_target_amount: 10000,
        }));
  else if (sql.includes("i.prod_date::text AS prod_date"))
    rows = empty
      ? []
      : stock.map((r) =>
          mode === "missing" ? { ...r, available_qty: null } : { ...r },
        );
  else if (sql.includes("SUM(f.metric_value) FILTER"))
    rows = [
      { order_qty: 100, shipped_qty: 80, updated_time: "2026-09-29 08:00:00" },
    ];
  else if (sql.includes("AS outbound_qty"))
    rows = stock.map((r) => ({
      material_code: r.material_code,
      outbound_qty: 20,
    }));
  else if (sql.includes("AS material_group"))
    rows = stock.map((r) => ({
      sku: r.material_code,
      product_name: r.material_name,
      category: r.product_categ_name,
      material_group: "测试产品",
    }));
  else if (
    sql.includes("AS shipped_qty") &&
    sql.includes("material_code AS sku")
  )
    rows = stock.map((r) => ({ sku: r.material_code, shipped_qty: 20 }));
  else if (sql.includes("o.metric_group"))
    rows = stock.flatMap((r) =>
      ["actual_shipped_qty", "in_transit_qty"].map((metric_name) => ({
        snapshot_date: "2026-09-29",
        period_month: "2026-09-01",
        business_date: "2026-09-29",
        metric_group: "branch_activity",
        metric_name,
        material_code: r.material_code,
        material_name: r.material_name,
        metric_value: 20,
        updated_time: r.updated_time,
      })),
    );
  else if (
    sql.includes("agents_scm_branch_pending_order") ||
    sql.includes("agents_scm_branch_production_plan") ||
    sql.includes("agents_scm_branch_budget_monthly")
  )
    rows = [];
  else throw Error("UNEXPECTED_FIXTURE_SQL: " + sql.slice(0, 120));
  if (sql.includes("dsh_packet_source")) {
    if (!rows.length) return [];
    const encoded = sql.match(/'(\[[^']+\])'::text AS dsh_columns/)?.[1];
    const columns = encoded ? JSON.parse(encoded) : null;
    return [
      {
        dsh_packet: 0,
        dsh_count: rows.length,
        ...(columns ? { dsh_columns: encoded } : {}),
        dsh_rows: JSON.stringify(
          columns ? rows.map((r) => columns.map((c) => r[c] ?? null)) : rows,
        ),
      },
    ];
  }
  if (sql.includes("WITH dsh_source_rows AS"))
    return rows.length
      ? [{ dsh_row_count: rows.length, dsh_rows: JSON.stringify(rows) }]
      : [];
  return rows;
}
export function installStockRoutes(app, state, model) {
  app.route((req, res, reply) => {
    const path = req.url.pathname;
    if (path.endsWith("/ai/gateway/agent/session")) {
      const body = JSON.parse(req.body);
      state.restConsumers.push(body.agentCode);
      reply({
        success: true,
        result: {
          accessDecision: { allowed: state.mode !== "denied" },
          delegationToken: "fixture-delegation",
          gatewayContext: { sessionId: "fixture-rest" },
        },
      });
      return true;
    }
    if (path.endsWith("/ai/gateway/sql/execute")) {
      const body = JSON.parse(req.body);
      state.rest.push(body);
      if (state.mode === "error")
        reply({ success: false, code: 500, message: "固定样本查询失败" }, 503);
      else {
        const rows = stockRows(body.sql, state.mode, body.parameters);
        reply({
          success: true,
          code: 200,
          result: {
            requestId: req.headers["x-request-id"],
            operation: "SELECT",
            tables: ["agents_scm_branch_inventory_snapshot"],
            total: rows.length,
            pageNo: body.pageNo ?? 1,
            pageSize: body.pageSize ?? 200,
            rows,
          },
        });
      }
      return true;
    }
    if (path.endsWith("/ai/gateway/session")) {
      const body = JSON.parse(req.body);
      state.gateway.push(body);
      reply({
        success: true,
        result: {
          accessDecision: { allowed: state.mode !== "denied" },
          gatewayContext: {
            consumerType: "AGENT",
            consumerCode: "branch-inventory",
            sessionId: "fixture-cube",
            conversationId: "fixture-conversation",
          },
          delegationToken: "fixture-cube-token",
        },
      });
      return true;
    }
    if (path.endsWith("/ai/gateway/mcp/proxy/resources")) {
      state.discovery.push(JSON.parse(req.body));
      reply({
        success: true,
        resources:
          state.mode === "denied"
            ? []
            : [
                {
                  capabilityCode: "MCP_TOOL:cube:query_business_data",
                  resourceCode: "branch_stock",
                  resourceName: "分仓库存固定样本",
                  resourceType: "EXTERNAL_MCP",
                  queryTarget: "branch_stock",
                  version: "fixture-20260929",
                  maxRows: 100,
                  maxBytes: null,
                },
              ],
      });
      return true;
    }
    if (path.endsWith("/ai/gateway/mcp/proxy/mcp")) {
      const body = JSON.parse(req.body);
      let result = {};
      if (body.method === "initialize")
        result = { protocolVersion: body.params.protocolVersion };
      else if (body.method === "notifications/initialized") {
        res.statusCode = 202;
        res.end();
        return true;
      } else if (body.method === "tools/list")
        result = {
          tools: [
            {
              name: "query_business_data",
              _meta: { sourceType: "MCP", sourceCode: "cube" },
              inputSchema: {
                type: "object",
                properties: {
                  action: { type: "string" },
                  queries: { type: "array" },
                },
                required: ["action", "queries"],
              },
            },
          ],
        };
      else if (body.method === "tools/call") {
        const args = body.params.arguments;
        if (args.action === "inspect")
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  semanticModel: [
                    {
                      name: "branch_stock",
                      measures: [
                        {
                          name: "branch_stock.available_qty",
                          type: "number",
                          description: "可用库存，件",
                        },
                      ],
                      dimensions: [
                        { name: "branch_stock.material_code", type: "string" },
                        { name: "branch_stock.warehouse_name", type: "string" },
                        { name: "branch_stock.snapshot_date", type: "time" },
                      ],
                    },
                  ],
                }),
              },
            ],
          };
        else {
          state.cube.push(args);
          result =
            state.mode === "error"
              ? {
                  isError: true,
                  content: [{ type: "text", text: "固定样本读取失败" }],
                }
              : {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        datasets: [
                          {
                            name: "branch_stock",
                            rows:
                              state.mode === "empty"
                                ? []
                                : stock.map((r) => ({
                                    "branch_stock.material_code":
                                      r.material_code,
                                    "branch_stock.warehouse_name": "长沙分仓",
                                    "branch_stock.snapshot_date":
                                      r.snapshot_date,
                                    "branch_stock.available_qty":
                                      state.mode === "missing"
                                        ? null
                                        : r.available_qty,
                                  })),
                          },
                        ],
                      }),
                    },
                  ],
                };
        }
      }
      reply({ jsonrpc: "2.0", id: body.id, result });
      return true;
    }
    if (path === "/v1/chat/completions") {
      const body = JSON.parse(req.body);
      state.models.push(body);
      const delta = model(body, state);
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta,
                finish_reason: delta.tool_calls ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    }
    return false;
  });
}
export const stockState = () => ({
  mode: "ok",
  rest: [],
  restConsumers: [],
  gateway: [],
  discovery: [],
  cube: [],
  models: [],
});
