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
      let projection;
      const subject = JSON.stringify(["production", identity.tenantId, identity.userId]);
      await expect
        .poll(async () => {
          projection = await page.evaluate(
            async () => await (await fetch("/api/gea-html/identity")).json(),
          );
          return (
            projection.status?.authenticated === true &&
            typeof projection.scope === "string" &&
            Boolean(projection.scope) &&
            projection.subject === subject
          );
        })
        .toBe(true);
      await expect(
        page
          .getByRole("button", { name: "账户菜单", exact: true })
          .getByText("测试用户", { exact: true }),
      ).toBeVisible();
      const authority = projection.scope;
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
        await expect.poll(async () => (await binding())?.sessionId).toMatch(/^session-/);
        await expect.poll(async () => (await binding())?.ownerScope).toBe(authority);
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
