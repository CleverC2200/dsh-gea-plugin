import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";

test(
  "GEA and an independent Agent retain their own instance sessions on published DSH",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, { config: { workbenchExample: true } });
    app.route((request, _res, reply) => {
      if (request.url.pathname.endsWith("/plans")) {
        reply({
          success: true,
          result: { records: [], total: 0, pages: 0, current: 1, size: 20 },
        });
        return true;
      }
      return false;
    });
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
      app.cookie
        .split("; ")
        .map((pair) => ({
          name: pair.slice(0, pair.indexOf("=")),
          value: pair.slice(pair.indexOf("=") + 1),
          url: app.origin,
        })),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(15000);
    const created = [];
    page.on("response", async (r) => {
      if (r.url().endsWith("/api/session/create")) {
        try {
          created.push(await r.json());
        } catch {}
      }
    });
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: "内测声明", exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = page.frameLocator("iframe[data-gea-workbench]");
    try {
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await expect(
        page.locator(
          '[data-conversation-beside-panel] [contenteditable="true"]',
        ),
      ).toBeVisible();
      await expect.poll(() => created.length).toBeGreaterThan(0);
      const currentId = () =>
        page.evaluate(
          () => document.querySelector("[data-example-session]")?.textContent,
        );
      await page
        .getByRole("button", { name: "示例 Agent", exact: true })
        .click();
      await page.locator("[data-workbench-example]").waitFor();
      await expect.poll(currentId).toMatch(/^session-/);
      await page.getByRole("button", { name: "合同 A", exact: true }).click();
      const beforeA = await currentId();
      await expect.poll(currentId).not.toBe(beforeA);
      const a = await currentId();
      await page.locator('[contenteditable="true"]').fill("contract-a-only");
      await page.getByRole("button", { name: "合同 B", exact: true }).click();
      await expect.poll(currentId).not.toBe(a);
      const b = await currentId();
      await expect(page.locator('[contenteditable="true"]')).not.toContainText(
        "contract-a-only",
      );
      await page.getByRole("button", { name: "合同 A", exact: true }).click();
      await expect.poll(currentId).toBe(a);
      await expect(page.locator('[contenteditable="true"]')).toContainText(
        "contract-a-only",
      );
      await page.locator('[contenteditable="true"]').press("Enter");
      await page
        .getByText("contract-a-only", { exact: true })
        .first()
        .waitFor();
      await page.locator(".gea-brand-switch").click();
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await expect(page.locator('[contenteditable="true"]')).not.toContainText(
        "contract-a-only",
      );
      await page
        .getByRole("button", { name: "示例 Agent", exact: true })
        .click();
      await expect.poll(currentId).toBe(a);
      await page.reload();
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "示例 Agent", exact: true })
        .click();
      await expect.poll(currentId).toBe(a);
      await page.getByRole("button", { name: "合同 B", exact: true }).click();
      await expect.poll(currentId).toBe(b);
      await mkdir(".runtime/workbench-evidence", { recursive: true });
      await page.screenshot({
        path: ".runtime/workbench-evidence/desktop.png",
      });
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.locator("[data-conversation-stacked]").waitFor();
      await expect(page.locator('[contenteditable="true"]')).toBeVisible();
      await page.screenshot({ path: ".runtime/workbench-evidence/narrow.png" });
      await page
        .getByRole("button", { name: "卸载示例页面", exact: true })
        .click();
      await expect(page.locator("[data-workbench-example]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "示例 Agent", exact: true }),
      ).toHaveCount(0);
      await expect(page.locator('[contenteditable="true"]')).toBeVisible();
      assert.deepEqual(errors, []);
    } catch (error) {
      throw new Error(
        `${error.message}\nErrors: ${errors.join("\n")}\nCreated: ${JSON.stringify(created)}\nDOM: ${(await page.locator("body").innerText()).slice(0, 3000)}`,
      );
    }
  },
);
