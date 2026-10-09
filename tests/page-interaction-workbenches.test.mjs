import {
  prepareWorkbenchHtmlRoots,
  openBusinessPage,
  htmlFrameElement,
  preparePageStartup,
} from "./fixtures/business-page.mjs";
import { currentHtmlResource } from "./fixtures/html-resource.mjs";
import { profileFor } from "../src/host/prompt-policy.ts";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profile } from "./profile.mjs";

test(
  "selection is standard on every embedded planning workbench",
  { timeout: 90000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "gea-workbench-selection-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const htmlPages = [
      ["inventory-apsplan", "产销协同工作台"],
      ["inventory-qll", "全链库存"],
      ["inventory-aqkc", "基地库存"],
      ["inventory-fc", "分仓库存"],
    ];
    const roots = [];
    for (const [id, name] of htmlPages) {
      const root = join(directory, id);
      roots.push(root);
      await mkdir(join(root, "skills/page"), { recursive: true });
      await writeFile(
        join(root, "plugin.json"),
        JSON.stringify({
          schemaVersion: 1,
          id,
          name,
          version: "0.0.0",
          html: "index.html",
          skills: ["skills/page/SKILL.md"],
          mcp: "mcp.json",
          gea: {
            consumerCode: profileFor(`gea-html-${id}`).consumerCode,
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
          consumer: {
            consumerType: "AGENT",
            consumerCode: profileFor(`gea-html-${id}`).consumerCode,
          },
          capabilities: ["governed-sql-read"],
        }),
      );
      await writeFile(
        join(root, "skills/page/SKILL.md"),
        `---\nname: ${id}\ndescription: 工作台验证\n---\n只读查看页面。`,
      );
      await writeFile(
        join(root, "index.html"),
        `<!doctype html><html><body><section style="padding:24px"><h1>${name}</h1><table><thead><tr><th>客户</th><th>计划</th></tr></thead><tbody><tr><td>客户甲</td><td>120</td></tr></tbody></table></section><script>addEventListener('message',event=>{if(event.data.protocol!=='gea-html-v2'||event.data.type!=='connect')return;const port=event.ports[0];port.start();port.postMessage({type:'catalog',session:event.data.context.session,elements:[{id:'readout:customer',role:'field',label:'客户',value:'客户甲'},{id:'readout:plan',role:'field',label:'计划',value:'120'}]});});parent.postMessage({protocol:'gea-html-v2',type:'ready'},'*')</script></body></html>`,
      );
      await currentHtmlResource(root);
    }
    const app = await profile(t, {
      beforeStart: prepareWorkbenchHtmlRoots(roots),
    });
    app.route((req, _res, reply) => {
      if (!req.url.pathname.endsWith("/ai/gateway/session")) return false;
      const data = JSON.parse(req.body);
      reply({
        success: true,
        result: {
          accessDecision: { allowed: true },
          delegationToken: "fixture",
          gatewayContext: {
            sessionId: "fixture",
            conversationId: data.conversationId,
            consumerCode: data.consumerCode,
            consumerType: data.consumerType,
          },
        },
      });
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
    await page.goto(app.origin);
    await preparePageStartup(page);
    for (const [panel] of [
      ["gea-regional-plan", "区域计划工作台"],
      ["plan-region-category", "品类计划工作台"],
      ["plan-category-production", "主生产计划（MPS）工作台"],
    ]) {
      await openBusinessPage(page, panel);
      await page.getByRole("button", { name: "新建对话", exact: true }).click();
      const iframe = htmlFrameElement(page, panel);
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
      const selector = page.locator("[data-page-selection-trigger]");
      await expect(selector).toBeEnabled();
      await expect(
        page.locator(".gea-conversation-toolbar [data-page-selection-trigger]"),
      ).toHaveCount(0);
      await expect(
        page.locator(".dspi-composer-trigger [data-page-selection-trigger]"),
      ).toHaveCount(1);
      const frame = iframe.contentFrame();
      await selector.click();
      // A heading hit promotes to its surrounding meaningful block in these real prototypes.
      const target = frame
        .locator(".card-h:visible,h1:visible,h2:visible,h3:visible,th:visible")
        .first();
      await target.hover();
      await expect(frame.locator(".dspi-outline")).toBeVisible();
      await target.click();
      const editor = page.locator('[contenteditable="true"]').first();
      await expect(editor).not.toHaveText("");
      assert.equal(await page.locator("[data-page-selection-trigger]").count(), 1);
      await editor.press("ControlOrMeta+a");
      await editor.press("Backspace");
      await expect(editor).toHaveText("");
    }
    for (const [id, name] of htmlPages) {
      await openBusinessPage(page, id);
      const selector = page.locator("[data-page-selection-trigger]");
      await expect(selector).toBeEnabled();
      const frame = htmlFrameElement(page, id).contentFrame();
      await expect(frame.getByRole("heading", { name, exact: true })).toBeVisible();
      await selector.click();
      await frame.getByRole("cell", { name: "客户甲", exact: true }).click();
      const editor = page.locator('[contenteditable="true"]').first();
      await expect(editor).toContainText(name);
      await editor.press("ControlOrMeta+a");
      await editor.press("Backspace");
      await expect(editor).toHaveText("");
    }
    if (process.env.GEA_PICKER_VISUAL) {
      await mkdir(".runtime/page-interaction", { recursive: true });
      await page.screenshot({
        path: ".runtime/page-interaction/workbench-standard.png",
      });
    }
  },
);
