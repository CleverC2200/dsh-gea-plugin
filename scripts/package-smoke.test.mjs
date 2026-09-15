import { chromium } from "@playwright/test";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { profile, readSession, until } from "../tests/profile.mjs";

test(
  "allowlisted package installs into an empty directory and starts a published DSH profile without AionUi",
  { timeout: 180000 },
  async (t) => {
    const root = resolve(import.meta.dirname, "..");
    const packed = JSON.parse(
      execFileSync(process.execPath, ["scripts/package.mjs"], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    const dir = await mkdtemp(resolve(tmpdir(), "gea-package-"));
    let app;
    t.after(async () => { await app?.stop(); await rm(dir, { recursive: true, force: true }); });
    execFileSync("tar", [
      "-xzf",
      packed.artifact,
      "--strip-components=1",
      "-C",
      dir,
    ]);
    execFileSync(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: dir, timeout: 120000, stdio: "pipe" },
    );
    app = await profile(t, {
      pluginRoot: dir,
      bundle: true,
      config: () => ({
        analysis: {
          mode: "model",
          source: "gea",
          agentCode: "sales_forecast",
          model: "package-model",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { DSH_SOURCE_DIR: "/nonexistent/fork-must-not-be-used" },
    });
    const plan = {
      planId: "9007199254740993",
      versionId: "version-1",
      seq: 1,
      periodId: "period-1",
      planTypeCode: "Y",
      status: 5,
      dealerCode: "dealer-a",
      baseName: "华东",
      orgName: "上海",
      orgCode: "org-a",
      provinceName: "浙江",
      provinceCode: "province-a",
      currentQty: "1.2300",
      targetQty: "2.3400",
      currentAmount: "10.10",
      targetAmount: "12.30",
    };
    let inference = 0;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith("/plans")) {
        reply({
          success: true,
          result: { records: [plan], total: 1, current: 1, size: 10, pages: 1 },
        });
        return true;
      }
      if (path.endsWith("/plans/" + plan.planId)) {
        reply({
          success: true,
          result: {
            currentVersion: { ...plan, id: plan.versionId, effective: true },
            skus: [],
            versions: [{ ...plan, id: plan.versionId }],
            logs: [],
          },
        });
        return true;
      }
      if (path.endsWith("/user-agent-credential/my/list")) {
        reply({
          success: true,
          result: {
            records: [{ id: "credential", status: "ACTIVE" }],
            total: 1,
          },
        });
        return true;
      }
      if (path.endsWith("/user-agent-credential/my/claim")) {
        reply({
          success: true,
          result: {
            credentialId: "credential",
            status: "ACTIVE",
            baseUrl: app.base + "/personal",
            secret: "package-fixture-secret",
          },
        });
        return true;
      }
      if (path === "/personal/models") {
        reply({ data: [{ id: "package-model", name: "Package model" }] });
        return true;
      }
      if (path !== "/personal/chat/completions") return false;
      inference++;
      assert.equal(req.headers.authorization, "Bearer package-fixture-secret");
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "独立安装 GEA 模型回执" },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\n",
      );
      return true;
    });
    assert.equal((await app.login()).ok, true);
    assert.equal(
      (await app.rpc("model/discover")).value.selectedName,
      "Package model",
    );
    const page = (await app.rpc("plans")).value;
    const preview = (
      await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      })
    ).value;
    const sent = await app.rpc("submit", { previewId: preview.previewId });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const rows = await until(
      () => readSession(app.runtime, sent.value.sessionId),
      (x) => x.some((r) => r.type === "turn/end"),
    );
    assert.equal(
      rows.find((x) => x.type === "turn/end").data.reason.kind,
      "completed",
    );
    assert.ok(JSON.stringify(rows).includes(preview.snapshotHash));
    assert.equal(inference, 1);
    assert.ok(JSON.stringify(rows).includes("独立安装 GEA 模型回执"));
    assert.equal(
      JSON.stringify(rows).includes("package-fixture-secret"),
      false,
    );
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((c) => ({
        name: c.slice(0, c.indexOf("=")),
        value: c.slice(c.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const ui = await context.newPage();
    const errors = [];
    ui.on("pageerror", (error) => errors.push(error.message));
    ui.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await ui.goto(app.origin);
    await ui.getByRole("dialog", { name: "内测声明", exact: true }).getByRole("button", { name: "继续", exact: true }).click();
    await ui
      .frameLocator("iframe[data-gea-workbench]")
      .getByRole("heading", { name: "销售计划审批", exact: true })
      .waitFor({ timeout: 10000 })
      .catch(async (error) => {
        console.error(
          JSON.stringify({
            errors,
            body: await ui.locator("body").innerText(),
            frames: ui.frames().map((frame) => frame.url().replace(/\?.*/, "")),
          }),
        );
        throw error;
      });
    const composer = ui.locator('[contenteditable="true"]');
    await composer.waitFor({ timeout: 15000 });
    await composer.fill("独立安装包继续分析");
    await composer.press("Enter");
    await ui
      .getByText("独立安装 GEA 模型回执", { exact: true })
      .first()
      .waitFor();
    await ui.locator('[contenteditable="true"]').waitFor({ timeout: 15000 });
    assert.equal(await ui.locator('[contenteditable="true"]').count(), 1);
    assert.deepEqual(errors, []);
    await browser.close();
    await app.stop();
    await app.start();
    assert.equal((await app.rpc("status")).value.authenticated, false);
    assert.deepEqual(
      await readSession(app.runtime, sent.value.sessionId),
      rows,
    );
  },
);
