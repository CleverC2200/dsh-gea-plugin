import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { htmlFrameElement } from "./fixtures/business-page.mjs";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";
import {
  pageRequest,
  assertOwnerReleased,
  assertOldFrameHidden,
  evidence,
  identity,
} from "./fixtures/branch-stock-lifecycle.mjs";

test(
  "a late page tool response cannot repopulate a revoked identity",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { app, page, frame, owner } = await stockReferencePage(t);
    const oldFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    await page.evaluate(() => {
      window.__ticket08LateTool = [];
      window.addEventListener("message", (event) => {
        if (event.data?.type === "ticket08-late-tool") window.__ticket08LateTool.push(event.data);
      });
    });
    const held = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    let intercepted = false;
    await page.route("**/api/agent-workbench/page", async (route) => {
      const body = route.request().postDataJSON();
      if (intercepted || body.operation !== "access" || body.owner !== owner)
        return route.continue();
      intercepted = true;
      const response = await route.fetch();
      held.resolve(response.status());
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await frame.locator("body").evaluate((body) => {
      const pageWindow = body.ownerDocument.defaultView;
      void pageWindow
        .fetch("/api/session")
        .then((response) => response.json())
        .then((value) => pageWindow.parent.postMessage({ type: "ticket08-late-tool", value }, "*"))
        .catch((error) =>
          pageWindow.parent.postMessage({ type: "ticket08-late-tool", error: String(error) }, "*"),
        );
    });
    assert.equal(await held.promise, 200);
    await app.rpc("logout");
    await assertOldFrameHidden(oldFrame);
    await assertOwnerReleased(page, owner);
    release.resolve();
    await page.waitForTimeout(300);
    const late = await page.evaluate(() => window.__ticket08LateTool);
    assert.equal(
      late.some((item) => item.value?.userId),
      false,
      "old access data must not reach the current page",
    );
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/late-page-tool.json`,
      JSON.stringify(
        { hostStatus: 200, oldFrameHidden: true, oldOwnerReleased: true, lateMessages: late },
        null,
        2,
      ),
    );
  },
);

test(
  "switching GEA environment revokes the old page Session and authority",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { app, page, session, owner, openRequest } = await stockReferencePage(t, {
      environments: true,
    });
    const oldFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    const before = (await identity(page)).scope;
    const switched = await app.rpc("environment/select", { environment: "production" });
    assert.equal(switched.ok, true);
    assert.equal(switched.value.environment, "production");
    assert.equal(switched.value.authenticated, false);
    await expect.poll(async () => (await identity(page)).scope).toBe(null);
    await assertOldFrameHidden(oldFrame);
    await assertOwnerReleased(page, owner);
    await app.login();
    const after = (await identity(page)).scope;
    assert.equal(typeof after, "string");
    assert.notEqual(after, before);
    const denied = await pageRequest(page, openRequest);
    assert.equal(denied.status, 400);
    assert.equal(denied.value.error, "PAGE_SESSION_IDENTITY_MISMATCH");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/environment-switch.json`,
      JSON.stringify(
        { session, beforeScope: before, afterScope: after, oldSessionReopen: denied },
        null,
        2,
      ),
    );
  },
);
