import test from "node:test";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { openBusinessPage } from "./fixtures/business-page.mjs";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

test(
  "one shell identity warning survives HTML, Native and AI page switches and clears on recovery",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    let failReads = false;
    const { app, page } = await stockReferencePage(t, {
      preparePage: async (page) => {
        await page.route("**/api/gea-html/identity", (route) =>
          failReads ? route.abort() : route.continue(),
        );
      },
    });
    const before = (await app.rpc("status")).value.pageScope;
    failReads = true;
    const warning = page.locator("[data-gea-identity-error]");
    await expect(warning).toHaveCount(1);
    await expect(warning).toBeVisible();
    await openBusinessPage(page, "gea-proof");
    await expect(warning).toHaveCount(1);
    await expect(warning).toBeVisible();
    await page
      .getByRole("complementary", { name: "业务导航", exact: true })
      .getByRole("button", { name: "新会话", exact: true })
      .filter({ hasText: "AI工作台" })
      .click();
    await expect(warning).toHaveCount(1);
    await expect(warning).toBeVisible();
    assert.equal(
      (await app.rpc("status")).value.pageScope,
      before,
      "failed projection reads must not replace the Host login identity",
    );
    failReads = false;
    await expect(warning).toHaveCount(0);
  },
);
