import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readSession, readToolResults, until } from "./profile.mjs";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";
import { stockState, installStockRoutes } from "./fixtures/branch-stock.mjs";
import { fixtureWorkbench } from "./fixtures/workbench-profile.mjs";
import { selectBusinessResource } from "./fixtures/business-session.mjs";

test(
  "branch Agent preserves empty, missing, failed and revoked result meanings",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 120000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          agentCode: "branch-inventory",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: {
        GEA_TEST_MODEL_KEY: "fixture-key",
      },
      beforeStart: fixtureWorkbench([resolve("../dsh-agent-workbench/lib/business/inventory-fc")]),
    });
    const state = stockState();
    let step = 0;
    installStockRoutes(app, state, () => {
      if (++step % 2 === 1)
        return {
          tool_calls: [
            {
              index: 0,
              id: "stock-state-" + step,
              type: "function",
              function: {
                name: "gea_cube_query",
                arguments: JSON.stringify({
                  consumerCode: "branch-inventory",
                  queries: [
                    {
                      name: "branch_stock",
                      query: {
                        dimensions: ["branch_stock.material_code"],
                        measures: ["branch_stock.available_qty"],
                        limit: 10,
                      },
                    },
                  ],
                }),
              },
            },
          ],
        };
      return {
        content: {
          empty: "授权范围内没有库存行。",
          missing: "可用库存缺失，不能按零计算。",
          error: "读取失败，未取得库存结论。",
          denied: "当前未获授权，不能读取库存。",
        }[state.mode],
      };
    });
    await app.login();
    const selected = await selectBusinessResource(app, "gea-html-inventory-fc");
    const created = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: selected.preset,
    });
    assert.equal(created.ok, true);
    const id = created.value.sessionId;
    await app.remote("session/selectModel", {
      sessionId: id,
      provider: "gea-analysis",
      model: "fixture",
    });
    const results = [];
    let turns = 0;
    for (const mode of ["empty", "missing", "error", "denied"]) {
      state.mode = mode;
      const before = state.cube.length;
      await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId: id,
        mode: "queue",
        content: [{ type: "text", text: "读取长沙分仓库存，验证状态 " + mode }],
      });
      turns++;
      const rows = await until(
        () => readSession(app.runtime, id),
        (rows) => rows.filter((r) => r.type === "turn/end").length === turns,
        60000,
      );
      const result = readToolResults(rows).at(-1);
      assert.ok(result);
      if (mode === "denied") {
        assert.equal(state.cube.length, before);
        assert.match(result.text, /NOT_AUTHORIZED|REJECTED/);
      } else if (mode === "error") assert.match(result.text, /失败|failed|MCP_TOOL_ERROR/i);
      else if (mode === "missing") assert.match(result.text, /null/);
      else assert.doesNotMatch(result.text, /"branch_stock.available_qty":(?:100|30)/);
      results.push({ mode, result });
    }
    const output = resolve(".runtime/branch-stock-evidence");
    await mkdir(output, { recursive: true });
    await writeFile(resolve(output, "agent-states.json"), JSON.stringify(results, null, 2));
  },
);
