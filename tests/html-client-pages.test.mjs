import { createBusinessIdentityReader } from "../src/business-identity-client.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("every HTML plugin page registers a matching workbench panel", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "gea-html-client-"));
  const output = resolve(temporary, "html-client.mjs");
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const agents = [];
  const presets = new Map();
  const panels = [];
  let dispose;
  try {
    await build({
      alias: { "@deepseek-ai/dsh-client-store": resolve("../deepseek-harness/packages/client/store/src/index.ts") },
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
          ...["inventory-customer", "inventory-orderworkbench", "inventory-orderfulfillment"].map(id => ({
            id,
            name: id,
            mock: true,
            retired: false,
            presetHidden: true,
          })),
          // 已下架模块继续不注册面板。
          {
            id: "inventory-personal",
            name: "库存管理工作台",
            retired: true,
            pages: [{ id: "inventory-personal", name: "库存管理工作台", view: "" }],
          },
        ]);
      }
      if (path === "/api/gea-html/identity") return Response.json({ scope: null });
      throw Error("unexpected fetch: " + path);
    };
    const { registerHtmlClient } = await import(pathToFileURL(output));
    registerHtmlClient({
      effect(callback) {
        dispose = callback();
      },
      agentWorkbench: {
        register({ id, preset }) {
          agents.push(id);
          presets.set(id, preset);
          return () => {};
        },
      },
      slots: {
        inject(_name, callback) {
          callback();
          return () => {};
        },
        register(options) {
          if (options.name === "main") panels.push(options.key);
          return () => {};
        },
      },
    }, undefined, createBusinessIdentityReader(), key => key);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(panels, [
      "inventory-apsplan",
      "inventory-apsboard",
      "inventory-apsdemand",
      "inventory-apsdelivery",
      "inventory-customer",
      "inventory-orderworkbench",
      "inventory-orderfulfillment",
    ]);
    assert.deepEqual(agents, panels);
    for (const id of ["inventory-customer", "inventory-orderworkbench", "inventory-orderfulfillment"])
      assert.equal(presets.get(id), "auto-negotiation", "演示页面绑定已有默认助手，不引用已隐藏的预设");
    assert.equal(presets.get("inventory-apsplan"), "gea-html-inventory-aps");
  } finally {
    dispose?.();
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    await rm(temporary, { recursive: true, force: true });
  }
});

test("HTML discovery does not start a second identity observation", async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), "gea-identity-observer-"));
  const output = resolve(temporary, "html-client.mjs");
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const signals = [], pages = [];
  let dispose;
  try {
    await build({
      alias: { "@deepseek-ai/dsh-client-store": resolve("../deepseek-harness/packages/client/store/src/index.ts") }, entryPoints: [resolve("src/html-client.tsx")], outfile: output, bundle: true, format: "esm", platform: "node" });
    globalThis.fetch = async (url, options) => {
      if (url === "/api/gea-html/identity") {
        signals.push(options.signal);
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      if (url === "/api/gea-proof/status") return Response.json({ ok: true, value: { htmlPlugins: true } });
      if (url === "/api/gea-html/plugins") return Response.json([{ id: "inventory-fixture", name: "fixture", mock: true }]);
      throw Error("unexpected fetch: " + url);
    };
    const { registerHtmlClient } = await import(pathToFileURL(output));
    registerHtmlClient({
      effect(callback) { dispose = callback(); },
      agentWorkbench: { register(page) { pages.push(page.id); return () => {}; } },
      slots: { inject(_name, callback) { callback(); return () => {}; }, register() { return () => {}; } },
    }, undefined, createBusinessIdentityReader(), key => key);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(pages, ["inventory-fixture"]);
    assert.equal(signals.length, 0, "the GEA client owns the only identity observer");
    dispose();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(signals.length, 0, "HTML registration must not schedule identity polling");
  } finally {
    dispose?.();
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    await rm(temporary, { recursive: true, force: true });
  }
});

for (const failure of ["HTTP", "network"]) {
  test(`${failure} discovery failures remain visible without silent polling`, async t => {
    const temporary = await mkdtemp(resolve(tmpdir(), "gea-discovery-failed-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const output = resolve(temporary, "client.mjs");
    const require = createRequire(import.meta.url);
    await build({ entryPoints: [resolve("src/html-client.tsx")], outfile: output, bundle: true, format: "esm", platform: "node",
      alias: { "@deepseek-ai/dsh-client-store": resolve("../deepseek-harness/packages/client/store/src/index.ts") },
      plugins: [{ name: "shared-react", setup(b) { b.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: require.resolve(args.path), external: true })); } }],
    });
    const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
    let calls = 0, notice, dispose;
    globalThis.window = new EventTarget();
    globalThis.fetch = async () => { calls++; if (failure === "network") throw Error("offline"); return Response.json({}, { status: 503 }); };
    try {
      const { registerHtmlClient } = await import(pathToFileURL(output));
      registerHtmlClient({ effect(fn) { dispose = fn(); }, slots: { inject(_key, fn) { return fn(); }, register(options, component) { if (options.name === "shell.overlay") notice = component; return () => {}; } } }, undefined, createBusinessIdentityReader(), key => key);
      await new Promise(setImmediate);
      const html = renderToStaticMarkup(React.createElement(notice));
      assert.match(html, /role="alert"/);
      assert.match(html, failure === "HTTP" ? /HTTP 503/ : /offline/);
      assert.match(html, /retryAction/);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(calls, 1);
      dispose();
      assert.equal(renderToStaticMarkup(React.createElement(notice)), "");
    } finally { dispose?.(); globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
  });
}
