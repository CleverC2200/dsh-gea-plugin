import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

test(
  "tenant and user changes reject the old page Session, owner and reference",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const { app, page, session, owner, identity, quote, readReference } =
      await stockReferencePage(t);
    const identitySnapshot = () =>
      page.evaluate(async () => {
        const response = await fetch("/api/gea-html/identity", { cache: "no-store" });
        return response.json();
      });
    const operation = (body) =>
      page.evaluate(async (body) => {
        const response = await fetch("/api/agent-workbench/page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      }, body);
    const before = await identitySnapshot();
    assert.equal(typeof before.scope, "string");
    assert.equal(typeof before.subject, "string");
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/page-interaction/reference") && response.status() === 200,
    );
    await quote();
    const reference = await (await saved).json();
    assert.match(reference.id, /^R[a-f0-9]{12}$/);
    const observations = [];
    for (const changed of [
      { kind: "tenant", userId: "9007199254740993", tenantId: "1" },
      { kind: "user", userId: "9007199254740994", tenantId: "0" },
    ]) {
      await app.rpc("logout");
      await expect.poll(async () => (await identitySnapshot()).scope).toBe(null);
      identity.userId = changed.userId;
      identity.tenantId = changed.tenantId;
      assert.equal((await app.login()).ok, true);
      await expect.poll(async () => (await identitySnapshot()).subject).not.toBe(before.subject);
      const current = await identitySnapshot();
      assert.equal(typeof current.subject, "string");
      assert.equal(typeof current.scope, "string");
      assert.notEqual(current.scope, before.scope);
      const deniedSession = await operation({
        operation: "open",
        pageId: "inventory-fc",
        sessionId: session,
        resourceId: "gea-html-inventory-fc",
      });
      assert.equal(deniedSession.status, 400);
      assert.equal(deniedSession.value.error, "PAGE_SESSION_IDENTITY_MISMATCH");
      const deniedOwner = await operation({ operation: "access", owner });
      assert.equal(deniedOwner.status, 400);
      assert.equal(deniedOwner.value.error, "PAGE_OWNER_RELEASED");
      const deniedReference = await readReference(reference.id);
      assert.match(deniedReference.text, /REFERENCE_UNAVAILABLE/);
      observations.push({
        kind: changed.kind,
        subject: current.subject,
        scope: current.scope,
        deniedSession,
        deniedOwner,
        reference: deniedReference.text,
      });
    }
    await mkdir(".runtime", { recursive: true });
    const evidence = await mkdtemp(".runtime/branch-stock-identity-owner-");
    t.diagnostic("identity owner evidence: " + evidence);
    await writeFile(
      evidence + "/isolation.json",
      JSON.stringify(
        {
          session,
          owner,
          referenceId: reference.id,
          before: { subject: before.subject, scope: before.scope },
          observations,
        },
        null,
        2,
      ),
    );
  },
);
