import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk) throw Error("GEA_PLUGIN_UPDATE_SDK required");
const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
];
const pkg = (name) => ({ name, installed: true, enabled: true, rows: [] });
test("official detail slots check, update, close and reenter through controlled HTTP", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".runtime/detail-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await build({
    entryPoints: ["tests/fixtures/plugin-updates/detail-browser.tsx"],
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
        setup(builder) {
          builder.onResolve(
            { filter: /^(react|react-dom)(\/.*)?$/ },
            (args) => ({ path: require.resolve(args.path) }),
          );
          const sources = {
            "@deepseek-ai/dsh-client-ui-primitives":
              "packages/client/ui-primitives/src/index.ts",
            "@deepseek-ai/dsh-client-ui-renderer/client":
              "packages/client/ui-renderer/src/client/index.ts",
            "@deepseek-ai/dsh-client-locale/client":
              "packages/client/locale/src/client/index.ts",
          };
          builder.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
            sources[args.path]
              ? { path: join(sdk, sources[args.path]) }
              : undefined,
          );
        },
      },
    ],
  });
  let revision = 1,
    phase = "available",
    checks = 0,
    updates = 0,
    statuses = 0,
    holdCheck = false,
    checkAborted = false,
    updateAborted = false;
  const status = () => ({
    revision: revision++,
    hostProcessIdentity: "fixture-host",
    challenge: "fixture-nonce",
    checkTimeoutMs: 5000,
    pollIntervalMs: 1000,
    items: names.map((packageName) => ({
      packageName,
      state: phase,
      installedVersion: "1.2.3",
      runningHostVersion: "1.2.2",
      runningClientVersion: "1.2.3",
      candidateVersion: "1.2.4",
      planId: "plan-one",
      diagnostic: "/private/secret-credential",
      ...(phase === "check-failed"
        ? { problem: { kind: "source", code: "signature" } }
        : {}),
    })),
  });
  const server = createServer(async (req, res) => {
    const url = req.url;
    if (url.startsWith("/api/gea/plugin-updates/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (url.endsWith("/status")) {
        statuses++;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, value: status() }));
        return;
      }
      if (url.endsWith("/check")) {
        checks++;
        if (holdCheck) {
          res.on("close", () => {
            checkAborted = true;
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (url.endsWith("/update")) {
        updates++;
        assert.deepEqual(JSON.parse(body), {
          packageName: names[2],
          planId: "plan-one",
        });
        phase = "installing";
        res.on("close", () => {
          if (!res.writableEnded) updateAborted = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, value: {} }));
      return;
    }
    if (url === "/app.js" || url === "/app.css") {
      res.setHeader(
        "content-type",
        url.endsWith("css") ? "text/css" : "text/javascript",
      );
      res.end(await readFile(join(root, url.slice(1))));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      '<style>body{font-family:var(--dsw-font-family);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);margin:32px}main{max-width:760px;margin:auto;display:flex;flex-direction:column;align-items:flex-start;gap:20px}section{width:100%}</style><div id="app"></div><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script>',
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
  const page = await browser.newPage({ locale: "en-US" });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .waitFor()
    .catch(async (error) => {
      console.error({ errors, html: await page.locator("body").innerHTML() });
      throw error;
    });
  await page
    .getByRole("button", { name: "Update to 1.2.4", exact: true })
    .waitFor();
  if (process.env.GEA_DETAIL_SCREENSHOT)
    await page.screenshot({
      path: process.env.GEA_DETAIL_SCREENSHOT + "-available.png",
    });
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .dblclick();
  await page.waitForTimeout(200);
  assert.equal(checks, 1);
  await page
    .getByRole("button", { name: "Update to 1.2.4", exact: true })
    .click();
  while (updates !== 1) await new Promise((resolve) => setTimeout(resolve, 1));
  await page.evaluate(() => window.fixture.close());
  await page.waitForTimeout(200);
  assert.equal(updateAborted, false);
  await page.evaluate(() => window.fixture.open());
  await page.getByText("Installing", { exact: true }).first().waitFor();
  assert.equal(updates, 1);
  phase = "pending-restart";
  await page.getByText("Restart required", { exact: true }).first().waitFor();
  assert.match(await page.locator("main").textContent(), /1.2.2/);
  await page.evaluate(() => window.fixture.close());
  const count = statuses;
  await page.waitForTimeout(1200);
  assert.equal(statuses, count);
  await page.evaluate(() => window.fixture.open());
  await page.getByText("Restart required", { exact: true }).first().waitFor();
  for (const name of names) {
    await page.evaluate(
      (pkg) => window.fixture.subject({ kind: "bundle", pkg }),
      pkg(name),
    );
    await page
      .getByRole("button", { name: "Check for updates", exact: true })
      .waitFor();
  }
  for (const subject of [
    { kind: "bundle", pkg: pkg("other") },
    {
      kind: "row",
      pkg: pkg(names[0]),
      row: { rowId: "x", moduleName: "x", enabled: true },
    },
    { kind: "item", id: "x" },
  ]) {
    await page.evaluate((subject) => window.fixture.subject(subject), subject);
    assert.equal(await page.locator("main").textContent(), "");
  }
  await page.evaluate(
    (pkg) => window.fixture.subject({ kind: "bundle", pkg }),
    pkg(names[2]),
  );
  await page.evaluate(() => window.fixture.locale("zh"));
  await page.getByRole("button", { name: "检查更新", exact: true }).waitFor();
  if (process.env.GEA_DETAIL_SCREENSHOT) {
    await page.screenshot({
      path: process.env.GEA_DETAIL_SCREENSHOT + "-desktop.png",
    });
    await page.setViewportSize({ width: 390, height: 640 });
    await page.screenshot({
      path: process.env.GEA_DETAIL_SCREENSHOT + "-mobile.png",
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
  }
  await page.evaluate(() => window.fixture.locale("en"));
  phase = "check-failed";
  await page
    .getByRole("alert")
    .filter({ hasText: "The update source could not be verified." })
    .waitFor();
  assert.doesNotMatch(
    await page.locator("main").textContent(),
    /private|secret-credential/,
  );
  phase = "unknown";
  await page
    .getByRole("alert")
    .filter({ hasText: "The update result is unknown." })
    .waitFor();
  phase = "available";
  await page
    .getByRole("button", { name: "Update to 1.2.4", exact: true })
    .waitFor();
  holdCheck = true;
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  while (checks !== 2) await new Promise((resolve) => setTimeout(resolve, 1));
  await page.evaluate(() => window.fixture.close());
  for (let i = 0; i < 100 && !checkAborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(checkAborted, true);
  holdCheck = false;
  await page.evaluate(() => window.fixture.open());
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .waitFor();
  await page.evaluate(() => window.fixture.dispose());
  await page.waitForTimeout(20);
  assert.equal(await page.locator("main").textContent(), "");
  assert.deepEqual(errors, []);
});
