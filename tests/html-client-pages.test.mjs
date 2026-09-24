import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

test("every HTML plugin page registers a matching workbench panel", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "gea-html-client-"));
  const output = resolve(temporary, "html-client.mjs");
  const originalFetch = globalThis.fetch;
  const agents = [];
  const panels = [];
  try {
    await build({
      entryPoints: [resolve("src/html-client.tsx")],
      outfile: output,
      bundle: true,
      format: "esm",
      platform: "node",
    });
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/api/gea-proof/status") {
        return Response.json({ ok: true, value: { htmlPlugins: true } });
      }
      if (path === "/api/gea-html/plugins") {
        return Response.json([
          {
            id: "inventory-aps",
            name: "产销协同",
            pages: [
              { id: "inventory-apsplan", name: "产销协同工作台", view: "plan" },
              { id: "inventory-apsboard", name: "产销协同看板", view: "coordination" },
              { id: "inventory-apsdemand", name: "需求运营管理", view: "demand" },
              { id: "inventory-apsdelivery", name: "交付运营管理", view: "delivery" },
            ],
          },
          // 下架/演示模块：宿主标了 retired，客户端不能再给它注册面板，否则会点出一个
          // 绑不上会话（宿主已不生成该预设）的空页面。
          {
            id: "inventory-customer",
            name: "客户库存",
            retired: true,
            pages: [{ id: "inventory-customer", name: "客户库存", view: "" }],
          },
        ]);
      }
      throw Error("unexpected fetch: " + path);
    };
    const { registerHtmlClient } = await import(pathToFileURL(output));
    registerHtmlClient({
      effect(callback) {
        callback();
      },
      agentWorkbench: {
        register({ id }) {
          agents.push(id);
          return () => {};
        },
      },
      slots: {
        inject(_name, callback) {
          callback();
          return () => {};
        },
        register(options) {
          panels.push(options.key);
          return () => {};
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(panels, [
      "inventory-apsplan",
      "inventory-apsboard",
      "inventory-apsdemand",
      "inventory-apsdelivery",
    ]);
    assert.deepEqual(agents, panels);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(temporary, { recursive: true, force: true });
  }
});
