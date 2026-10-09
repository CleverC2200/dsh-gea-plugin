import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

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
    const { app, page, frame, session } = await stockReferencePage(t);
    const stored = await page.evaluate(() => ({
      panel: sessionStorage.getItem("agent-workbench:active-panel"),
      rows: JSON.parse(sessionStorage.getItem("agent-workbench:v1")),
    }));
    assert.equal(stored.panel, "inventory-fc");
    const branch = stored.rows.find((row) => row[0] === "inventory-fc");
    assert.equal(branch[2].find((pair) => pair[0] === "gea-html-inventory-fc")[1], session);
    const unscoped = await page.evaluate(async (oldSession) => {
      const response = await fetch("/api/gea-html/inventory-fc/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: oldSession, agentPreset: "gea-html-inventory-fc" }),
      });
      return { status: response.status, value: await response.json() };
    }, session);
    assert.equal(unscoped.status, 400);
    assert.equal(unscoped.value.error, "PAGE_SESSION_IDENTITY_MISMATCH");
    const opens = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/gea-html/inventory-fc/open"))
        opens.push(request.postDataJSON());
    });
    await page.reload();
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    await expect.poll(() => opens.at(-1)?.session).toBe(session);
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("agent-workbench:active-panel")),
      "inventory-fc",
    );
    const missing = "session-00000000-0000-0000-0000-000000000001";
    // A fresh tab has no mounted controller that could rewrite the stored association.
    const missingPage = await page.context().newPage();
    t.after(() => missingPage.close());
    missingPage.setDefaultTimeout(20000);
    await missingPage.addInitScript(
      ({ missing, scope }) => {
        if (window.top !== window) return;
        sessionStorage.setItem("agent-workbench:active-panel", "inventory-fc");
        sessionStorage.setItem(
          "agent-workbench:v1",
          JSON.stringify([
            ["inventory-fc", "gea-html-inventory-fc", [["gea-html-inventory-fc", missing]], scope],
          ]),
        );
      },
      { missing, scope: (await identity(page)).scope },
    );
    const network = [];
    const pageErrors = [];
    const missingOpens = [];
    missingPage.on("pageerror", (error) => pageErrors.push(error.message));
    missingPage.on("request", (request) => {
      if (request.url().endsWith("/api/gea-html/inventory-fc/open"))
        missingOpens.push(request.postDataJSON());
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
      panel: sessionStorage.getItem("agent-workbench:active-panel"),
      rows: sessionStorage.getItem("agent-workbench:v1"),
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
        panel: sessionStorage.getItem("agent-workbench:active-panel"),
        selectedMenu: [
          ...document.querySelectorAll("[data-gea-business-entry][aria-current='page']"),
        ].map((item) => item.getAttribute("data-gea-business-entry")),
        visible: document.body.innerText.slice(0, 2500),
        rows: sessionStorage.getItem("agent-workbench:v1"),
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
          panel: stored.panel,
          instance: branch[1],
          recovered: opens.at(-1)?.session,
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
    const { page, frame, session } = await stockReferencePage(t);
    const opens = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/gea-html/inventory-fc/open"))
        opens.push(request.postDataJSON());
    });
    await page.locator('[data-gea-business-entry="gea-proof"]').click();
    await expect(page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]')).toHaveCount(0);
    const retained = await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("agent-workbench:v1")).find(
          (row) => row[0] === "inventory-fc",
        )[2],
    );
    assert.ok(
      retained.some((pair) => pair[1] === session),
      "leaving the page must keep its Session association",
    );
    await page.locator('[data-gea-business-entry="inventory-fc"]').click();
    await page.locator('[data-gea-business-entry="gea-proof"]').click();
    await page.locator('[data-gea-business-entry="inventory-fc"]').click();
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    await expect.poll(() => opens.at(-1)?.session).toBe(session);
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("agent-workbench:active-panel")),
      "inventory-fc",
    );
    await mkdir(evidence, { recursive: true });
    await writeFile(
      `${evidence}/rapid-switch.json`,
      JSON.stringify(
        {
          session,
          retainedAssociation: true,
          finalPage: "inventory-fc",
          finalOpenSession: opens.at(-1)?.session,
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
    await app.rpc("logout");
    await expect.poll(async () => (await identity(page)).scope).toBe(null);
    await expect(page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]')).toHaveCount(0);
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
    const reused = await page.evaluate(
      async ({ oldSession, scope }) => {
        const response = await fetch("/api/gea-html/inventory-fc/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session: oldSession,
            agentPreset: "gea-html-inventory-fc",
            scope,
          }),
        });
        return { status: response.status, value: await response.json() };
      },
      { oldSession: session, scope: after },
    );
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
    await page.route("**/api/gea-html/inventory-fc/agents", async (route) => {
      if (heldAgents) return route.continue();
      heldAgents = true;
      const response = await route.fetch();
      agentsHeld.resolve(response.status());
      await release.promise;
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([
            { preset: "gea-html-inventory-fc", label: "分仓" },
            { preset: "gea-html-inventory-qll", label: "全链" },
          ]),
        })
        .catch(() => {});
    });
    let heldOpen = false;
    await page.route("**/api/gea-html/inventory-fc/open", async (route) => {
      if (heldOpen) return route.continue();
      heldOpen = true;
      const response = await route.fetch();
      openHeld.resolve(response.status());
      await release.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.reload();
    assert.equal(await agentsHeld.promise, 200);
    assert.equal(await openHeld.promise, 200);
    await app.rpc("logout");
    await expect
      .poll(async () =>
        page.evaluate(() =>
          JSON.parse(sessionStorage.getItem("agent-workbench:v1") ?? "[]").some(
            (row) => row[0] === "inventory-fc",
          ),
        ),
      )
      .toBe(false);
    release.resolve();
    await page.waitForTimeout(300);
    await expect(page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]')).toHaveCount(0);
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
    await page.route("**/api/gea-html/inventory-fc/call", async (route) => {
      const body = route.request().postDataJSON();
      if (intercepted || body.method !== "access") return route.continue();
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
    await expect(page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]')).toHaveCount(0);
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
    const before = (await identity(page)).scope;
    const switched = await app.rpc("environment/select", { environment: "production" });
    assert.equal(switched.ok, true);
    assert.equal(switched.value.environment, "production");
    assert.equal(switched.value.authenticated, false);
    await expect.poll(async () => (await identity(page)).scope).toBe(null);
    await expect(page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]')).toHaveCount(0);
    await app.login();
    const after = (await identity(page)).scope;
    assert.equal(typeof after, "string");
    assert.notEqual(after, before);
    const denied = await page.evaluate(
      async ({ session, scope }) => {
        const response = await fetch("/api/gea-html/inventory-fc/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session, agentPreset: "gea-html-inventory-fc", scope }),
        });
        return { status: response.status, value: await response.json() };
      },
      { session, scope: after },
    );
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
