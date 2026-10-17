import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { build } from "esbuild";
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

test("official installed list checks once, keeps actions beside content, submits one batch and offers restart", async (t) => {
  execFileSync(process.execPath, ["scripts/build.mjs", "--target", "client"], { stdio: "pipe" });
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".runtime/list-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
    revision = 0;
  const status = () => ({
    revision: ++revision,
    hostProcessIdentity: "list-host",
    challenge: "list-nonce",
    checkTimeoutMs: 30000,
    pollIntervalMs: 1000,
    items: names.map((packageName) => ({
      packageName,
      state: phase,
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
      if (req.url.endsWith("/update-all")) {
        batches++;
        assert.deepEqual(
          payload.plans,
          names.map((packageName) => ({ packageName, planId: "plan-" + packageName })),
        );
        phase = "pending-restart";
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, value: req.url.endsWith("/status") ? status() : null }));
      return;
    }
    if (req.url === "/gea-client.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(await readFile("lib/client.js"));
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
  await page.getByRole("button", { name: "刷新", exact: true }).dblclick();
  await page.getByRole("button", { name: "全部更新", exact: true }).waitFor();
  assert.equal(checks, 1);
  assert.equal(await page.getByRole("button", { name: "更新", exact: true }).count(), 3);
  for (const width of [835, 620, 520]) {
    await page.setViewportSize({ width, height: 800 });
    const geometry = await cards.evaluateAll((rows) =>
      rows.map((row) => {
        const action = [...row.querySelectorAll("button")].find((b) => b.textContent === "更新");
        const toggle = row.querySelector('[role="switch"]');
        const title = row.querySelector("button[aria-describedby]");
        const a = action.getBoundingClientRect(),
          c = title.getBoundingClientRect(),
          b = toggle.getBoundingClientRect();
        return {
          sameRow:
            a.top < b.bottom && a.bottom > b.top && a.top < row.getBoundingClientRect().bottom,
          contentBeside: c.right <= a.left,
          height: row.getBoundingClientRect().height,
        };
      }),
    );
    assert.ok(
      geometry.every((row) => row.sameRow && row.contentBeside && row.height < 100),
      JSON.stringify({ width, geometry }),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
  }
  if (process.env.GEA_LIST_SCREENSHOT)
    await page.locator("[data-plugin-panel]").screenshot({ path: process.env.GEA_LIST_SCREENSHOT });
  await page.getByRole("button", { name: "全部更新", exact: true }).click();
  const restart = page.getByRole("button", { name: "一键重启", exact: true });
  await restart.waitFor();
  assert.equal(await restart.isEnabled(), true);
  assert.equal(batches, 1);
  await restart.click();
  assert.equal(await page.evaluate(() => window.restartCalls), 1);
  await page.addInitScript(() => {
    Object.defineProperty(window, "dshDesktop", { value: undefined, writable: false });
  });
  await page.reload();
  await page.getByText("需要重启", { exact: false }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "一键重启", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.fixture.dispose());
});
