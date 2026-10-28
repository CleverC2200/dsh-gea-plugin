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
    const oldFrame = await htmlFrameElement(page, "inventory-fc").elementHandle();
    assert.ok(oldFrame);
    const oldBrowsingFrame = await oldFrame.contentFrame();
    assert.ok(oldBrowsingFrame, "Capture the real authorized browsing context before reload");
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
    await expect.poll(() => oldBrowsingFrame.isDetached()).toBe(true);
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
