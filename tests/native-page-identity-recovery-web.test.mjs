import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { openBusinessPage } from "./fixtures/business-page.mjs";
import { nativeAssociation } from "./fixtures/native-page.mjs";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

test(
  "a failed first identity observation recovers before native Session binding",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 120000,
  },
  async (t) => {
    let calls = 0,
      firstFailed = false;
    const { app, page, identity } = await stockReferencePage(t, {
      preparePage: async (page) => {
        page.on("requestfailed", (request) => {
          if (request.url().endsWith("/api/gea-html/identity")) firstFailed = true;
        });
        await page.route("**/api/gea-html/identity", async (route) => {
          if (++calls > 1) return route.continue();
          await route.abort().catch(() => {});
        });
      },
    });
    const binding = () => nativeAssociation(page, "gea-proof");
    await expect.poll(() => firstFailed, { timeout: 7000 }).toBe(true);
    assert.ok(calls > 1, "the shared observer must recover from a failed first read");
    await openBusinessPage(page, "gea-proof");
    await expect.poll(async () => (await binding())?.sessionId).toMatch(/^session-/);
    const before = await binding(),
      session = before.sessionId;
    await app.rpc("logout");
    identity.userId = "9007199254740994";
    await app.login();
    try {
      await expect
        .poll(async () => (await binding())?.sessionId, { timeout: 7000 })
        .not.toBe(session);
    } finally {
      await mkdir(".runtime/review-08-evidence", { recursive: true });
      await writeFile(
        ".runtime/review-08-evidence/first-observation.json",
        JSON.stringify(
          { before, after: await binding(), firstFailed, identityRequests: calls },
          null,
          2,
        ),
      );
    }
  },
);
