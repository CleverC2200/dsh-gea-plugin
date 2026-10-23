import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { preparePageStartup, prepareWorkbenchHtmlRoots } from "./fixtures/business-page.mjs";

test(
  "a stalled identity keeps HTML discovery available and the business catalog hidden",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const app = await profile(t, {
      beforeStart: prepareWorkbenchHtmlRoots([
        resolve("../dsh-agent-workbench/lib/business/inventory-fc"),
      ]),
    });
    await app.login();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ locale: "zh-CN" });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    const release = Promise.withResolvers();
    let held = 0,
      aborted = 0,
      discoveries = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/agent-workbench/pages")) discoveries++;
    });
    page.on("requestfailed", (request) => {
      if (request.url().endsWith("/api/gea-html/identity")) aborted++;
    });
    await page.route("**/api/gea-html/identity", async (route) => {
      held++;
      await release.promise;
      await route.abort().catch(() => {});
    });
    try {
      await page.goto(app.origin);
      await preparePageStartup(page);
      await expect.poll(() => held).toBeGreaterThan(0);
      const headers = { Cookie: app.cookie, "Content-Type": "application/json" };
      const available = {
        status: await (
          await fetch(app.origin + "/api/gea-proof/status", { method: "POST", headers, body: "{}" })
        ).json(),
        pages: await (await fetch(app.origin + "/api/agent-workbench/pages", { headers })).json(),
      };
      assert.equal(available.status.ok, true);
      assert.ok(
        available.pages.some(
          (page) => page.id === "inventory-fc" && page.pluginId === "inventory-fc",
        ),
      );
      try {
        await expect.poll(() => discoveries, { timeout: 7000 }).toBeGreaterThan(0);
        const menu = page
          .getByRole("button", { name: /^(业务工作台|Business workbenches)$/ })
          .first();
        if ((await menu.getAttribute("aria-expanded")) !== "true") await menu.click();
        const entry = page
          .getByRole("navigation", { name: "业务导航", exact: true })
          .getByRole("button", { name: "分仓库存", exact: true });
        await expect(entry).toHaveCount(0);
        assert.equal(
          app.requests.filter((request) => request.url.pathname.endsWith("/aiportal/agent/market"))
            .length,
          0,
          "unconfirmed identity must not start market reads",
        );
        await expect.poll(() => aborted, { timeout: 7000 }).toBeGreaterThan(0);
      } finally {
        await mkdir(".runtime/review-08-evidence", { recursive: true });
        await writeFile(
          ".runtime/review-08-evidence/identity-discovery.json",
          JSON.stringify(
            {
              held,
              aborted,
              discoveries,
              statusAvailable: available.status.ok,
              catalogContainsBranch: true,
              marketEntries: await page
                .getByRole("navigation", { name: "业务导航", exact: true })
                .getByRole("button", { name: "分仓库存", exact: true })
                .count(),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      release.resolve();
    }
  },
);
