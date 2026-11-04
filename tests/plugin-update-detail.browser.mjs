import test from "node:test";
import { sourceTools } from "./fixtures/plugin-updates/source-tools.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { clientBuildOptions } from "../scripts/client-build.mjs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk) throw Error("GEA_PLUGIN_UPDATE_SDK required");
const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
];
const pkg = (name) => ({ name, version: "1.2.3", installed: true, enabled: true, rows: [] });

test("official detail diagnostics navigate to the shared update panel", async (t) => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".runtime/detail-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clientOptions = clientBuildOptions(join(root, "gea-client.js"));
  await build({ ...clientOptions, plugins: [...sourceTools(sdk), ...clientOptions.plugins] });
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
      ...sourceTools(sdk),
      {
        name: "official-source",
        setup(builder) {
          builder.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => ({
            path: require.resolve(args.path),
          }));
          const sources = {
            "@deepseek-ai/dsh-client-ui-primitives": "packages/client/ui-primitives/src/index.ts",
            "@deepseek-ai/dsh-client-ui-renderer/client":
              "packages/client/ui-renderer/src/client/index.ts",
            "@deepseek-ai/dsh-client-locale/client": "packages/client/locale/src/client/index.ts",
          };
          builder.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
            sources[args.path] ? { path: join(sdk, sources[args.path]) } : undefined,
          );
        },
      },
    ],
  });
  let revision = 1,
    phase = "available",
    checks = 0,
    updates = 0,
    sourceMissing = false,
    problem,
    companyUpdate = null,
    prepared = 0;
  const status = () => ({
    revision: revision++,
    hostProcessIdentity: "fixture-host",
    challenge: "fixture-nonce",
    checkTimeoutMs: 30000,
    pollIntervalMs: 1000,
    companyUpdate,
    items: names.map((packageName) => ({
      packageName,
      state: phase,
      installedVersion: sourceMissing ? null : "1.2.3",
      runningHostVersion: sourceMissing ? null : "1.2.2",
      runningClientVersion: sourceMissing ? null : "1.2.3",
      candidateVersion: sourceMissing ? null : "1.2.4",
      planId: sourceMissing ? null : "plan-one",
      diagnostic: "/private/secret-credential",
      ...(phase === "check-failed" ? { problem: { kind: "source", code: "signature" } } : {}),
      ...(sourceMissing ? { problem: { kind: "policy", code: "source-not-configured" } } : {}),
      ...(problem ? { problem } : {}),
    })),
  });
  const server = createServer(async (req, res) => {
    const url = req.url;
    if (url.startsWith("/api/gea/plugin-updates/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (url.endsWith("/status")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, value: status() }));
        return;
      }
      if (url.endsWith("/check")) {
        checks++;
        if (sourceMissing) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: { code: "UPDATE_SOURCE_NOT_CONFIGURED" } }));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (url.endsWith("/company-prepare")) {
        assert.deepEqual(JSON.parse(body), { desktopVersion: "0.2.0-rc.2.20261105.1" });
        prepared++;
        companyUpdate = { phase: "prepared", desktopVersion: "0.2.0-rc.2.20261105.1" };
      }
      if (url.endsWith("/company-cancel")) companyUpdate = { ...companyUpdate, phase: "cancelled" };
      if (url.endsWith("/update-all")) {
        updates++;
        assert.deepEqual(JSON.parse(body), {
          plans: names.map((packageName) => ({ packageName, planId: "plan-one" })),
        });
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, value: {} }));
      return;
    }
    if (url === "/gea-client.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(await readFile(join(root, "gea-client.js")));
      return;
    }
    if (url === "/app.js" || url === "/app.css") {
      res.setHeader("content-type", url.endsWith("css") ? "text/css" : "text/javascript");
      res.end(await readFile(join(root, url.slice(1))));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      '<style>body{font-family:var(--dsw-font-family);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);margin:32px}main{max-width:760px;margin:auto;display:flex;flex-direction:column;align-items:flex-start;gap:20px}section{width:100%}</style><div id="app"></div><link rel="stylesheet" href="/app.css"><script>window.__ModuleLoader__={load(entry){window.geaFactory=entry.factory}}</script><script src="/gea-client.js"></script><script type="module" src="/app.js"></script>',
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
  await page.addInitScript(() => {
    window.nativeUpdateCalls = [];
    window.dshDesktop = {
      protocolVersion: 1,
      appVersion: async () => "0.2.0-rc.2.20261104.1",
      updates: {
        status: async () => ({ phase: "idle" }),
        subscribe: () => () => {},
        check: async () => {
          window.nativeUpdateCalls.push("check");
          return { phase: "available", version: "0.2.0-rc.2.20261105.1" };
        },
        open: async () => {
          window.nativeUpdateCalls.push("open");
        },
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: "View update status", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Check for updates", exact: true }).count(),
    0,
  );
  assert.match(await page.locator("main").textContent(), /1.2.2/);
  const packageVersion = await page.evaluate(() => window.fixture.packageVersion);
  const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(packageVersion, {
    value: { name: packageManifest.name, version: packageManifest.version },
    frozen: true,
  });
  for (const subject of [
    { kind: "bundle", pkg: pkg("other") },
    { kind: "item", id: "x" },
  ]) {
    await page.evaluate((subject) => window.fixture.subject(subject), subject);
    assert.equal(await page.locator("main").textContent(), "");
  }
  await page.evaluate((pkg) => window.fixture.subject({ kind: "bundle", pkg }), pkg(names[2]));
  phase = "check-failed";
  await page
    .getByRole("alert")
    .filter({ hasText: "The update source could not be verified." })
    .waitFor();
  assert.doesNotMatch(await page.locator("main").textContent(), /private|secret-credential/);
  phase = "blocked";
  problem = {
    kind: "dependencies",
    requirements: [
      {
        consumer: "dsh-agent-manage",
        dependency: names[2],
        required: "1.2.3",
        installed: "1.2.4",
        current: "1.2.3",
        candidate: "1.2.4",
        path: "/private/secret-credential",
      },
    ],
  };
  await page
    .getByRole("alert")
    .filter({ hasText: "The installed plugin versions are incompatible with this update." })
    .waitFor();
  const requirement = page.locator(".gea-plugin-update-requirements");
  await requirement.getByText("dsh-agent-manage", { exact: true }).waitFor();
  assert.equal(await requirement.getByText(names[2], { exact: true }).count(), 1);
  for (const label of [
    "Required version",
    "Current dependency version",
    "Candidate dependency version",
  ])
    assert.equal(await requirement.getByText(label, { exact: true }).count(), 1);
  assert.match(await requirement.textContent(), /1.2.3.*1.2.3.*1.2.4/);
  await page
    .getByText(
      "Keep the installed versions. Check the listed requirements and wait for a compatible release before checking again.",
      { exact: true },
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Update all", exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "View update status", exact: true }).isEnabled(),
    true,
  );
  await page.evaluate(() => window.fixture.locale("zh"));
  await requirement.getByText("当前依赖版本", { exact: true }).waitFor();
  await page
    .getByText("请保留已安装版本，核对所列依赖要求，等待兼容版本发布后重新检查。", { exact: true })
    .waitFor();
  assert.doesNotMatch(await page.locator("main").textContent(), /private|secret-credential/);
  if (process.env.GEA_DETAIL_SCREENSHOT) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: process.env.GEA_DETAIL_SCREENSHOT + "-blocked-desktop.png" });
    await page.setViewportSize({ width: 390, height: 840 });
    await page.screenshot({ path: process.env.GEA_DETAIL_SCREENSHOT + "-blocked-mobile.png" });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.evaluate(() => window.fixture.locale("en"));
  const singleRequirement = problem.requirements[0];
  problem = {
    ...problem,
    requirements: Array.from({ length: 18 }, (_, index) => ({
      ...singleRequirement,
      consumer: `@fixture/consumer-${index}-${"long-package-name-".repeat(6)}`,
    })),
  };
  await requirement.getByText(problem.requirements.at(-1).consumer, { exact: true }).waitFor();
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    const bounds = await requirement.evaluate((element) => ({
      height: element.clientHeight,
      contentHeight: element.scrollHeight,
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
      overflow: getComputedStyle(element).overflowY,
    }));
    assert.ok(bounds.height <= Math.min(320, viewport.height * 0.4), JSON.stringify(bounds));
    assert.ok(bounds.contentHeight > bounds.height);
    assert.equal(bounds.overflow, "auto");
    assert.ok(bounds.contentWidth <= bounds.width);
    await requirement.evaluate((element) => {
      element.scrollTop = 0;
    });
    await requirement.press("PageDown");
    await page.waitForFunction(() => {
      const element = document.querySelector(".gea-plugin-update-requirements");
      return element.scrollTop > 0;
    });
    await requirement
      .getByText(problem.requirements.at(-1).consumer, { exact: true })
      .scrollIntoViewIfNeeded();
    assert.equal(await page.getByRole("button", { name: "Update all", exact: true }).count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "View update status", exact: true }).isEnabled(),
      true,
    );
    if (process.env.GEA_DETAIL_SCREENSHOT)
      await page.screenshot({
        path: `${process.env.GEA_DETAIL_SCREENSHOT}-many-${viewport.width}.png`,
      });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  problem = { ...problem, requirements: [singleRequirement] };
  await requirement.getByText(singleRequirement.consumer, { exact: true }).waitFor();
  problem = {
    ...problem,
    nextStep: { packageName: "@cleverc2200/dsh-agent-workbench", version: "1.2.4" },
  };
  await page
    .getByText(
      "First update @cleverc2200/dsh-agent-workbench to 1.2.4. When installation finishes, restart the application and check for updates again.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page
      .getByText(
        "Keep the installed versions. Check the listed requirements and wait for a compatible release before checking again.",
        { exact: true },
      )
      .count(),
    0,
  );
  assert.equal(await page.getByRole("button", { name: "Update all", exact: true }).count(), 0);
  await page.evaluate(() => window.fixture.locale("zh"));
  await page
    .getByText(
      "请先将 @cleverc2200/dsh-agent-workbench 更新至 1.2.4，安装完成后重启应用，再次检查更新。",
      { exact: true },
    )
    .waitFor();
  if (process.env.GEA_DETAIL_SCREENSHOT) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: process.env.GEA_DETAIL_SCREENSHOT + "-next-step-desktop.png" });
    await page.setViewportSize({ width: 390, height: 840 });
    await page.screenshot({ path: process.env.GEA_DETAIL_SCREENSHOT + "-next-step-mobile.png" });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.evaluate(() => window.fixture.locale("en"));
  for (const [code, english, chinese] of [
    [
      "channel-older",
      "The channel version is older than the installed version. Keep the installed version and check again after a newer release is published.",
      "频道版本早于已安装版本。请保留已安装版本，等待较新版本发布后重新检查。",
    ],
    [
      "content-mismatch",
      "The channel contains different content for the same version. Keep the installed version and ask the publisher to release a new version.",
      "频道中相同版本的内容不一致。请保留已安装版本，并联系发布者发布新版本。",
    ],
  ]) {
    problem = { kind: "policy", code };
    await page.getByRole("alert").filter({ hasText: english }).waitFor();
    assert.equal(
      await page.locator(".gea-plugin-update-versions dd").nth(3).textContent(),
      "1.2.4",
    );
    assert.equal(await page.getByRole("button", { name: "Update all", exact: true }).count(), 0);
    await page.evaluate(() => window.fixture.locale("zh"));
    await page.getByRole("alert").filter({ hasText: chinese }).waitFor();
    await page.evaluate(() => window.fixture.locale("en"));
  }
  problem = undefined;
  phase = "unknown";
  await page.getByRole("alert").filter({ hasText: "The update result is unknown." }).waitFor();
  sourceMissing = true;
  phase = "blocked";
  await page
    .getByRole("alert")
    .filter({ hasText: "Updates are not configured for this installation." })
    .waitFor();
  assert.equal(await page.locator(".gea-plugin-update-versions dd").first().textContent(), "1.2.3");
  await page.evaluate(() => window.fixture.locale("zh"));
  await page.getByRole("button", { name: "查看更新状态", exact: true }).click();
  const panel = page.locator("[data-update-panel]");
  await panel.getByRole("heading", { name: "客户端", exact: true }).waitFor();
  await panel.getByRole("heading", { name: "公司插件", exact: true }).waitFor();
  assert.equal(checks, 0);
  assert.equal(updates, 0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 840 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  assert.equal(prepared, 0);
  assert.deepEqual(await page.evaluate(() => window.nativeUpdateCalls), []);
  sourceMissing = false;
  phase = "available";
  await panel.getByRole("button", { name: "检查客户端更新", exact: true }).click();
  await panel.getByText(/已为客户端 0.2.0-rc.2.20261105.1 缓存插件/).waitFor();
  assert.equal(prepared, 1);
  assert.deepEqual(await page.evaluate(() => window.nativeUpdateCalls), ["check", "open"]);
  assert.equal(updates, 0);
  assert.equal(await panel.getByRole("button", { name: "更新全部", exact: true }).count(), 0);
  await mkdir(".runtime/detail-summary", { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 840 });
    await page.screenshot({ path: `.runtime/detail-summary/company-update-${width}.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  await panel.getByRole("button", { name: "取消已准备的更新", exact: true }).click();
  await panel.getByText(/已为客户端 .* 缓存插件/).waitFor({ state: "hidden" });
  await page.evaluate(() => window.fixture.dispose());
  assert.deepEqual(errors, []);
});
