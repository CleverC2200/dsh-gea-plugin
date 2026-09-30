import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";
import { readSession, until } from "./profile.mjs";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

for (const transition of ["user", "tenant", "environment"]) test(`native regional page cannot restore an old identity Session after ${transition} changes`, {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 120000,
}, async t => {
  const { app, page, identity } = await stockReferencePage(t, { environments: transition === "environment" });
  const binding = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("agent-workbench:v1") ?? "[]")
    .find(row => row[0] === "gea-regional-plan"));
  await page.locator('[data-gea-business-entry="gea-regional-plan"]').click();
  await expect.poll(binding).toBeTruthy();
  const before = await binding(), session = before[2][0][1];
  const marker = `旧身份专属测试标记-${transition}`;
  assert.equal((await app.remote("session/selectModel", { sessionId: session, provider: "gea-analysis", model: "fixture" })).ok, true);
  assert.equal((await app.remote("session/prompt", { requestId: randomUUID(), sessionId: session, mode: "queue", content: [{ type: "text", text: marker }] })).ok, true);
  await until(() => readSession(app.runtime, session), rows => rows.some(row => row.type === "turn/end"), 30000);
  await page.reload();
  await page.locator('[data-gea-business-entry="gea-regional-plan"]').click();
  await expect.poll(async () => (await binding())?.[2]?.[0]?.[1]).toBe(session);
  await expect(page.getByText(marker, { exact: true }).last()).toBeVisible();
  if (transition === "environment") await app.rpc("environment/select", { environment: "production" });
  else await app.rpc("logout");
  if (transition === "user") identity.userId = "9007199254740994";
  if (transition === "tenant") identity.tenantId = "1";
  await app.login();
  await page.reload();
  await page.locator('[data-gea-business-entry="gea-regional-plan"]').click();
  try { await expect.poll(binding).toBeTruthy(); }
  catch (error) {
    await mkdir(".runtime/review-08-evidence", { recursive: true });
    await writeFile(`.runtime/review-08-evidence/native-${transition}-open-failure.json`, JSON.stringify(await page.evaluate(() => ({
      rows: sessionStorage.getItem("agent-workbench:v1"), panel: sessionStorage.getItem("agent-workbench:active-panel"),
      selected: [...document.querySelectorAll("[data-gea-business-entry][aria-current='page']")].map(el => el.getAttribute("data-gea-business-entry")),
      text: document.body.innerText.slice(-3500),
    })), null, 2));
    throw error;
  }
  try {
    await expect.poll(async () => (await binding())?.[2]?.[0]?.[1]).not.toBe(session);
  } finally {
    const after = await binding();
    const oldMarkerVisible = await page.getByText(marker, { exact: true }).last().isVisible();
    const persisted = await readSession(app.runtime, session);
    await mkdir(".runtime/review-08-evidence", { recursive: true });
    await writeFile(`.runtime/review-08-evidence/native-${transition}.json`, JSON.stringify({ transition, before, after, oldMarkerVisible, durableOldSessionStillExists: persisted.length > 0 }, null, 2));
    assert.ok(persisted.length > 0, "identity invalidation must not delete the durable background Session");
  }
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
});

for (const panel of ["gea-proof", "gea-inbox"]) test(`a mounted native ${panel} invalidates its association on logout without deleting its Session`, {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 120000,
}, async t => {
  const { app, page } = await stockReferencePage(t);
  const binding = () => page.evaluate(id => JSON.parse(sessionStorage.getItem("agent-workbench:v1") ?? "[]").find(row => row[0] === id), panel);
  if (panel === "gea-inbox") await page.locator(".gea-inbox-quick-action").click();
  else await page.locator(`[data-gea-business-entry="${panel}"]`).click();
  await expect.poll(async () => (await binding())?.[2]?.[0]?.[1]).toMatch(/^session-/);
  const before = await binding(), session = before[2][0][1];
  await app.rpc("logout");
  await expect.poll(async () => (await binding())?.[2]?.[0]?.[1]).not.toBe(session);
  await app.login();
  const authority = await page.evaluate(async () => (await (await fetch("/api/gea-html/identity")).json()).scope);
  await expect.poll(async () => (await binding())?.[3]).toBe(authority);
  await expect.poll(async () => (await binding())?.[2]?.[0]?.[1]).toMatch(/^session-/);
  const after = await binding();
  assert.notEqual(after[2][0][1], session);
  assert.notEqual(after[3], "gea:anonymous");
  assert.ok((await readSession(app.runtime, session)).length > 0);
  await mkdir(".runtime/review-08-evidence", { recursive: true });
  await writeFile(`.runtime/review-08-evidence/native-live-${panel}.json`, JSON.stringify({ panel, before, after, durableOldSessionStillExists: true }, null, 2));
});


test("a failed first identity observation cannot leave an independently opened native Session bound to a prior user", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 120000,
}, async t => {
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  let calls = 0, firstFailed = false;
  const { app, page, identity } = await stockReferencePage(t, { preparePage: async page => {
    page.on("requestfailed", request => { if (request.url().endsWith("/api/gea-html/identity")) firstFailed = true; });
    await page.route("**/api/gea-html/identity", async route => {
      if (++calls > 1) return route.continue();
      await release.promise;
      await route.abort().catch(() => {});
    });
  } });
  const binding = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("agent-workbench:v1") ?? "[]")
    .find(row => row[0] === "gea-regional-plan"));
  try {
    await page.locator('[data-gea-business-entry="gea-regional-plan"]').click();
    await expect.poll(async () => (await binding())?.[2]?.[0]?.[1]).toMatch(/^session-/);
    const before = await binding(), session = before[2][0][1];
    assert.equal(firstFailed, false, "the page must bind independently before the first observation finishes");
    await app.rpc("logout");
    identity.userId = "9007199254740994";
    await app.login();
    await expect.poll(() => firstFailed, { timeout: 7000 }).toBe(true);
    try {
      await expect.poll(async () => (await binding())?.[2]?.[0]?.[1], { timeout: 7000 }).not.toBe(session);
    } finally {
      await mkdir(".runtime/review-08-evidence", { recursive: true });
      await writeFile(".runtime/review-08-evidence/first-observation.json", JSON.stringify({ before, after: await binding(), firstFailed, identityRequests: calls }, null, 2));
    }
  } finally { release.resolve(); }
});
