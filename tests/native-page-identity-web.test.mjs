import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { readSession, until } from "./profile.mjs";
import { openBusinessPage } from "./fixtures/business-page.mjs";
import { nativeAssociation } from "./fixtures/native-page.mjs";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

for (const transition of ["user", "tenant", "environment"])
  test(
    `native regional approval page cannot restore an old identity Session after ${transition} changes`,
    {
      skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
      timeout: 120000,
    },
    async (t) => {
      const { app, page, identity } = await stockReferencePage(t, {
        environments: transition === "environment",
      });
      const binding = () => nativeAssociation(page, "gea-proof");
      await openBusinessPage(page, "gea-proof");
      await expect.poll(binding).toBeTruthy();
      const before = await binding(),
        session = before.sessionId;
      const marker = `旧身份专属测试标记-${transition}`;
      assert.equal(
        (
          await app.remote("session/selectModel", {
            sessionId: session,
            provider: "gea-analysis",
            model: "fixture",
          })
        ).ok,
        true,
      );
      assert.equal(
        (
          await app.remote("session/prompt", {
            requestId: randomUUID(),
            sessionId: session,
            mode: "queue",
            content: [{ type: "text", text: marker }],
          })
        ).ok,
        true,
      );
      await until(
        () => readSession(app.runtime, session),
        (rows) => rows.some((row) => row.type === "turn/end"),
        30000,
      );
      await page.reload();
      try {
        await expect.poll(async () => (await binding())?.sessionId).toBe(session);
        await expect(page.getByText(marker, { exact: true }).last()).toBeVisible();
      } catch (error) {
        await mkdir(".runtime/native-identity-evidence", { recursive: true });
        await writeFile(
          `.runtime/native-identity-evidence/reload-${transition}.json`,
          JSON.stringify(
            {
              transition,
              session,
              binding: await binding(),
              body: await page.locator("body").innerText(),
              navigation: await page
                .getByRole("navigation", { name: "业务导航", exact: true })
                .allInnerTexts(),
              durableSession: (await readSession(app.runtime, session)).length,
            },
            null,
            2,
          ),
        );
        throw error;
      }
      if (transition === "environment")
        await app.rpc("environment/select", { environment: "production" });
      else await app.rpc("logout");
      if (transition === "user") identity.userId = "9007199254740994";
      if (transition === "tenant") identity.tenantId = "1";
      await app.login();
      await page.reload();
      await openBusinessPage(page, "gea-proof");
      try {
        await expect.poll(binding).toBeTruthy();
      } catch (error) {
        await mkdir(".runtime/review-08-evidence", { recursive: true });
        await writeFile(
          `.runtime/review-08-evidence/native-${transition}-open-failure.json`,
          JSON.stringify(
            await page.evaluate(() => ({
              presentation: localStorage.getItem("agent-workbench.presentation.v2"),
              selected: [
                ...document.querySelectorAll("[data-gea-business-entry][aria-current='page']"),
              ].map((el) => el.getAttribute("data-gea-business-entry")),
              text: document.body.innerText.slice(-3500),
            })),
            null,
            2,
          ),
        );
        throw error;
      }
      try {
        await expect.poll(async () => (await binding())?.sessionId).not.toBe(session);
      } finally {
        const after = await binding();
        const oldMarkerVisible = await page.getByText(marker, { exact: true }).last().isVisible();
        const persisted = await readSession(app.runtime, session);
        await mkdir(".runtime/review-08-evidence", { recursive: true });
        await writeFile(
          `.runtime/review-08-evidence/native-${transition}.json`,
          JSON.stringify(
            {
              transition,
              before,
              after,
              oldMarkerVisible,
              durableOldSessionStillExists: persisted.length > 0,
            },
            null,
            2,
          ),
        );
        assert.ok(
          persisted.length > 0,
          "identity invalidation must not delete the durable background Session",
        );
      }
      await expect(page.getByText(marker, { exact: true }).filter({ visible: true })).toHaveCount(
        0,
      );
    },
  );

for (const panel of ["gea-proof", "gea-inbox"])
  test(
    `a mounted native ${panel} invalidates its association on logout without deleting its Session`,
    {
      skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
      timeout: 120000,
    },
    async (t) => {
      const { app, page } = await stockReferencePage(t);
      const binding = () => nativeAssociation(page, panel);
      if (panel === "gea-inbox") {
        const shortcut = page.getByRole("button", { name: "消息待办", exact: true });
        const button = await shortcut.boundingBox();
        const sidebar = await page
          .getByRole("complementary", { name: "业务导航", exact: true })
          .boundingBox();
        assert.ok(button && sidebar);
        assert.ok(
          button.x >= sidebar.x && button.x + button.width <= sidebar.x + sidebar.width,
          "the inbox action must stay inside its owning sidebar",
        );
        assert.ok(button.y >= sidebar.y && button.y + button.height <= sidebar.y + sidebar.height);
        await shortcut.click();
      } else await openBusinessPage(page, panel);
      await expect.poll(async () => (await binding())?.sessionId).toMatch(/^session-/);
      const before = await binding(),
        session = before.sessionId;
      await app.rpc("logout");
      await expect.poll(async () => (await binding())?.sessionId).not.toBe(session);
      await app.login();
      const authority = await page.evaluate(
        async () => (await (await fetch("/api/gea-html/identity")).json()).scope,
      );
      await expect.poll(async () => (await binding())?.ownerScope).toBe(authority);
      await expect.poll(async () => (await binding())?.sessionId).toMatch(/^session-/);
      const after = await binding();
      assert.notEqual(after.sessionId, session);
      assert.notEqual(after.ownerScope, "gea:anonymous");
      assert.ok((await readSession(app.runtime, session)).length > 0);
      await mkdir(".runtime/review-08-evidence", { recursive: true });
      await writeFile(
        `.runtime/review-08-evidence/native-live-${panel}.json`,
        JSON.stringify({ panel, before, after, durableOldSessionStillExists: true }, null, 2),
      );
    },
  );

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
