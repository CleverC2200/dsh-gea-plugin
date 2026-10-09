import { currentHtmlResource } from "./fixtures/html-resource.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profile } from "./profile.mjs";
import {
  openSalesPlan,
  openWorkbenchPage,
  htmlFrameElement,
  prepareWorkbenchHtmlRoots,
} from "./fixtures/business-page.mjs";

async function enableSelection(page) {
  const button = page.locator("[data-page-selection-trigger]");
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
}

test(
  "React table selection enters the native composer and can drive the existing page action",
  { timeout: 120000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          source: "direct",
          baseUrl: base + "/v1",
          model: "fixture-model",
          apiKeyEnv: "GEA_PICKER_TEST_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_PICKER_TEST_KEY: "fixture-key" },
    });
    const plan = {
      planId: "p",
      versionId: "v",
      seq: 1,
      periodId: "period-1",
      planTypeCode: "Y",
      orderType: "M",
      dealerCode: "d",
      dealerName: "客户A",
      orgCode: "org",
      orgName: "宝阳销售组",
      provinceCode: "province",
      provinceName: "华南省区",
      areaCode: "area",
      areaName: "华南大区",
      status: 1,
      currentQty: "20",
      currentAmount: "200",
      targetQty: "40",
      targetAmount: "400",
      skuCount: 1,
    };
    const sku = {
      id: "s",
      skuCode: "1001",
      versionId: "v",
      productCategName: "汤圆",
      materialDescription: "黑芝麻汤圆 500g",
      qty: "20",
      baseQty: "10",
      amt: "200",
      amtBase: "100",
      price: "10",
    };
    const prompts = [];
    let actionIssued = false;
    const readReferences = new Set();
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path === "/v1/chat/completions") {
        const body = JSON.parse(req.body);
        prompts.push(body);
        const wantsAction = JSON.stringify(body.messages).includes("展开引用的这一行");
        const referenceId = JSON.stringify(body.messages.filter((m) => m.role === "user"))
          .match(/R[a-f0-9]{12}/g)
          ?.at(-1);
        const reading = referenceId && !readReferences.has(referenceId);
        if (reading) readReferences.add(referenceId);
        const tool = reading || (wantsAction && !actionIssued);
        if (tool && !reading) actionIssued = true;
        const delta = tool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "pick-action",
                  type: "function",
                  function: {
                    name: reading ? "page_reference_read" : "gea_workbench_apply",
                    arguments: JSON.stringify(
                      reading
                        ? { id: referenceId }
                        : { kind: "invoke", target: "row:p", action: "expand" },
                    ),
                  },
                },
              ],
            }
          : {
              content: wantsAction ? "已展开引用的这一行。" : "已收到选中的计划内容。",
            };
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              choices: [{ index: 0, delta, finish_reason: null }],
            }) +
            "\n\ndata: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: tool ? "tool_calls" : "stop",
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return true;
      }
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:region-approve"] });
      if (path.endsWith("/plans"))
        return send({
          records: [plan],
          total: 1,
          pages: 1,
          current: 1,
          size: 20,
        });
      if (path.endsWith("/plans/p"))
        return send({
          currentVersion: { ...plan, id: "v", effective: true },
          skus: [sku],
          versions: [],
          logs: [],
          actionContext: {
            versionId: "v",
            status: 1,
            nodeOrder: 2,
            allowedActions: ["APPROVE", "REJECT"],
            snapshotHash: "a".repeat(64),
          },
        });
      if (path.endsWith("/versions")) return send([{ ...plan, id: "v", effective: true }]);
      if (path.endsWith("/skus")) return send([sku]);
      return false;
    });
    await app.login();
    const browser = await chromium.launch({
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (/violates.*Content Security Policy/i.test(m.text())) errors.push(m.text());
    });
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = await openSalesPlan(page);
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    const target = frame.getByTestId("regional-approval-month-plan-p");
    await expect(target).toBeVisible();
    await enableSelection(page);
    await target.hover();
    await expect(frame.locator(".dspi-outline")).toBeVisible();
    await expect(frame.locator(".dspi-panel, .dspi-levels")).toHaveCount(0);
    await mkdir(".runtime/page-interaction", { recursive: true });
    if (process.env.GEA_PICKER_VISUAL)
      await page.screenshot({
        path: ".runtime/page-interaction/selection-desktop.png",
      });
    await target.click();
    await expect(frame.getByRole("status").filter({ hasText: "已加入输入框" })).toBeVisible();
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("计划");
    const draftLabel = (await editor.innerText()).trim();
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("解释引用的这个金额");
    await page.keyboard.press("Enter");
    await expect.poll(() => prompts.length).toBeGreaterThan(0);
    const sent = JSON.stringify(prompts[0].messages.filter((m) => m.role === "user"));
    assert.match(sent, /dsh-page:R[a-f0-9]{12}/);
    assert.equal(sent.includes("row:p"), false);
    assert.equal(sent.includes("月度目标："), false);
    assert.match(sent, /解释引用/);
    await expect(page.getByText("已收到选中的计划内容。", { exact: true })).toBeVisible();
    const message = page.locator('[data-chat-flow-kind="user"]').first();
    await expect(message).toContainText(draftLabel);
    await expect(message).not.toContainText("dsh-page:");
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: app.origin,
    });
    await message.getByRole("button", { name: "复制", exact: true }).click();
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /dsh-page:R[a-f0-9]{12}/,
    );
    assert.equal(/R[a-f0-9]{12}/.test(await message.innerText()), false);
    assert.ok(
      await page.evaluate(
        (label) =>
          [...CSS.highlights.get("dsh-page-reference")].some((range) => range.toString() === label),
        draftLabel,
      ),
    );
    assert.match(
      JSON.stringify(prompts.flatMap((p) => p.messages.filter((m) => m.role === "tool"))),
      /row:p/,
    );
    await enableSelection(page);
    await target.click();
    await expect(frame.getByRole("status").filter({ hasText: "已加入输入框" })).toBeVisible();
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("展开引用的这一行");
    await page.keyboard.press("Enter");
    await expect(frame.getByText("黑芝麻汤圆 500g", { exact: true })).toBeVisible();
    await expect(page.getByText("已展开引用的这一行。", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-page-selection-trigger]")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await frame.getByRole("switch").first().click();
    const category = frame.locator('tr[data-page-label*="汤圆"]').first();
    await expect(category).toBeVisible();
    await enableSelection(page);
    await category.locator("td").nth(2).click();
    await expect(editor).toContainText("汤圆");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1024, height: 768 });
    if (process.env.GEA_PICKER_VISUAL)
      await page.screenshot({
        path: ".runtime/page-interaction/quote-narrow.png",
      });
    assert.deepEqual(errors, []);
  },
);

test(
  "opaque HTML frame quotes local content under the existing CSP without triggering its button",
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "gea-picker-html-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "skills/probe"), { recursive: true });
    await writeFile(
      join(root, "skills/probe/SKILL.md"),
      "---\nname: inventory-fc\ndescription: 库存问答\n---\n根据页面引用回答库存问题。",
    );
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "inventory-fc",
        name: "分仓库存",
        version: "0.0.0",
        html: "index.html",
        skills: ["skills/probe/SKILL.md"],
        mcp: "mcp.json",
        gea: {
          consumerCode: "branch-inventory",
          readonly: true,
          contract: "gea-html-v2",
        },
      }),
    );
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        provider: "gea",
        transport: "host-provided",
        contract: "gea-html-v2",
        consumer: { consumerType: "AGENT", consumerCode: "branch-inventory" },
        capabilities: ["governed-sql-read"],
      }),
    );
    await writeFile(
      join(root, "index.html"),
      `<!doctype html><html lang="zh-CN"><head><title>分仓库存</title><style>body{font:14px sans-serif;padding:24px;color:#202531}table{border-collapse:collapse;width:80%}td,th{padding:16px;border:1px solid #ddd;text-align:left}</style></head><body><h1>分仓库存</h1><section aria-label="订单概览" style="padding:16px;margin-bottom:16px;border:1px solid #ddd"><span id="tiny-metric">待补货</span><strong>8笔订单</strong><label>区域<select><option value="east">华东</option><option value="south" selected>华南</option></select></label></section><table><thead><tr><th>客户</th><th>库存</th><th>动作</th></tr></thead><tbody><tr><td>客户甲</td><td id="stock-one" data-gea-el="readout:stock-one">120 件</td><td><button id="business" onclick="this.textContent='已执行'">查看库存</button></td></tr><tr><td>无关客户乙</td><td id="stock-two" data-gea-el="readout:stock-two">987654 件</td></tr><tr style="display:none" data-page-target="row:hidden"><td>隐藏客户</td><td>隐秘900件</td></tr><tr><td>客户甲</td><td id="stock-three" data-gea-el="readout:stock-three">250 件</td></tr></tbody></table><script>let pagePort,pageContext;window.publishCurrentCatalog=()=>{const elements=['stock-one','stock-two','stock-three'].map(id=>({id:'readout:'+id,role:'field',label:'库存',value:document.getElementById(id).textContent}));if(pagePort)pagePort.postMessage({type:'catalog',session:pageContext.session,elements});return elements;};addEventListener('message',event=>{if(event.data.protocol!=='gea-html-v2'||event.data.type!=='connect')return;pagePort=event.ports[0];pageContext=event.data.context;pagePort.start();window.publishCurrentCatalog();});parent.postMessage({protocol:'gea-html-v2',type:'ready'},'*')</script></body></html>`,
    );
    await currentHtmlResource(root);
    const app = await profile(t, {
      beforeStart: prepareWorkbenchHtmlRoots([root]),
      config: (base) => ({
        analysis: {
          mode: "model",
          source: "direct",
          baseUrl: base + "/v1",
          model: "fixture-model",
          apiKeyEnv: "GEA_PICKER_TEST_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: {
        GEA_PICKER_TEST_KEY: "fixture-key",
      },
    });
    const prompts = [];
    let readIssued = false;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/ai/gateway/session")) {
        const request = JSON.parse(req.body);
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            delegationToken: "fixture-delegation",
            gatewayContext: {
              sessionId: "fixture-session",
              conversationId: request.conversationId,
              consumerType: request.consumerType,
              consumerCode: request.consumerCode,
            },
          },
        });
        return true;
      }
      if (req.url.pathname !== "/v1/chat/completions") return false;
      const body = JSON.parse(req.body);
      prompts.push(body);
      const referenceId = JSON.stringify(body.messages.filter((m) => m.role === "user"))
        .match(/R[a-f0-9]{12}/g)
        ?.at(-1);
      const reading = !readIssued && Boolean(referenceId);
      if (reading) readIssued = true;
      res.setHeader("Content-Type", "text/event-stream");
      res.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: reading
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: "html-ref",
                          type: "function",
                          function: {
                            name: "page_reference_read",
                            arguments: JSON.stringify({ id: referenceId }),
                          },
                        },
                      ],
                    }
                  : { content: "客户甲库存为120件。" },
                finish_reason: reading ? "tool_calls" : "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return true;
    });
    await app.login();
    const browser = await chromium.launch({
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (/violates.*Content Security Policy/i.test(m.text())) errors.push(m.text());
    });
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    await openWorkbenchPage(page, "分仓库存");
    const iframe = htmlFrameElement(page, "inventory-fc");
    await expect(iframe)
      .toHaveAttribute("sandbox", "allow-scripts allow-downloads")
      .catch(async (e) => {
        throw Error(
          e.message +
            "\n" +
            (await page.locator("body").innerText()) +
            "\n" +
            app.output.slice(-6000),
        );
      });
    const frame = iframe.contentFrame();
    await expect(page.locator("[data-page-selection-trigger]")).toBeVisible();
    const keyboardEditor = page.locator('[contenteditable="true"]').first();
    const pickerButton = page.locator("[data-page-selection-trigger]");
    await expect(
      page.locator(".gea-conversation-toolbar [data-page-selection-trigger]"),
    ).toHaveCount(0);
    await expect(page.locator(".dspi-composer-trigger [data-page-selection-trigger]")).toHaveCount(
      1,
    );
    // Alt from the composer, then hover a cross-origin frame, releasing in the parent.
    await keyboardEditor.click();
    await page.keyboard.down("Alt");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "true");
    await frame.getByRole("cell", { name: "120 件", exact: true }).hover();
    await expect(frame.locator(".dspi-outline")).toBeVisible();
    await page.keyboard.up("Alt");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "false");
    await expect(frame.locator(".dspi-outline")).toBeHidden();
    // Alt events received within the iframe itself follow the same lifecycle.
    await frame.locator("h1").click();
    await page.keyboard.down("Alt");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await keyboardEditor.click();
    await frame.getByRole("cell", { name: "120 件", exact: true }).hover();
    await expect(pickerButton).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.up("Alt");
    // Escape after focus has moved to the parent also suppresses the still-held Alt.
    await frame.locator("h1").click();
    await page.keyboard.down("Alt");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "true");
    await keyboardEditor.click();
    await page.keyboard.press("Escape");
    await frame.getByRole("cell", { name: "120 件", exact: true }).hover();
    await expect(pickerButton).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.up("Alt");
    // Releasing Alt exits selection without cancelling an already-clicked quote.
    await page.route("**/api/page-interaction/reference", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await route.continue();
    });
    await keyboardEditor.click();
    await page.keyboard.down("Alt");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "true");
    await frame.getByRole("cell", { name: "120 件", exact: true }).click();
    await page.keyboard.up("Alt");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "false");
    await expect(keyboardEditor).toContainText("客户甲");
    await keyboardEditor.press("ControlOrMeta+a");
    await keyboardEditor.press("Backspace");
    await expect(keyboardEditor).toHaveText("");
    await page.unroute("**/api/page-interaction/reference");
    // Escape in the parent cancels a pending save even after Alt selection has ended.
    let releaseSave;
    const saveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    await page.route("**/api/page-interaction/reference", async (route) => {
      await saveGate;
      await route.continue().catch(() => {});
    });
    await keyboardEditor.click();
    await page.keyboard.down("Alt");
    const saveStarted = page.waitForRequest((request) =>
      request.url().endsWith("/api/page-interaction/reference"),
    );
    await frame.getByRole("cell", { name: "987654 件", exact: true }).click();
    const pendingSave = await saveStarted;
    await page.keyboard.up("Alt");
    await keyboardEditor.click();
    await expect(keyboardEditor).toHaveText("");
    const saveCancelled = page.waitForEvent("requestfailed", (request) => request === pendingSave);
    await page.keyboard.press("Escape");
    await saveCancelled;
    releaseSave();
    await expect(keyboardEditor).toHaveText("");
    await page.unroute("**/api/page-interaction/reference");
    // Toolbar mode stays on across Alt release and successful references until Escape.
    await enableSelection(page);
    await page.keyboard.down("Alt");
    await page.keyboard.up("Alt");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "true");
    await frame.getByRole("button", { name: "查看库存", exact: true }).click();
    await expect(frame.locator("#business")).toHaveText("查看库存");
    await expect(page.locator("[data-page-selection-trigger]")).toBeEnabled();
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toContainText("客户甲");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "true");
    await frame.locator("#business").dispatchEvent("click", { detail: 2 });
    await expect(frame.locator("#business")).toHaveText("查看库存");
    await editor.press("ControlOrMeta+a");
    await editor.press("Backspace");
    await expect(editor).toHaveText("");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-page-selection-trigger]")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await frame.getByRole("button", { name: "查看库存", exact: true }).click();
    await expect(frame.locator("#business")).toHaveText("已执行");
    // The header means the whole table; the tiny card label means its whole section.
    await enableSelection(page);
    await frame.getByRole("columnheader", { name: "库存", exact: true }).hover();
    await expect(frame.locator(".dspi-outline")).toBeVisible();
    await frame.getByRole("columnheader", { name: "库存", exact: true }).click();
    await expect(editor).toContainText("表格 · 3 行");
    await editor.press("ControlOrMeta+a");
    await editor.press("Backspace");
    await expect(editor).toHaveText("");
    await enableSelection(page);
    await frame.locator("#tiny-metric").click();
    await expect(editor).toContainText("订单概览");
    await editor.press("ControlOrMeta+a");
    await editor.press("Backspace");
    await expect(editor).toHaveText("");
    await enableSelection(page);
    await frame.getByRole("cell", { name: "120 件", exact: true }).hover();
    await expect(frame.locator(".dspi-outline")).toBeVisible();
    await frame.getByRole("cell", { name: "120 件", exact: true }).click();
    await expect(editor).toContainText("客户甲");
    const ids = await frame
      .locator("tbody tr:visible td:nth-child(2)")
      .evaluateAll((cells) => cells.map((c) => c.getAttribute("data-gea-el")));
    assert.equal(new Set(ids).size, 3);
    const reordered = await frame.locator("tbody").evaluate((tbody, secondId) => {
      tbody.prepend(tbody.lastElementChild);
      return window.publishCurrentCatalog().find((entry) => entry.id === secondId)?.value;
    }, ids[2]);
    assert.equal(reordered, "250 件", "moving a same-name row preserves its reference ID");
    await frame.getByRole("cell", { name: "120 件", exact: true }).evaluate((cell) => {
      cell.textContent = "300 件";
    });
    await expect(frame.getByRole("status").filter({ hasText: "已加入输入框" })).toBeVisible();

    await expect(editor).toContainText("客户甲");
    if (process.env.GEA_PICKER_VISUAL)
      await page.screenshot({
        path: ".runtime/page-interaction/html-quote.png",
      });
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.insertText("这个客户有多少库存？");
    await page.keyboard.press("Enter");
    await expect.poll(() => prompts.length).toBeGreaterThan(0);
    const sent = JSON.stringify(prompts[0].messages.filter((m) => m.role === "user"));
    assert.match(sent, /客户甲/);
    assert.equal(sent.includes("120 件"), false);
    assert.equal(sent.includes("987654"), false);
    await expect(page.getByText("客户甲库存为120件。", { exact: true })).toBeVisible();
    const read = JSON.stringify(
      prompts.flatMap((p) => p.messages.filter((m) => m.role === "tool")),
    );
    assert.match(read, /120 件/);
    assert.equal(read.includes("300 件"), false);
    assert.equal(read.includes("987654"), false);
    await expect(pickerButton).toHaveAttribute("aria-pressed", "true");
    await frame.locator("#business").evaluate((button) => {
      button.textContent = "查看库存";
      button.click();
    });
    await expect(frame.locator("#business")).toHaveText("已执行");
    await page.keyboard.press("Escape");
    await expect(pickerButton).toHaveAttribute("aria-pressed", "false");
    assert.deepEqual(errors, []);
  },
);
