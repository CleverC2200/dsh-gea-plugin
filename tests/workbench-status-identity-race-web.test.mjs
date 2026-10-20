import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

// Hold the iframe's status request until the Host moves from A to B, while its
// parent still carries A's last confirmed projection.
test(
  "a late workbench status response cannot mix another user's roles with the projected identity",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const roles = [{ code: "sales_plan_region_approver", name: "区域审批" }];
    const person = { id: "9007199254740993", name: "用户A" };
    const app = await profile(t, { roles });
    app.route((request, _response, reply) => {
      if (!request.url.pathname.endsWith("/getUserInfo")) return false;
      reply({
        success: true,
        result: { userInfo: { id: person.id, realname: person.name, loginTenantId: "0" } },
      });
      return true;
    });
    await app.login();
    const authorityA = await (
      await fetch(app.origin + "/api/gea-html/identity", { headers: { Cookie: app.cookie } })
    ).json();
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => {
      window.identitySnapshots = [];
      window.addEventListener("message", (event) => {
        if (event.data?.type === "gea:identity-snapshot")
          window.identitySnapshots.push(event.data.snapshot);
      });
    });
    let holdIdentity = false,
      statusResponse;
    const statusStarted = Promise.withResolvers(),
      releaseStatus = Promise.withResolvers();
    t.after(() => releaseStatus.resolve());
    await page.route("**/api/gea-html/identity", (route) =>
      holdIdentity ? route.abort() : route.continue(),
    );
    await page.route("**/api/gea-proof/status", async (route) => {
      if (!route.request().frame().url().includes("/api/agent-workbench/native?") || statusResponse)
        return route.continue();
      const requestScope = await route
        .request()
        .frame()
        .evaluate(() => window.identitySnapshots?.at(-1)?.scope)
        .catch(() => undefined);
      if (requestScope !== authorityA.scope) return route.continue();
      statusStarted.resolve();
      await releaseStatus.promise;
      const response = await route.fetch();
      statusResponse = await response.json();
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto(app.origin);
    const frame = await openSalesPlan(page);
    await statusStarted.promise;
    const projected = () => frame.locator("body").evaluate(() => window.identitySnapshots?.at(-1));
    await expect.poll(async () => (await projected())?.scope).toBe(authorityA.scope);
    holdIdentity = true;
    await app.rpc("logout");
    person.id = "9007199254740994";
    person.name = "用户B";
    roles.splice(0, roles.length, { code: "sales_plan_province_approver", name: "省区审批" });
    await app.login();
    releaseStatus.resolve();
    await expect.poll(() => statusResponse?.value?.user?.id).toBe(person.id);
    assert.equal(
      (await projected()).scope,
      authorityA.scope,
      "the iframe must still hold A's confirmed projection",
    );
    assert.equal((await projected()).status.user.id, authorityA.status.user.id);
    assert.equal(statusResponse.value.roles[0].code, "sales_plan_province_approver");
    await expect.poll(async () => (await projected())?.error).toBeTruthy();
    const warning = (await projected()).error;
    await expect(
      page.getByRole("alert").and(page.getByTitle(warning, { exact: true })),
    ).toBeVisible();
    await page.waitForTimeout(500);
    assert.equal(
      await frame.getByTestId("regional-approval-workbench").count(),
      0,
      "B's status data must not render under A's projected identity",
    );
    await expect(frame.locator("main.gea-workbench-boot")).toBeVisible();
    const authorityB = await (
      await fetch(app.origin + "/api/gea-html/identity", { headers: { Cookie: app.cookie } })
    ).json();
    assert.equal(
      statusResponse.value.pageScope,
      authorityB.scope,
      "roles and scope must come from the same Host status",
    );
    holdIdentity = false;
    // Identity changes revoke the old owner and can replace its iframe while
    // this read is in flight. Retry the read against the current frame owner.
    await expect(async () => {
      assert.equal((await projected())?.scope, authorityB.scope);
    }).toPass({ timeout: 15000 });
    await expect(
      page.getByRole("alert").and(page.getByTitle(warning, { exact: true })),
    ).toHaveCount(0);
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  },
);
