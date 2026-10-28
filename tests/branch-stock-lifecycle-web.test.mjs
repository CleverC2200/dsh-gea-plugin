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
import {
  pageRequest,
  assertOwnerReleased,
  presentation,
  evidence,
} from "./fixtures/branch-stock-lifecycle.mjs";

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
