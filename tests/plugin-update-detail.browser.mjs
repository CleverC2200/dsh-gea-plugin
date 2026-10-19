import test from "node:test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
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
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Expected HTTP fixture request within 5 seconds");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("official detail slots check, update, close and reenter through controlled HTTP", async (t) => {
  execFileSync(process.execPath, ["scripts/build.mjs", "--target", "client"], { stdio: "pipe" });
  await mkdir(".runtime", { recursive: true });
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
    statuses = 0,
    holdCheck = false,
    sourceMissing = false,
    problem,
    checkAborted = false,
    updateAborted = false,
    updateResponded = false,
    releaseUpdate;
  const status = () => ({
    revision: revision++,
    hostProcessIdentity: "fixture-host",
    challenge: "fixture-nonce",
    checkTimeoutMs: 30000,
    pollIntervalMs: 1000,
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
        statuses++;
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
        res.on("close", () => {
          if (!res.writableEnded) updateAborted = true;
        });
        await new Promise((resolve) => {
          releaseUpdate = resolve;
        });
        updateResponded = true;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, value: {} }));
      return;
    }
    if (url === "/gea-client.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(await readFile("lib/client.js"));
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
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .waitFor()
    .catch(async (error) => {
      console.error({ errors, html: await page.locator("body").innerHTML() });
      throw error;
    });
  await page.getByRole("button", { name: "Update to 1.2.4", exact: true }).waitFor();
  const packageVersion = await page.evaluate(() => window.fixture.packageVersion);
  const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.deepEqual(packageVersion, {
    value: { name: packageManifest.name, version: packageManifest.version },
    frozen: true,
  });
  assert.equal(
    await page
      .locator(".gea-plugin-update-actions")
      .evaluate((node) => getComputedStyle(node).display),
    "flex",
  );
  assert.equal(
    await page
      .locator(".gea-plugin-update-versions")
      .evaluate((node) => getComputedStyle(node).display),
    "grid",
  );
  if (process.env.GEA_DETAIL_SCREENSHOT)
    await page.screenshot({
      path: process.env.GEA_DETAIL_SCREENSHOT + "-available.png",
    });
  await page.getByRole("button", { name: "Check for updates", exact: true }).dblclick();
  await page.waitForTimeout(200);
  assert.equal(checks, 1);
  await page.getByRole("button", { name: "Update to 1.2.4", exact: true }).click();
  await until(() => updates === 1);
  await page.getByText("Submitting update", { exact: true }).waitFor();
  assert.equal(await page.getByText("Update accepted", { exact: true }).count(), 0);
  await page.evaluate(() => window.fixture.locale("zh"));
  await page.getByText("正在提交更新", { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.locale("en"));
  phase = "downloading";
  await page.getByText("Downloading", { exact: true }).waitFor();
  assert.equal(await page.getByText("Update accepted", { exact: true }).count(), 0);
  // Controlled status samples verify display precedence, independently of Host transitions.
  for (const [next, label] of [
    ["waiting-lock", "Waiting for other plugin changes"],
    ["snapshotting", "Backing up"],
    ["check-failed", "Check failed"],
    ["blocked", "Update unavailable"],
    ["failed", "Update failed"],
    ["unknown", "Result unknown"],
    ["accepted", "Update accepted"],
    ["installing", "Installing"],
    ["pending-restart", "Restart required"],
  ]) {
    phase = next;
    await page.getByText(label, { exact: true }).first().waitFor();
    assert.equal(typeof releaseUpdate, "function");
    assert.equal(updateResponded, false);
    t.diagnostic(`Observed Host ${next} while the update response remained pending`);
    assert.equal(updateAborted, false);
  }
  await page.evaluate(() => window.fixture.close());
  assert.equal(updateAborted, false);
  releaseUpdate();
  await page.waitForTimeout(200);
  assert.equal(updateAborted, false);
  await page.evaluate(() => window.fixture.open());
  await page.getByText("Restart required", { exact: true }).first().waitFor();
  assert.equal(updates, 1);
  assert.match(await page.locator("main").textContent(), /1.2.2/);
  await page.evaluate(() => window.fixture.close());
  const count = statuses;
  await page.waitForTimeout(1200);
  assert.equal(statuses, count);
  await page.evaluate(() => window.fixture.open());
  await page.getByText("Restart required", { exact: true }).first().waitFor();
  for (const name of names) {
    await page.evaluate((pkg) => window.fixture.subject({ kind: "bundle", pkg }), pkg(name));
    await page.getByRole("button", { name: "Check for updates", exact: true }).waitFor();
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
  await page.evaluate((pkg) => window.fixture.subject({ kind: "bundle", pkg }), pkg(names[2]));
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
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
  }
  await page.evaluate(() => window.fixture.locale("en"));
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
  assert.equal(await page.getByRole("button", { name: "Update to 1.2.4", exact: true }).count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Check for updates", exact: true }).isEnabled(),
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
    assert.equal(
      await page.getByRole("button", { name: "Update to 1.2.4", exact: true }).count(),
      0,
    );
    await page.evaluate(() => window.fixture.locale("zh"));
    await page.getByRole("alert").filter({ hasText: chinese }).waitFor();
    await page.evaluate(() => window.fixture.locale("en"));
  }
  problem = undefined;
  phase = "unknown";
  await page.getByRole("alert").filter({ hasText: "The update result is unknown." }).waitFor();
  phase = "available";
  await page.getByRole("button", { name: "Update to 1.2.4", exact: true }).waitFor();
  holdCheck = true;
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await until(() => checks === 2);
  await page.evaluate(() => window.fixture.close());
  for (let i = 0; i < 100 && !checkAborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(checkAborted, true);
  holdCheck = false;
  await page.evaluate(() => window.fixture.open());
  await page.getByRole("button", { name: "Check for updates", exact: true }).waitFor();
  sourceMissing = true;
  phase = "blocked";
  await page
    .getByRole("alert")
    .filter({ hasText: "Updates are not configured for this installation." })
    .waitFor();
  assert.equal(await page.locator(".gea-plugin-update-versions dd").first().textContent(), "1.2.3");
  await page.getByRole("button", { name: "Check for updates", exact: true }).click();
  await until(() => checks === 3);
  await page.waitForTimeout(50);
  await page
    .getByRole("alert")
    .filter({ hasText: "Updates are not configured for this installation." })
    .waitFor();
  assert.equal(
    await page.getByText("Could not check for updates. Try again.", { exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.fixture.locale("zh"));
  await page.getByRole("alert").filter({ hasText: "当前安装尚未配置更新来源。" }).waitFor();
  assert.doesNotMatch(await page.locator("main").textContent(), /private|secret-credential/);
  await page.evaluate(() => window.fixture.dispose());
  await page.waitForTimeout(20);
  assert.equal(await page.locator("main").textContent(), "");
  assert.deepEqual(errors, []);
});
