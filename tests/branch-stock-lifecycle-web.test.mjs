import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import {
  htmlFrameElement,
  openBusinessPage,
  openWorkbenchPage,
} from "./fixtures/business-page.mjs";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

const pageRequest = (page, input) =>
  page.evaluate(async (input) => {
    const response = await fetch("/api/agent-workbench/page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: response.status, value: await response.json() };
  }, input);
const assertOwnerReleased = async (page, owner) => {
  let reply;
  await expect
    .poll(async () => {
      reply = await pageRequest(page, { operation: "access", owner });
      return reply.status;
    })
    .toBe(400);
  assert.equal(reply.value.error, "PAGE_OWNER_RELEASED");
};
const assertOldFrameHidden = async (frame) => {
  assert.ok(frame, "Capture the actual iframe instance before identity revocation");
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        if (!element.isConnected) return true;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width === 0 ||
          rect.height === 0 ||
          style.visibility === "hidden" ||
          style.visibility === "collapse"
        );
      }),
    )
    .toBe(true);
};
const presentation = (page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("agent-workbench.presentation.v2")));
const evidence = ".runtime/branch-stock-lifecycle-evidence";
const identity = (page) =>
  page.evaluate(async () => {
    const response = await fetch("/api/gea-html/identity", { cache: "no-store" });
    return response.json();
  });

test(
  "refresh restores the branch page and exact Session, while a missing Session fails visibly",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { app, page, frame, session, openRequest } = await stockReferencePage(t);
    const stored = await presentation(page);
    assert.equal(stored.version, 2);
    assert.equal(stored.page, "inventory-fc");
    const branch = stored.selections.find((row) => row.page === "inventory-fc" && row.active);
    assert.equal(branch.preset, "gea-html-inventory-fc");
    assert.equal(branch.sessionId, session);
    // Client scope is only presentation. The retired route must stay absent; current open resolves Core and GEA.
    const retiredOpen = await page.evaluate(async (oldSession) => {
      const response = await fetch("/api/gea-html/inventory-fc/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: oldSession, agentPreset: "gea-html-inventory-fc" }),
      });
      return { status: response.status, text: await response.text() };
    }, session);
    assert.equal(retiredOpen.status, 404);
    const missing = "session-00000000-0000-0000-0000-000000000001";
    const missingOpen = await pageRequest(page, { ...openRequest, sessionId: missing });
    assert.equal(missingOpen.status, 400);
    assert.equal(missingOpen.value.error, `session "${missing}" not found`);
    const wrongResource = await pageRequest(page, {
      ...openRequest,
      resourceId: "gea-html-inventory-qll",
    });
    assert.equal(wrongResource.status, 400);
    assert.equal(wrongResource.value.error, "PAGE_RESOURCE_NOT_ALLOWED");
    const authorizedOpen = await pageRequest(page, openRequest);
    assert.equal(authorizedOpen.status, 200);
    assert.match(authorizedOpen.value.owner, /^[0-9a-f-]{36}$/);
    const access = await pageRequest(page, {
      operation: "access",
      owner: authorizedOpen.value.owner,
    });
    assert.equal(access.status, 200);
    assert.equal(access.value.principalId, "9007199254740993");
    const opens = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/api/agent-workbench/page") || !request.postData()) return;
      const input = request.postDataJSON();
      if (input.operation === "open" && input.pageId === "inventory-fc") opens.push(input);
    });
    await page.reload();
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    await expect.poll(() => opens.at(-1)?.sessionId).toBe(session);
    assert.equal((await presentation(page)).page, "inventory-fc");
    // A fresh tab has no mounted controller that could rewrite the stored association.
    const missingPage = await page.context().newPage();
    t.after(() => missingPage.close());
    missingPage.setDefaultTimeout(20000);
    await missingPage.addInitScript(
      ({ missing, stored }) => {
        if (window.top !== window) return;
        // A browser hint may nominate a missing UUID, but must never create or replace the Core Session.
        const selected = stored.selections.find((row) => row.page === "inventory-fc" && row.active);
        selected.sessionId = missing;
        localStorage.setItem("agent-workbench.presentation.v2", JSON.stringify(stored));
      },
      { missing, stored: await presentation(page) },
    );
    const network = [];
    const pageErrors = [];
    const missingOpens = [];
    missingPage.on("pageerror", (error) => pageErrors.push(error.message));
    missingPage.on("request", (request) => {
      if (!request.url().endsWith("/api/agent-workbench/page") || !request.postData()) return;
      const input = request.postDataJSON();
      if (input.operation === "open" && input.pageId === "inventory-fc") missingOpens.push(input);
    });
    missingPage.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (
        path.includes("/gea-html/") ||
        path.includes("/agent-workbench/") ||
        path.includes("/api/session/")
      )
        network.push({ path, status: response.status() });
    });
    await missingPage.goto(app.origin);
    const diagnostic = await missingPage.evaluate(() => ({
      panel: JSON.parse(localStorage.getItem("agent-workbench.presentation.v2"))?.page,
      presentation: localStorage.getItem("agent-workbench.presentation.v2"),
      visible: document.body.innerText.slice(0, 2000),
    }));
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/missing-session-diagnostic.json`,
      JSON.stringify(diagnostic, null, 2),
    );
    try {
      await expect(missingPage.getByRole("alert")).toContainText(
        `Session unavailable: ${missing}`,
        { timeout: 20000 },
      );
    } catch (error) {
      const final = await missingPage.evaluate(() => ({
        panel: JSON.parse(localStorage.getItem("agent-workbench.presentation.v2"))?.page,
        selectedMenu: [
          ...document.querySelectorAll("[data-gea-business-entry][aria-current='page']"),
        ].map((item) => item.getAttribute("data-gea-business-entry")),
        visible: document.body.innerText.slice(0, 2500),
        presentation: localStorage.getItem("agent-workbench.presentation.v2"),
      }));
      await writeFile(
        `${evidence}/missing-session-failure.json`,
        JSON.stringify({ final, network, missingOpens, pageErrors }, null, 2),
      );
      throw error;
    }
    assert.equal(missingOpens.length, 0, "the missing Session must not be silently replaced");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/reload.json`,
      JSON.stringify(
        {
          session,
          panel: stored.page,
          instance: branch.preset,
          recovered: opens.at(-1)?.sessionId,
          missing,
          missingErrorVisible: true,
          unexpectedOpens: missingOpens.length,
          retiredOpen,
          authorizedOpen,
          missingOpen,
          wrongResource,
        },
        null,
        2,
      ),
    );
  },
);

test(
  "rapid page switches keep the branch Session and hide the inactive page while releasing its owner",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { page, frame, session, owner } = await stockReferencePage(t);
    const opens = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/api/agent-workbench/page") || !request.postData()) return;
      const input = request.postDataJSON();
      if (input.operation === "open" && input.pageId === "inventory-fc") opens.push(input);
    });
    await openBusinessPage(page, "gea-proof");
    await expect(htmlFrameElement(page, "inventory-fc")).toBeHidden();
    await assertOwnerReleased(page, owner);
    const retained = (await presentation(page)).selections.filter(
      (row) => row.page === "inventory-fc",
    );
    assert.ok(
      retained.some((row) => row.sessionId === session),
      "leaving the page must keep its Session association",
    );
    await openWorkbenchPage(page, "分仓库存");
    await openBusinessPage(page, "gea-proof");
    await openWorkbenchPage(page, "分仓库存");
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    await expect.poll(() => opens.at(-1)?.sessionId).toBe(session);
    assert.equal((await presentation(page)).page, "inventory-fc");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/rapid-switch.json`,
      JSON.stringify(
        {
          session,
          retainedAssociation: true,
          finalPage: "inventory-fc",
          finalOpenSession: opens.at(-1)?.sessionId,
        },
        null,
        2,
      ),
    );
  },
);

test(
  "a saved reference response delivered after logout never reappears in the composer",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { app, page, quote, readReference, session, owner, openRequest } =
      await stockReferencePage(t);
    const before = (await identity(page)).scope;
    assert.equal(typeof before, "string");
    const oldFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let saved;
    const stored = new Promise((resolve) => {
      saved = resolve;
    });
    t.after(() => release());
    await page.route("**/api/page-interaction/reference", async (route) => {
      const response = await route.fetch();
      const receipt = await response.json();
      saved({ status: response.status(), id: receipt.id });
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await quote();
    const host = await stored;
    assert.equal(host.status, 200, "Host must have saved the click-time snapshot before logout");
    assert.match(host.id, /^R[a-f0-9]{12}$/);
    await app.rpc("logout");
    await expect.poll(async () => (await identity(page)).scope).toBe(null);
    await assertOldFrameHidden(oldFrame);
    await assertOwnerReleased(page, owner);
    release();
    await page.waitForTimeout(300);
    const composerField = page.locator('[contenteditable="true"]').first();
    const composer = (await composerField.count()) ? await composerField.innerText() : "";
    const read = await readReference(host.id);
    assert.equal(composer.trim(), "");
    assert.match(read.text, /REFERENCE_UNAVAILABLE/);
    await app.login();
    const after = (await identity(page)).scope;
    assert.equal(typeof after, "string");
    assert.notEqual(
      after,
      before,
      "a new login must have a new page authority even for the same user",
    );
    const reused = await pageRequest(page, openRequest);
    assert.equal(reused.status, 400);
    assert.equal(reused.value.error, "PAGE_SESSION_IDENTITY_MISMATCH");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/confirmed-late-logout.json`,
      JSON.stringify(
        {
          session,
          hostStatus: host.status,
          scopeBefore: before,
          scopeAfterRelogin: after,
          composer,
          read: read.text,
          oldReferenceId: host.id,
          oldSessionReopen: reused,
        },
        null,
        2,
      ),
    );
  },
);

test(
  "logout drops delayed Agent choices and page-open receipts",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { app, page } = await stockReferencePage(t);
    const agentsHeld = Promise.withResolvers();
    const openHeld = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    let heldAgents = false;
    await page.route("**/api/agent-manage/resources?*", async (route) => {
      if (heldAgents) return route.continue();
      heldAgents = true;
      const response = await route.fetch();
      agentsHeld.resolve({ status: response.status(), rows: await response.json() });
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    let heldOpen = false;
    await page.route("**/api/agent-workbench/page", async (route) => {
      const input = route.request().postDataJSON();
      if (input.operation !== "open" || input.pageId !== "inventory-fc") return route.continue();
      if (heldOpen) return route.continue();
      heldOpen = true;
      const response = await route.fetch();
      openHeld.resolve({ status: response.status(), value: await response.json() });
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.reload();
    const heldResources = await agentsHeld.promise;
    assert.equal(heldResources.status, 200);
    assert.ok(
      heldResources.rows.some(
        (row) => row.id === "gea-html-inventory-fc" && row.installed && row.enabled,
      ),
    );
    const heldOpenReply = await openHeld.promise;
    assert.equal(heldOpenReply.status, 200);
    const owner = heldOpenReply.value.owner;
    assert.match(owner, /^[0-9a-f-]{36}$/);
    const oldFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    await app.rpc("logout");
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            JSON.parse(localStorage.getItem("agent-workbench.presentation.v2"))?.selections ?? []
          ).some((row) => row.page === "inventory-fc"),
        ),
      )
      .toBe(false);
    release.resolve();
    await page.waitForTimeout(300);
    await assertOldFrameHidden(oldFrame);
    await assertOwnerReleased(page, owner);
    await expect(htmlFrameElement(page, "inventory-fc")).toHaveAttribute("src", /[?&]page=(?:&|$)/);
    await expect(page.getByRole("combobox", { name: "选择解读能力" })).toHaveCount(0);
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/late-agents-open.json`,
      JSON.stringify(
        {
          agentsHostStatus: heldResources.status,
          heldResourceIds: heldResources.rows.map((row) => row.id),
          openHostStatus: 200,
          associationCleared: true,
          staleChoicesVisible: false,
          staleFrameVisible: false,
        },
        null,
        2,
      ),
    );
  },
);

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
