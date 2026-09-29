import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

for (const mode of ["logout", "new-user"]) test(`a delayed reference POST cannot restore an old Session after ${mode}`, {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 120000,
}, async t => {
  const { app, page, identity, session, quote, readReference } = await stockReferencePage(t);
  const firstRequest = page.waitForRequest(request => request.url().endsWith("/api/page-interaction/reference"));
  const first = page.waitForResponse(response => response.url().endsWith("/api/page-interaction/reference") && response.status() === 200);
  await quote();
  const original = await (await first).json();
  assert.match((await readReference(original.id)).text, /USER_PAGE_REFERENCE/);
  const valid = (await firstRequest).postDataJSON();
  assert.equal(typeof valid.lease, "string");
  const other = await app.remote("session/create", { cwd: app.runtime + "/workspace", agentPreset: "gea-readonly" });
  assert.equal(other.ok, true);
  for (const invalid of [
    { ...valid, lease: undefined },
    { ...valid, surface: "gea-workbench", lease: undefined },
    { ...valid, sessionId: other.value.sessionId },
  ]) {
    const denied = await fetch(app.origin + "/api/page-interaction/reference", { method: "POST", headers: { Cookie: app.cookie, "Content-Type": "application/json" }, body: JSON.stringify(invalid) });
    assert.notEqual(denied.status, 200);
  }
  await page.locator('[contenteditable="true"]').first().fill("");
  const pending = Promise.withResolvers(), release = Promise.withResolvers(), completed = Promise.withResolvers();
  let payload;
  await page.route("**/api/page-interaction/reference", async route => {
    payload = route.request().postDataJSON();
    pending.resolve();
    await release.promise;
    const response = await route.fetch();
    const outcome = { status: response.status(), value: await response.json() };
    completed.resolve(outcome);
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await quote();
    await pending.promise;
    await app.rpc("logout");
    if (mode === "new-user") { identity.userId = "9007199254740994"; await app.login(); }
    release.resolve();
    const outcome = await completed.promise;
    const receipt = await readReference(outcome.value.id ?? original.id);
    await mkdir(".runtime/reference-identity-evidence", { recursive: true });
    await writeFile(`.runtime/reference-identity-evidence/${mode}.json`, JSON.stringify({
      mode, session, surface: payload.surface, leasePresented: typeof payload.lease === "string", outcome, receipt,
    }, null, 2));
    assert.match(receipt.text, /REFERENCE_UNAVAILABLE/);
    assert.notEqual(outcome.status, 200);
    // A direct POST cannot evade the protected Session by claiming a different page surface.
    const currentBinding = await (await fetch(app.origin + "/api/page-interaction/binding", { headers: { Cookie: app.cookie } })).json();
    const direct = await fetch(app.origin + "/api/page-interaction/reference", { method: "POST", headers: { Cookie: app.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, ...currentBinding, surface: "gea-workbench", lease: undefined }) });
    assert.notEqual(direct.status, 200);
  } finally {
    release.resolve();
  }
});

for (const mode of ["logout", "new-user"]) test(`a saved response delayed until after ${mode} cannot insert a cleared receipt`, {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const { app, page, identity, quote, readReference } = await stockReferencePage(t);
  const stored = Promise.withResolvers(), release = Promise.withResolvers(), delivered = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route("**/api/page-interaction/reference", async route => {
    const response = await route.fetch();
    stored.resolve({ status: response.status(), receipt: await response.json() });
    await release.promise;
    await route.fulfill({ response }).catch(() => {});
    delivered.resolve();
  });
  try {
    await quote();
    const outcome = await stored.promise;
    assert.equal(outcome.status, 200, "the Host has already saved this reference");
    await app.rpc("logout");
    if (mode === "new-user") { identity.userId = "9007199254740994"; await app.login(); }
    release.resolve();
    await delivered.promise;
    await page.waitForTimeout(500);
    const composer = await page.locator('[contenteditable="true"]').first().innerText();
    const read = await readReference(outcome.receipt.id);
    await mkdir(".runtime/reference-identity-evidence", { recursive: true });
    await writeFile(`.runtime/reference-identity-evidence/response-${mode}.json`, JSON.stringify({ mode, outcome, composer, read }, null, 2));
    assert.match(read.text, /REFERENCE_UNAVAILABLE/);
    assert.equal(composer.trim(), "", "a cleared reference must not be presented as usable after identity changes");
  } finally { release.resolve(); }
});
