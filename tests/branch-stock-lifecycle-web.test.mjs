import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";
import { htmlFrameElement, openBusinessPage } from "./fixtures/business-page.mjs";

const evidenceDirectory = async (t) => {
  await mkdir(".runtime", { recursive: true });
  const path = await mkdtemp(".runtime/branch-stock-lifecycle-");
  t.diagnostic("lifecycle evidence: " + path);
  return path;
};
const presentationKey = "agent-workbench.presentation.v2";
const presentation = (page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key)), presentationKey);
const pageOperation = (page, body) =>
  page.evaluate(async (body) => {
    const response = await fetch("/api/agent-workbench/page", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  }, body);
const captureOpen = (request, opens) => {
  if (!request.url().endsWith("/api/agent-workbench/page") || !request.postData()) return;
  const body = request.postDataJSON();
  if (body.operation === "open" && body.pageId === "inventory-fc") opens.push(body);
};
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
    const { app, page, frame, session } = await stockReferencePage(t);
    const evidence = await evidenceDirectory(t);
    const stored = await presentation(page);
    assert.equal(stored.version, 2);
    assert.equal(stored.page, "inventory-fc");
    const branch = stored.selections.find((row) => row.page === "inventory-fc" && row.active);
    assert.equal(branch.preset, "gea-html-inventory-fc");
    assert.equal(branch.sessionId, session);
    const unscoped = await pageOperation(page, { operation: "access" });
    assert.equal(unscoped.status, 400);
    assert.equal(unscoped.value.error, "PAGE_OWNER_RELEASED");
    const opens = [];
    page.on("request", (request) => {
      captureOpen(request, opens);
    });
    await page.reload();
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    await expect.poll(() => opens.at(-1)?.sessionId).toBe(session);
    assert.equal((await presentation(page)).page, "inventory-fc");
    const missing = "session-00000000-0000-0000-0000-000000000001";
    // Isolate the corrupt presentation so the original live tab cannot rewrite it.
    const missingContext = await page.context().browser().newContext({ locale: "zh-CN" });
    t.after(() => missingContext.close());
    await missingContext.addCookies(await page.context().cookies());
    const missingPage = await missingContext.newPage();
    missingPage.setDefaultTimeout(20000);
    await missingPage.addInitScript(
      ({ key, branch, missing }) => {
        if (window.top !== window) return;
        localStorage.setItem(
          key,
          JSON.stringify({
            version: 2,
            page: "inventory-fc",
            selections: [{ ...branch, sessionId: missing }],
            views: [],
          }),
        );
      },
      { key: presentationKey, branch, missing },
    );
    const network = [];
    const pageErrors = [];
    const missingOpens = [];
    missingPage.on("pageerror", (error) => pageErrors.push(error.message));
    missingPage.on("request", (request) => {
      captureOpen(request, missingOpens);
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
    const diagnostic = await missingPage.evaluate(
      (key) => ({
        presentation: localStorage.getItem(key),
        visible: document.body.innerText.slice(0, 2000),
      }),
      presentationKey,
    );
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
      const final = await missingPage.evaluate(
        (key) => ({
          presentation: localStorage.getItem(key),
          selectedMenu: [
            ...document.querySelectorAll("[data-gea-business-entry][aria-current='page']"),
          ].map((item) => item.getAttribute("data-gea-business-entry")),
          visible: document.body.innerText.slice(0, 2500),
        }),
        presentationKey,
      );
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
          unscopedOpen: unscoped,
        },
        null,
        2,
      ),
    );
  },
);

test(
  "rapid page switches keep the branch Session and do not mount the old page",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { page, frame, session, owner } = await stockReferencePage(t);
    const evidence = await evidenceDirectory(t);
    const opens = [];
    page.on("request", (request) => {
      captureOpen(request, opens);
    });
    await openBusinessPage(page, "gea-proof");
    await expect(htmlFrameElement(page, "inventory-fc")).not.toBeVisible();
    const retained = (await presentation(page)).selections.filter(
      (row) => row.page === "inventory-fc",
    );
    assert.ok(
      retained.some((row) => row.sessionId === session),
      "leaving the page must keep its Session association",
    );
    await expect
      .poll(async () => (await pageOperation(page, { operation: "access", owner })).value.error)
      .toBe("PAGE_OWNER_RELEASED");
    const oldOwner = await pageOperation(page, { operation: "access", owner });
    assert.equal(oldOwner.status, 400);
    assert.equal(oldOwner.value.error, "PAGE_OWNER_RELEASED");
    await openBusinessPage(page, "inventory-fc");
    await openBusinessPage(page, "gea-proof");
    await openBusinessPage(page, "inventory-fc");
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    await expect.poll(() => opens.at(-1)?.sessionId).toBe(session);
    assert.equal((await presentation(page)).page, "inventory-fc");
    assert.equal(
      (await pageOperation(page, { operation: "access", owner })).value.error,
      "PAGE_OWNER_RELEASED",
    );
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
    const { app, page, quote, readReference, session } = await stockReferencePage(t);
    const evidence = await evidenceDirectory(t);
    const before = (await identity(page)).scope;
    assert.equal(typeof before, "string");
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
    const previousFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    assert.ok(previousFrame, "the active frame must exist before authority changes");
    await app.rpc("logout");
    await expect.poll(async () => (await identity(page)).scope).toBe(null);
    await expect.poll(() => previousFrame.evaluate((node) => node.isConnected)).toBe(false);
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
    const reused = await pageOperation(page, {
      operation: "open",
      pageId: "inventory-fc",
      sessionId: session,
      resourceId: "gea-html-inventory-fc",
    });
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
    const { app, page, session } = await stockReferencePage(t);
    const evidence = await evidenceDirectory(t);
    const agentsHeld = Promise.withResolvers();
    const openHeld = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    let heldAgents = false;
    await page.route("**/api/agent-manage/resources?*", async (route) => {
      if (heldAgents) return route.continue();
      heldAgents = true;
      const response = await route.fetch();
      agentsHeld.resolve(response.status());
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    let heldOpen = false;
    await page.route("**/api/agent-workbench/page", async (route) => {
      const body = route.request().postDataJSON();
      if (heldOpen || body.operation !== "open" || body.pageId !== "inventory-fc")
        return route.continue();
      heldOpen = true;
      const response = await route.fetch();
      openHeld.resolve({ status: response.status(), receipt: await response.json() });
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.reload();
    assert.equal(await agentsHeld.promise, 200);
    const heldOpenReceipt = await openHeld.promise;
    assert.equal(heldOpenReceipt.status, 200);
    assert.equal(typeof heldOpenReceipt.receipt.owner, "string");
    const previousFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    assert.ok(previousFrame, "the active frame must exist before authority changes");
    await app.rpc("logout");
    await expect
      .poll(async () =>
        (await presentation(page)).selections.some((row) => row.page === "inventory-fc"),
      )
      .toBe(false);
    release.resolve();
    await page.waitForTimeout(300);
    assert.equal(
      (await presentation(page)).selections.some(
        (row) => row.page === "inventory-fc" && row.sessionId === session,
      ),
      false,
      "a released receipt must not restore the old Session association",
    );
    const deniedOwner = await pageOperation(page, {
      operation: "access",
      owner: heldOpenReceipt.receipt.owner,
    });
    assert.equal(deniedOwner.status, 400);
    assert.equal(deniedOwner.value.error, "PAGE_OWNER_RELEASED");
    await expect.poll(() => previousFrame.evaluate((node) => node.isConnected)).toBe(false);
    await expect(page.getByRole("combobox", { name: "选择解读能力" })).toHaveCount(0);
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/late-agents-open.json`,
      JSON.stringify(
        {
          agentsHostStatus: 200,
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
  "a late page tool response cannot repopulate an unmounted identity",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { app, page, frame } = await stockReferencePage(t);
    const evidence = await evidenceDirectory(t);
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
      if (intercepted || body.operation !== "access") return route.continue();
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
    const previousFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    assert.ok(previousFrame, "the active frame must exist before authority changes");
    await app.rpc("logout");
    await expect.poll(() => previousFrame.evaluate((node) => node.isConnected)).toBe(false);
    release.resolve();
    await page.waitForTimeout(300);
    const late = await page.evaluate(() => window.__ticket08LateTool);
    assert.equal(
      late.some((item) => item.value?.userId || item.value?.principalId),
      false,
      "old access data must not reach the current page",
    );
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/late-page-tool.json`,
      JSON.stringify({ hostStatus: 200, oldFrameUnmounted: true, lateMessages: late }, null, 2),
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
    const { app, page, session } = await stockReferencePage(t, { environments: true });
    const evidence = await evidenceDirectory(t);
    const before = (await identity(page)).scope;
    const previousFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    assert.ok(previousFrame, "the active frame must exist before authority changes");
    const switched = await app.rpc("environment/select", { environment: "production" });
    assert.equal(switched.ok, true);
    assert.equal(switched.value.environment, "production");
    assert.equal(switched.value.authenticated, false);
    await expect.poll(async () => (await identity(page)).scope).toBe(null);
    await expect.poll(() => previousFrame.evaluate((node) => node.isConnected)).toBe(false);
    await app.login();
    const after = (await identity(page)).scope;
    assert.equal(typeof after, "string");
    assert.notEqual(after, before);
    const denied = await pageOperation(page, {
      operation: "open",
      pageId: "inventory-fc",
      sessionId: session,
      resourceId: "gea-html-inventory-fc",
    });
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
