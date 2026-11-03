import test from "node:test";
import { sourceTools } from "./fixtures/plugin-updates/source-tools.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { build } from "esbuild";
import { clientBuildOptions } from "../scripts/client-build.mjs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
const require = createRequire(import.meta.url);
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk) throw Error("GEA_PLUGIN_UPDATE_SDK required");
const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
];

test("official installed list opens the shared update panel for suite actions and restart", async (t) => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".runtime/list-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientOptions = clientBuildOptions(join(root, "gea-client.js"));
  await build({ ...clientOptions, plugins: [...sourceTools(sdk), ...clientOptions.plugins] });
  const sources = {
    "@fixture/remote": "packages/test-support/client-runtime/src/remote.ts",
    "@deepseek-ai/dsh-client-ui-primitives": "packages/client/ui-primitives/src/index.ts",
    "@deepseek-ai/dsh-client-ui-renderer/client": "packages/client/ui-renderer/src/client/index.ts",
    "@deepseek-ai/dsh-client-locale/client": "packages/client/locale/src/client/index.ts",
    "@deepseek-ai/dsh-client-ui-settings/client": "packages/client/ui-settings/src/client/index.ts",
    "@deepseek-ai/dsh-client-ui-plugin-manager/client":
      "packages/client/ui-plugin-manager/src/client/index.ts",
  };
  await build({
    entryPoints: ["tests/fixtures/plugin-updates/list-browser.tsx"],
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: join(root, "app.js"),
    jsx: "automatic",
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
    define: { "process.env.NODE_ENV": '"test"' },
    plugins: [
      ...sourceTools(sdk),
      {
        name: "official-source",
        setup(b) {
          b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, ({ path }) => ({
            path: require.resolve(path),
          }));
          b.onResolve({ filter: /^(@deepseek-ai\/|@fixture\/)/ }, ({ path }) =>
            sources[path] ? { path: join(sdk, sources[path]) } : undefined,
          );
        },
      },
    ],
  });
  let phase = "idle",
    checks = 0,
    batches = 0,
    singles = 0,
    singleTarget,
    revision = 0;
  const status = () => ({
    revision: ++revision,
    hostProcessIdentity: "list-host",
    challenge: "list-nonce",
    checkTimeoutMs: 30000,
    pollIntervalMs: 1000,
    items: names.map((packageName) => ({
      packageName,
      state: singleTarget && packageName !== singleTarget ? "current" : phase,
      installedVersion: phase === "pending-restart" ? "1.2.4" : "1.2.3",
      runningHostVersion: "1.2.3",
      runningClientVersion: "1.2.3",
      candidateVersion: phase === "idle" ? null : "1.2.4",
      planId: phase === "available" ? "plan-" + packageName : null,
      diagnostic: null,
    })),
  });
  const server = createServer(async (req, res) => {
    if (req.url.startsWith("/api/gea/plugin-updates/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      if (req.url.endsWith("/check")) {
        checks++;
        await new Promise((resolve) => setTimeout(resolve, 120));
        phase = "available";
      }
      if (req.url.endsWith("/update")) {
        singles++;
        assert.deepEqual(payload, {
          packageName: names[1],
          planId: "plan-" + names[1],
        });
        singleTarget = names[1];
        phase = "installing";
      }
      if (req.url.endsWith("/update-all")) {
        batches++;
        assert.deepEqual(
          payload.plans,
          names.map((packageName) => ({ packageName, planId: "plan-" + packageName })),
        );
        phase = "installing";
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, value: req.url.endsWith("/status") ? status() : null }));
      return;
    }
    if (req.url === "/gea-client.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(await readFile(join(root, "gea-client.js")));
      return;
    }
    if (req.url === "/app.js" || req.url === "/app.css") {
      res.setHeader("content-type", req.url.endsWith("css") ? "text/css" : "text/javascript");
      res.end(await readFile(join(root, req.url.slice(1))));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      '<style>body{margin:0;font-family:var(--dsw-font-family);background:var(--dsw-alias-bg-layer-1)}</style><div id="root"><div id="app"></div></div><link rel="stylesheet" href="/app.css"><script>window.restartCalls=0;window.dshDesktop={restart:async()=>{window.restartCalls++;return false}};window.__ModuleLoader__={load(entry){window.geaFactory=entry.factory}}</script><script src="/gea-client.js"></script><script type="module" src="/app.js"></script>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.GEA_TEST_CHROMIUM,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 835, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.setDefaultTimeout(8000);
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page
    .locator("[data-plugin-package]")
    .first()
    .waitFor()
    .catch(async (error) => {
      console.error({ errors, html: await page.locator("body").innerHTML() });
      throw error;
    });
  const cards = page.locator("[data-plugin-package]");
  assert.equal(await cards.count(), 3);
  for (const name of ["dsh-agent-workbench", "dsh-agent-manage", "gea-dsh-prototype"])
    assert.equal(await page.getByRole("button", { name: `查看 ${name}`, exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: /@cleverc2200/ }).count(), 0);
  await page.getByRole("button", { name: "查看更新状态", exact: true }).click();
  const panel = page.locator(".gea-updates-panel");
  await panel.getByRole("heading", { name: "公司插件", exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.fixture.openedSections), ["company-updates"]);
  await panel.getByRole("button", { name: "检查更新", exact: true }).dblclick();
  await panel.getByRole("button", { name: "全部更新", exact: true }).waitFor();
  assert.equal(checks, 1);
  await panel.getByRole("button", { name: "全部更新", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "插件正在更新，可查看更新状态。" }).waitFor();
  await page.evaluate(() => window.fixture.closeSettings());
  assert.equal(batches, 1);
  phase = "pending-restart";
  const pending = page
    .getByRole("alert")
    .filter({ hasText: "插件更新已安装，需要重启应用后生效。" });
  await pending.waitFor();
  await pending.getByRole("button", { name: "查看更新状态", exact: true }).click();
  await panel.getByRole("button", { name: "重启应用以启用插件", exact: true }).click();
  assert.equal(await page.evaluate(() => window.restartCalls), 1);
  await panel
    .getByText("重启已取消或当前无法重启，已安装的插件更新仍在等待重启。", { exact: true })
    .waitFor();
  assert.equal(batches, 1);
  assert.equal(singles, 0);
  await page.evaluate(() => window.fixture.locale("en"));
  await panel.getByRole("heading", { name: "Company plugins", exact: true }).waitFor();
  await page.goto(url + "?sidebar");
  const footer = page.locator("footer");
  await footer.getByRole("button", { name: "更新", exact: true }).waitFor();
  assert.equal(await footer.locator(".gea-sidebar-update").count(), 0);
  const previous = batches;
  await footer.getByRole("button", { name: "更新", exact: true }).click();
  await page.locator(".gea-updates-panel").waitFor();
  assert.equal(batches, previous);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.fixture.dispose());
});
