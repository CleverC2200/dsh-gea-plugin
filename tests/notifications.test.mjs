import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { profile, until } from "./profile.mjs";

test(
  "GEA inbox reads preserve paging and identity, reject invalid responses and never mutate notification state",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        geaEnvironments: { production: base, test: base + "/test" },
      }),
    });
    let mode = "success";
    let release;
    const item = {
      id: "notice-1",
      title: "Fixture task",
      summary: "Review fixture",
      state: "unread",
      kind: "approval",
      aggregate_id: "plan-1",
      source: { type: "workflow", ref: "external-session-1", label: "GEA" },
    };
    app.route((req, res, reply) => {
      if (!req.url.pathname.includes("/api/v1/notifications")) return false;
      assert.equal(req.method, "GET");
      if (mode === "hold") {
        release = () =>
          reply({
            success: true,
            result: { items: [item], total: 1, unread_count: 1 },
          });
        return true;
      }
      assert.ok(req.headers["x-access-token"]);
      if (mode === "denied") {
        reply({ success: false }, 403);
        return true;
      }
      if (mode === "expired") {
        reply({ success: false, errorCode: "NOTIFICATION_UNAUTHENTICATED" });
        return true;
      }
      if (req.url.pathname.endsWith("/notice-1")) {
        reply({
          success: true,
          result: {
            ...item,
            id: mode === "wrong" ? "notice-2" : item.id,
            payload_projection: { secret: "do-not-project" },
          },
        });
        return true;
      }
      reply({
        success: true,
        result: {
          items:
            mode === "empty"
              ? []
              : mode === "duplicate"
                ? [item, item]
                : [item],
          total: mode === "empty" ? 0 : 3,
          unread_count: 2,
        },
      });
      return true;
    });
    assert.equal(
      (await app.rpc("notifications", {})).error.code,
      "LOGIN_REQUIRED",
    );
    await app.login();
    const plans = (await app.rpc("plans")).value;
    const preview = (
      await app.rpc("prepare", {
        queryId: plans.queryId,
        planId: plans.records[0].planId,
      })
    ).value;
    const page = await app.rpc("notifications", { pageNo: 1 });
    assert.equal(page.value.total, 3);
    assert.equal(page.value.coverage, "partial");
    assert.equal(page.value.unreadCount, 2);
    const detail = (await app.rpc("notifications", { id: "notice-1" })).value
      .detail;
    assert.equal(detail.source.ref, "external-session-1");
    assert.equal(JSON.stringify(detail).includes("do-not-project"), false);
    assert.equal(
      (await app.rpc("submit", { previewId: preview.previewId })).ok,
      true,
    );
    const before = app.requests.length;
    assert.equal(
      (await app.rpc("notifications", { tenantId: "forged" })).ok,
      false,
    );
    assert.equal(app.requests.length, before);
    mode = "wrong";
    assert.equal(
      (await app.rpc("notifications", { id: "notice-1" })).error.code,
      "NOTIFICATION_INVALID_RESPONSE",
    );
    mode = "duplicate";
    assert.equal(
      (await app.rpc("notifications", {})).error.code,
      "NOTIFICATION_INVALID_RESPONSE",
    );
    mode = "success";
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext({ locale: "zh-CN" });
    await context.addCookies(
      app.cookie.split("; ").map((c) => ({
        name: c.slice(0, c.indexOf("=")),
        value: c.slice(c.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const ui = await context.newPage();
    await ui.goto(app.origin);
    await ui.getByRole("button", { name: "消息待办", exact: true }).click();
    await ui
      .getByRole("button", { name: "Fixture task", exact: true })
      .waitFor();
    await mkdir(".runtime/web-evidence", { recursive: true });
    await ui.screenshot({ path: ".runtime/web-evidence/inbox.png" });
    await ui.getByRole("button", { name: "Fixture task", exact: true }).click();
    await ui.getByText("external-session-1", { exact: true }).waitFor();
    await ui.getByRole("button", { name: "返回消息列表", exact: true }).click();
    await ui
      .getByRole("button", { name: "Fixture task", exact: true })
      .waitFor();
    mode = "denied";
    await ui.getByRole("button", { name: "刷新消息", exact: true }).click();
    await ui.getByRole("alert").waitFor();
    assert.equal(
      await ui
        .getByRole("button", { name: "Fixture task", exact: true })
        .count(),
      0,
    );
    assert.match(await ui.getByRole("alert").innerText(), /权限/);
    mode = "empty";
    await ui.getByRole("button", { name: "刷新消息", exact: true }).click();
    await ui.getByText("本次查询没有记录", { exact: true }).waitFor();
    mode = "expired";
    assert.equal(
      (await app.rpc("notifications", {})).error.code,
      "NOTIFICATION_UNAUTHENTICATED",
    );
    assert.equal((await app.rpc("status")).value.authenticated, false);
    await app.login();
    mode = "hold";
    const pending = app.rpc("notifications", {});
    await until(() => Boolean(release), Boolean);
    assert.equal(
      (await app.rpc("environment/select", { environment: "test" })).ok,
      true,
    );
    release();
    assert.equal((await pending).ok, false);
    assert.equal((await app.rpc("status")).value.authenticated, false);
  },
);
