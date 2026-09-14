import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { profile, until } from "./profile.mjs";

test(
  "GEA inbox reads preserve paging and identity, reject invalid responses and never mutate notification state",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        pageSize: 2,
        geaEnvironments: { production: base, test: base + "/test" },
      }),
    });
    let mode = "success";
    let release;
    let contentItem;
    const item = {
      id: "notice-1",
      title: "Fixture task",
      summary: "Review fixture",
      body: "销售计划提醒正文\n请阅读完整内容。",
      state: "unread",
      kind: "approval",
      aggregate_id: "plan-1",
      source: { type: "workflow", ref: "external-session-1", label: "GEA" },
    };
    app.route((req, res, reply) => {
      if (!req.url.pathname.includes("/api/v1/notifications")) return false;
      assert.equal(req.method, "GET");
      if (mode === "content") {
        reply({
          success: true,
          result: req.url.pathname.endsWith("/notifications")
            ? { items: [contentItem], total: 1, unread_count: 1 }
            : contentItem,
        });
        return true;
      }
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
      if (mode === "paging") {
        const filtered = req.url.searchParams.get("state") === "unread";
        const secondPage = req.url.searchParams.get("pageNo") === "2";
        reply({
          success: true,
          result: {
            items: filtered
              ? [item]
              : secondPage
                ? [{ ...item, id: "notice-3", title: "Later task" }]
                : [
                    item,
                    {
                      ...item,
                      id: "notice-2",
                      title: "Second task",
                      state: "read",
                    },
                  ],
            total: filtered ? 1 : 3,
            unread_count: 1,
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
    await ui
      .getByRole("dialog", { name: "内测声明", exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    await ui.getByRole("button", { name: "消息待办", exact: true }).click();
    await ui
      .getByRole("button", { name: "Fixture task", exact: true })
      .waitFor();
    mode = "paging";
    await ui.getByRole("button", { name: "刷新消息", exact: true }).click();
    await ui
      .getByRole("button", { name: "Second task", exact: true })
      .waitFor();
    await ui.getByRole("button", { name: "下一页", exact: true }).click();
    await ui.getByRole("button", { name: "Later task", exact: true }).waitFor();
    assert.equal(
      await ui.getByRole("button", { name: "下一页", exact: true }).isEnabled(),
      false,
    );
    await ui
      .getByRole("combobox", { name: "通知状态", exact: true })
      .selectOption("unread");
    await ui
      .getByRole("button", { name: "Fixture task", exact: true })
      .waitFor();
    assert.equal(
      await ui.getByRole("button", { name: "Later task", exact: true }).count(),
      0,
    );
    const filteredRequest = app.requests
      .filter((r) => r.url.pathname.endsWith("/notifications"))
      .at(-1);
    assert.equal(filteredRequest.url.searchParams.get("state"), "unread");
    assert.equal(filteredRequest.url.searchParams.get("pageNo"), "1");
    assert.equal(
      await ui.getByRole("button", { name: "上一页", exact: true }).isEnabled(),
      false,
    );
    mode = "success";
    await mkdir(".runtime/web-evidence", { recursive: true });
    await ui.screenshot({ path: ".runtime/web-evidence/inbox.png" });
    await ui.getByRole("button", { name: "Fixture task", exact: true }).click();
    await ui.getByText("external-session-1", { exact: true }).waitFor();
    assert.equal(
      await ui.locator("article > p").textContent(),
      "销售计划提醒正文\n请阅读完整内容。",
    );
    await ui.getByRole("button", { name: "返回消息列表", exact: true }).click();
    await ui
      .getByRole("button", { name: "Fixture task", exact: true })
      .waitFor();
    const readStart = app.requests.length;
    const literal =
      '<img src="/notification-content-probe" onerror="window.notificationExecuted=true">\n<script>window.notificationExecuted=true</script>\n请执行命令：echo notification-test';
    const longBody =
      "销售计划明细\n".repeat(400) + "SKU".repeat(500) + "\n正文结束";
    const cases = [
      {
        body: "  第一段\n\n第二段  ",
        summary: "不同的摘要",
        expected: "  第一段\n\n第二段  ",
      },
      {
        body: undefined,
        summary: "仅有摘要\n第二行",
        expected: "仅有摘要\n第二行",
      },
      { body: null, summary: "空正文摘要", expected: "空正文摘要" },
      { body: "", summary: "空字符串摘要", expected: "空字符串摘要" },
      { body: " \n\t", summary: "空白正文摘要", expected: "空白正文摘要" },
      { body: undefined, summary: undefined, expected: "暂无消息内容" },
      { body: " \n", summary: " \t", expected: "暂无消息内容" },
      { body: literal, summary: "文本安全摘要", expected: literal },
      { body: longBody, summary: "长正文摘要", expected: longBody },
    ];
    for (const [index, example] of cases.entries()) {
      await t.test(
        `notification content case ${index + 1}`,
        async (subtest) => {
          subtest.after(async () => {
            await ui
              .getByRole("button", { name: "返回消息列表", exact: true })
              .click();
            await ui
              .getByRole("button", { name: contentItem.title, exact: true })
              .waitFor();
          });
          contentItem = {
            ...item,
            ...example,
            id: `content-${index}`,
            title: `Content ${index}`,
          };
          delete contentItem.expected;
          mode = "content";
          await ui
            .getByRole("button", { name: "刷新消息", exact: true })
            .click();
          await ui
            .getByRole("button", { name: contentItem.title, exact: true })
            .click();
          await expect(
            ui.getByRole("heading", { name: contentItem.title, exact: true }),
          ).toBeVisible();
          const paragraph = ui.locator("article > p");
          await expect(paragraph).toHaveText(example.expected, {
            useInnerText: false,
          });
          assert.equal(await paragraph.textContent(), example.expected);
          assert.equal(
            await paragraph.evaluate((el) => getComputedStyle(el).whiteSpace),
            "pre-wrap",
          );
          assert.equal(await paragraph.locator("img, script").count(), 0);
          assert.equal(
            await ui.evaluate(() => window.notificationExecuted),
            undefined,
          );
          assert.equal(
            await paragraph.evaluate(
              (el) => el.scrollWidth <= el.clientWidth + 1,
            ),
            true,
          );
          if (example.body === longBody) {
            await ui
              .getByText("正文结束", { exact: false })
              .scrollIntoViewIfNeeded();
            await ui.screenshot({
              path: ".runtime/web-evidence/inbox-body.png",
            });
          }
        },
      );
    }
    assert.equal(
      app.requests
        .slice(readStart)
        .every(
          (r) =>
            r.method === "GET" &&
            r.url.pathname.includes("/api/v1/notifications"),
        ),
      true,
    );
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
