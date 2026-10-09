import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";

const plan = {
  planId: "9007199254740993",
  versionId: "version-1",
  seq: 1,
  periodId: "period-1",
  planTypeCode: "Y",
  dealerCode: "dealer-a",
  status: 1,
  currentQty: "26445.000",
  targetQty: "26445.000",
  currentAmount: "2064404.28",
  targetAmount: "1539999.99",
  baseName: "华东",
  orgName: "上海网点经销组",
  orgCode: "org-a",
  provinceName: "浙江经销业务",
  provinceCode: "province-a",
  skuCount: 1,
};

test(
  "workbench login, brand label, avatar settings and responsive layout use the current shell",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        environment: "test",
        geaEnvironments: {
          production: base + "/production",
          test: base + "/test",
        },
      }),
    });

    app.route((request, res, reply) => {
      const path = request.url.pathname;
      if (path.endsWith("/getUserInfo")) {
        reply({ success: true, result: { userInfo: {
          id: "9007199254740993", realname: "测试用户", loginTenantId: "0",
          avatar: "https://avatar.example.test/lark.png",
        } } });
        return true;
      }
      const task = {
        id: "task",
        approval: {
          biz_key: `sales-plan:version:${plan.versionId}`,
          instance_id: "instance",
          actionable: true,
        },
      };
      if (path.endsWith("/notifications")) {
        reply({ success: true, result: { items: [task], total: 1 } });
        return true;
      }
      if (path.endsWith("/notifications/task")) {
        reply({ success: true, result: task });
        return true;
      }
      if (path.endsWith("/plans")) {
        const status = request.url.searchParams.get("status");
        const records = status === null || status === "1" ? [plan] : [];
        reply({
          success: true,
          result: {
            records,
            total: records.length,
            pages: 1,
            current: 1,
            size: 20,
          },
        });
        return true;
      }
      if (path.endsWith("/plans/" + plan.planId)) {
        reply({
          success: true,
          result: {
            currentVersion: { ...plan, id: plan.versionId, effective: true },
            versions: [{ ...plan, id: plan.versionId }],
            skus: [],
            logs: [],
          },
        });
        return true;
      }
      if (path.endsWith("/versions")) {
        reply({ success: true, result: [{ ...plan, id: plan.versionId }] });
        return true;
      }
      return false;
    });
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
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
    await page.route("https://avatar.example.test/lark.png", route => route.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"),
    }));
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    let allowLogin = false;
    await page.route("**/api/gea-proof/login/poll", (route) =>
      allowLogin
        ? route.continue()
        : route.fulfill({ json: { ok: true, value: { status: "pending" } } }),
    );
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = page.frameLocator("iframe[data-gea-workbench]");
    try {
      await frame
        .getByRole("button", { name: "刷新二维码", exact: true })
        .waitFor();
      await frame.locator(".gea-login-qr img").waitFor();
      await frame.getByRole("radio", { name: "测试", exact: true }).waitFor();
      assert.equal(
        await frame
          .getByRole("radio", { name: "测试", exact: true })
          .isChecked(),
        true,
      );
      assert.equal(
        await frame.locator('input[type="url"], input[type="text"]').count(),
        0,
      );
      assert.equal(await page.locator('[contenteditable="true"]').count(), 0);
      const loginBounds = await page
        .locator("iframe[data-gea-workbench]")
        .boundingBox();
      assert.deepEqual(loginBounds, { x: 0, y: 0, width: 1536, height: 920 });
      await mkdir(".runtime/web-evidence", { recursive: true });
      await page.screenshot({
        path: ".runtime/web-evidence/login-desktop.png",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: ".runtime/web-evidence/login-mobile.png" });
      await page.setViewportSize({ width: 1536, height: 920 });
      await frame.getByRole("radio", { name: "正式", exact: true }).check();
      await frame
        .getByRole("button", { name: "刷新二维码", exact: true })
        .waitFor();
      await frame.getByRole("radio", { name: "测试", exact: true }).check();
      await frame.locator(".gea-login-qr img").waitFor();
      allowLogin = true;
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await frame.getByText("华东", { exact: true }).first().waitFor();
      await page
        .getByRole("navigation", { name: "业务导航", exact: true })
        .waitFor();
      // 侧栏二级条目要和一级标题左对齐：文字同一竖线，命中区同一左边缘，二级只少一个图标。
      const navRows = await page
        .locator(".gea-shell-nav-heading, .gea-shell-nav-child")
        .evaluateAll((buttons) =>
          buttons.map((button) => ({
            child: button.classList.contains("gea-shell-nav-child"),
            hit: Math.round(button.getBoundingClientRect().x),
            label: Math.round(button.querySelector("span").getBoundingClientRect().x),
          })),
        );
      const headings = navRows.filter((row) => !row.child);
      const children = navRows.filter((row) => row.child);
      assert.ok(headings.length > 0 && children.length > 0, JSON.stringify(navRows));
      assert.deepEqual(
        [...new Set(children.map((row) => row.label))],
        [headings[0].label],
        JSON.stringify(navRows),
      );
      assert.deepEqual(
        [...new Set(children.map((row) => row.hit))],
        [headings[0].hit],
        JSON.stringify(navRows),
      );
      // 业务条目与其导航容器左边缘一致；主线原生侧栏保留外层留白。
      const navigationBox = await page.locator(".gea-shell-navigation").boundingBox();
      assert.ok(
        Math.abs(headings[0].hit - navigationBox.x) <= 2 && children.every((row) => Math.abs(row.hit - navigationBox.x) <= 2),
        JSON.stringify(navRows),
      );
      // 「AI 工作台」入口（原生新建会话）也走同一条左线：整块贴左、内容左对齐。
      const newSession = await page
        .locator('button[class*="_newSession"]')
        .evaluate((button) => {
          const icon = button.querySelector("svg, img");
          return {
            justify: getComputedStyle(button).justifyContent,
            hit: Math.round(button.getBoundingClientRect().x),
            icon: icon ? Math.round(icon.getBoundingClientRect().x) : null,
          };
        });
      assert.equal(newSession.justify, "flex-start", JSON.stringify(newSession));
      assert.ok(
        newSession.hit <= 2 && newSession.icon !== null && newSession.icon <= 12,
        JSON.stringify(newSession),
      );
      assert.equal(await page.locator(".gea-agent-panel").count(), 0);
      assert.equal(await frame.locator("textarea").count(), 0);
      const bounds = await page
        .locator("iframe[data-gea-workbench]")
        .boundingBox();
      assert.ok(bounds.x > 200 && bounds.width < 1100, JSON.stringify(bounds));
      // The embedded workbench must resize its columns independently of the outer window.
      const workbenchFrame = page.locator("iframe[data-gea-workbench]");
      const originalStyle = await workbenchFrame.getAttribute("style");
      for (const width of [860, 1200, 580]) {
        await workbenchFrame.evaluate((element, width) => {
          element.style.setProperty("position", "fixed", "important");
          element.style.setProperty("inset", "0 auto auto 0", "important");
          element.style.setProperty("z-index", "9999", "important");
          element.style.setProperty("width", `${width}px`, "important");
          element.style.setProperty("min-width", `${width}px`, "important");
          element.style.setProperty("max-width", `${width}px`, "important");
        }, width);
        const table = frame.locator(".arco-table-content-inner").first();
        await expect.poll(() => table.evaluate((element) => ({
          viewport: element.clientWidth,
          table: Math.round(element.querySelector("table").getBoundingClientRect().width),
        }))).toMatchObject({ viewport: width - 1, table: Math.max(660, width - 1) });
        const headers = await table.locator("thead th").evaluateAll((cells) =>
          cells.map((cell) => ({
            left: cell.getBoundingClientRect().left,
            right: cell.getBoundingClientRect().right,
          }))
        );
        for (let index = 1; index < headers.length; index++) {
          assert.ok(headers[index].left >= headers[index - 1].right - 1, JSON.stringify(headers));
        }
        await workbenchFrame.screenshot({ path: `.runtime/web-evidence/approval-columns-${width}.png` });
      }
      await workbenchFrame.evaluate((element, style) => {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      }, originalStyle);
      await frame.getByRole("tab", { name: "按区域", exact: true }).click();
      await frame.locator("tbody label.arco-checkbox").first().click();
      const approve = frame.getByRole("button", { name: "通过", exact: true });
      const reject = frame.getByRole("button", { name: "退回", exact: true });
      await expect(approve).toBeEnabled();
      await expect(reject).toBeEnabled();
      // Approval now submits directly; exercise the cancellable rejection form without writing.
      await reject.click();
      const approvalDialog = frame.getByRole("dialog", { name: "退回", exact: true });
      await expect(approvalDialog.getByRole("textbox", { name: "退回原因（必填）", exact: true })).toBeVisible();
      await expect(approvalDialog.getByRole("button", { name: "确认退回", exact: true })).toBeDisabled();
      await approvalDialog
        .getByRole("button", { name: "取消", exact: true })
        .click();
      if (!(await frame.getByTestId('regional-approval-flow-lane').isVisible()))
        await frame.getByTestId('regional-approval-flow-toggle').click();
      await expect(frame.getByTestId('regional-approval-stage-province')).toBeDisabled();
      const currentStage = frame.getByTestId('regional-approval-stage-region');
      await currentStage.click();
      await expect(currentStage).toHaveAttribute('aria-pressed', 'false');
      await expect(approve).toBeDisabled();
      await currentStage.click();
      await expect(currentStage).toHaveAttribute('aria-pressed', 'true');
      assert.equal(
        app.requests.some(
          (r) => r.method === "POST" && r.url.pathname.endsWith("/actions"),
        ),
        false,
      );

      assert.equal(
        await frame
          .getByRole("combobox", { name: "分析范围", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await frame
          .getByRole("button", { name: "预览发送范围", exact: true })
          .count(),
        0,
      );
      const brand = page.locator(".gea-brand-switch");
      const avatarImage = page.locator(".gea-user-avatar img");
      await expect(avatarImage).toHaveAttribute("src", "https://avatar.example.test/lark.png");
      await expect.poll(() => avatarImage.evaluate(img => img.naturalWidth)).toBe(1);
      await avatarImage.dispatchEvent("error");
      await expect(page.locator(".gea-user-avatar")).toHaveText("测");
      const brandLogo = page.locator(".gea-shell-logo");
      assert.equal(await brandLogo.evaluate((el) => el.tagName), "IMG");
      assert.match(
        await brandLogo.getAttribute("src"),
        /^data:image\/png;base64,/,
      );
      // 客户端名：左上角品牌文字与窗口标题都用「Synear GEA」。
      assert.equal(
        await page.locator(".gea-brand-title").textContent(),
        "Synear GEA",
      );
      assert.equal(await page.title(), "Synear GEA");
      assert.equal(
        await page
          .locator('[data-slot="sidebar.brand.name"] span')
          .evaluate((el) => getComputedStyle(el).color),
        process.env.GEA_TEST_SOURCE_CORE === "1" ? "rgb(223, 23, 50)" : "rgb(215, 10, 28)",
      );
      assert.equal(
        await page
          .locator(".gea-user-avatar")
          .evaluate((el) => getComputedStyle(el).borderRadius),
        "50%",
      );
      // The brand mark is a label now: clicking it must not swap the page.
      await brand.click();
      await expect(page.locator("iframe[data-gea-workbench]")).toBeVisible();
      for (const view of ["business", "conversation"]) {
        if (view === "conversation") {
          await page.getByRole("button", { name: "AI工作台", exact: true }).click();
          await expect(page.locator("iframe[data-gea-workbench]")).toHaveCount(0);
        }
        await page.getByRole("button", { name: "账户菜单", exact: true }).click();
        await page.getByRole("menuitem", { name: "设置", exact: true }).click();
        await page
          .getByRole("button", { name: "通用设置", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "关闭", exact: true }).click();
      }
      // Back to the business page so the reload below still restores the workbench.
      await page.locator('[data-gea-business-entry="gea-proof"]').click();
      await expect(page.locator("iframe[data-gea-workbench]")).toBeVisible();
      assert.equal(
        await page
          .getByRole("button", { name: "DSH 对话", exact: true })
          .count(),
        0,
      );
      await page.reload();
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.locator('[data-conversation-stacked="true"]').waitFor();
      assert.equal(
        await page
          .locator('[data-conversation-stacked="true"]')
          .evaluate((element) => getComputedStyle(element).transitionDuration),
        "0s",
      );
      await frame
        .getByRole("heading", { name: "销售计划审批", exact: true })
        .waitFor();
      await page.locator('[contenteditable="true"]').waitFor();
      const narrowFrame = await page
        .locator("iframe[data-gea-workbench]")
        .boundingBox();
      assert.ok(
        narrowFrame && narrowFrame.height > 150 && narrowFrame.width > 250,
        JSON.stringify(narrowFrame),
      );
      await page.screenshot({ path: ".runtime/web-evidence/narrow.png" });
      assert.deepEqual(errors, []);
    } catch (error) {
      await mkdir(".runtime/web-evidence", { recursive: true });
      await page.screenshot({ path: ".runtime/web-evidence/failure.png" });
      throw new Error(
        `${error.message}\nBrowser: ${errors.join("\n")}\nDOM: ${(await page.locator("body").innerText()).slice(0, 3000)}`,
      );
    }
  },
);
