import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { readSession } from "./profile.mjs";
import { openBusinessPage } from "./fixtures/business-page.mjs";
import { nativeAssociation } from "./fixtures/native-page.mjs";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

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
      // The mounted account view can start its own QR challenge on logout.
      // Keep this identity test on the fixture-driven login so two challenges do not cancel each other.
      const loginPath = "**/api/gea-proof/login/start";
      const blockViewLogin = (route) => route.abort();
      await page.route(loginPath, blockViewLogin);
      try {
        await app.rpc("logout");
        await expect.poll(async () => (await binding())?.sessionId).not.toBe(session);
        const login = await app.login();
        assert.equal(login.ok, true);
      } finally {
        await page.unroute(loginPath, blockViewLogin);
      }
      // Login completion can precede the Host user projection. Bind only its confirmed scope.
      let projection;
      await expect
        .poll(async () => {
          projection = await page.evaluate(
            async () => await (await fetch("/api/gea-html/identity")).json(),
          );
          return (
            projection.status?.authenticated === true &&
            typeof projection.scope === "string" &&
            Boolean(projection.subject)
          );
        })
        .toBe(true);
      const authority = projection.scope;
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
