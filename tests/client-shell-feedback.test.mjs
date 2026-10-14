/**
 * 视觉样式及功能问题反馈（客户端）回归：
 * 会话区命名、左侧菜单选中态、收起后品牌居中、AI 工作台文字对齐、
 * 宿主兜底品牌文案、销售计划筛选默认收起。
 */
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan, openBusinessPage } from "./fixtures/business-page.mjs";

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
  "客户端外壳按反馈收敛：会话区命名、菜单选中态、收起品牌居中与工作台主视觉居中",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        environment: "test",
        geaEnvironments: { production: base + "/production", test: base + "/test" },
      }),
    });
    app.route((request, res, reply) => {
      const path = request.url.pathname;
      if (path.endsWith("/getUserInfo")) {
        reply({
          success: true,
          result: {
            userInfo: { id: "9007199254740993", realname: "测试用户", loginTenantId: "0" },
          },
        });
        return true;
      }
      if (path.endsWith("/plans")) {
        reply({
          success: true,
          result: { records: [plan], total: 1, pages: 1, current: 1, size: 20 },
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
    const browser = await chromium.launch({ headless: true });
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
    let allowLogin = false;
    await page.route("**/api/gea-proof/login/poll", (route) =>
      allowLogin
        ? route.continue()
        : route.fulfill({ json: { ok: true, value: { status: "pending" } } }),
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(app.origin);
      await page
        .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
        .getByRole("button", { name: "继续", exact: true })
        .click();
      const frame = await openSalesPlan(page);
      await frame.getByRole("button", { name: "刷新二维码", exact: true }).waitFor();
      allowLogin = true;
      await frame.getByRole("heading", { name: "销售计划审批", exact: true }).waitFor();
      const menu = page.getByRole("navigation", { name: "业务导航", exact: true });
      if (!(await menu.isVisible()))
        await page.getByRole("button", { name: "业务工作台", exact: true }).first().click();
      await menu.waitFor();

      // 业务目录保留完整父子层级；分组标题贴齐抽屉左沿，子项文字与标题文字对齐。
      const supplyHeading = page.getByRole("button", { name: "产销协同", exact: true });
      await supplyHeading.waitFor();
      assert.equal(await supplyHeading.getAttribute("aria-expanded"), "true");
      await page.getByRole("button", { name: "产销协同工作台", exact: true }).waitFor();
      const menuIndent = await page.evaluate(() => {
        const workspace = Array.from(document.querySelectorAll("button")).find(
          (item) => item.textContent?.trim() === "业务工作台",
        );
        const heading = Array.from(document.querySelectorAll(".gea-shell-nav-heading")).find(
          (item) => item.textContent?.includes("计划管理"),
        );
        const headingLabel = heading?.querySelector("span");
        const childLabel = Array.from(
          document.querySelectorAll(".gea-shell-nav-child .gea-shell-label"),
        ).find((item) => item.textContent?.trim() === "销售计划");
        if (!workspace || !heading || !headingLabel || !childLabel) return null;
        return {
          headingInset: Math.round(
            heading.getBoundingClientRect().left - workspace.getBoundingClientRect().left,
          ),
          headingText: Math.round(headingLabel.getBoundingClientRect().left),
          childText: Math.round(childLabel.getBoundingClientRect().left),
        };
      });
      assert.ok(menuIndent, "business menu geometry must be measurable");
      assert.ok(Math.abs(menuIndent.headingInset) <= 2, JSON.stringify(menuIndent));
      assert.ok(
        Math.abs(menuIndent.headingText - menuIndent.childText) <= 2,
        JSON.stringify(menuIndent),
      );

      // 计划页不重复显示顶部头像标题，欢迎页统一使用 Agent。
      await page.locator(".gea-agent-welcome").waitFor();
      assert.equal(await page.locator(".gea-agent-head-sub").count(), 0);
      assert.equal(await page.locator(".gea-agent-head").count(), 0);
      assert.equal(await page.locator(".gea-agent-identity h2").textContent(), "销售计划Agent");
      assert.equal(await page.locator(".gea-agent-actions").count(), 0);

      // The Agent toolbar remains reachable in both maximized views; history
      // opens the existing native list in the left drawer.
      await page.getByRole("button", { name: "中间区域最大，隐藏会话区" }).click();
      assert.equal(
        await page
          .locator(".agent-workbench-document-body")
          .evaluate((el) => [...el.classList].find((name) => name.startsWith("view-")).slice(5)),
        "center",
      );
      assert.equal(
        await page
          .locator(".agent-workbench-native-conversation")
          .evaluate((el) => getComputedStyle(el).display),
        "none",
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".agent-workbench-business")?.getBoundingClientRect().width > 900,
      );
      await page.getByRole("button", { name: "会话区最大，隐藏中间区域" }).click();
      assert.equal(
        await page
          .locator(".agent-workbench-document-body")
          .evaluate((el) => [...el.classList].find((name) => name.startsWith("view-")).slice(5)),
        "chat",
      );
      assert.equal(
        await page
          .locator(".agent-workbench-business")
          .evaluate((el) => getComputedStyle(el).display),
        "none",
      );
      await page.waitForFunction(
        () =>
          document.querySelector(".agent-workbench-native-conversation")?.getBoundingClientRect()
            .width > 900,
      );
      await page.setViewportSize({ width: 1000, height: 920 });
      await page.waitForFunction(
        () =>
          document.querySelector(".agent-workbench-native-conversation")?.getBoundingClientRect()
            .width > 700,
      );
      const narrowChat = await page.evaluate(() => {
        const shell = document.querySelector("[data-rightbar-col]").parentElement;
        const rail = document.querySelector(".agent-workbench-native-conversation");
        return {
          width: rail?.getBoundingClientRect().width,
          grid: shell && getComputedStyle(shell).gridTemplateColumns,
          collapsed: shell?.hasAttribute("data-sidebar-collapsed"),
        };
      });
      assert.ok(narrowChat.width > 700, JSON.stringify(narrowChat));
      await page.setViewportSize({ width: 1536, height: 920 });
      await page.getByRole("button", { name: "同时显示中间区域和会话区" }).click();
      assert.equal(
        await page
          .locator(".agent-workbench-document-body")
          .evaluate((el) => [...el.classList].find((name) => name.startsWith("view-")).slice(5)),
        "split",
      );
      await page.waitForFunction(
        () => document.querySelector("[data-side=sidebar]")?.getBoundingClientRect().width > 0,
      );
      await page
        .locator(".gea-conversation-toolbar")
        .getByRole("button", { name: "新建对话" })
        .click();
      assert.equal(
        await page
          .locator(".agent-workbench-document-body")
          .evaluate((el) => [...el.classList].find((name) => name.startsWith("view-")).slice(5)),
        "split",
      );
      await page.getByRole("button", { name: "历史对话", exact: true }).last().click();
      assert.equal(
        await page.locator(".gea-drawer-workspace .gea-sidebar-tab").getAttribute("aria-expanded"),
        "true",
      );
      assert.equal(
        await page
          .locator('[data-slot="sidebar.workspaces"]')
          .evaluate((el) => getComputedStyle(el).display),
        "contents",
      );
      assert.equal(
        await page.locator(".gea-workspace-owned").isVisible(),
        true,
        "the current public History content remains visible inside the slot wrapper",
      );
      await page.locator(".gea-drawer-function .gea-sidebar-tab").click();

      const desktopRailWidth = await page
        .locator(".agent-workbench-native-conversation")
        .evaluate((el) => el.getBoundingClientRect().width);
      // The current Core owns the complete input seat at the window floor,
      // including short windows and while the welcome area is scrolled.
      for (const viewport of [
        { width: 1536, height: 620 },
        { width: 1024, height: 768 },
      ]) {
        await page.setViewportSize(viewport);
        for (const view of ["会话区最大，隐藏中间区域", "同时显示中间区域和会话区"]) {
          await page.getByRole("button", { name: view }).click();
          await page.waitForFunction(() => {
            const card = document.querySelector(
              ".agent-workbench-native-conversation [data-composer-card]",
            );
            const seat = document
              .querySelector(".agent-workbench-native-conversation [data-composer-seat]")
              ?.getBoundingClientRect();
            const content = document.querySelector(
              ".agent-workbench-native-conversation [data-conversation-scroll]",
            );
            const contentBox = content?.getBoundingClientRect();
            const column = contentBox && {
              left: contentBox.left,
              right: contentBox.left + content.clientWidth,
            };
            const rect = card?.getBoundingClientRect();
            return (
              rect &&
              column &&
              seat &&
              Math.abs(innerHeight - seat.bottom) < 1 &&
              Math.abs((rect.left + rect.right - column.left - column.right) / 2) < 2
            );
          });
          await page.locator(".gea-agent-welcome").evaluate((el) => {
            el.scrollTo({ top: 0, behavior: "instant" });
          });
          const inset = await page
            .locator(".gea-agent-welcome")
            .evaluate(
              (el) =>
                el.querySelector(".gea-agent-identity").getBoundingClientRect().top -
                el.getBoundingClientRect().top,
            );
          assert.equal(inset, 28, "plan Agent avatar must match the APS top inset");
          const centered = await page.evaluate(() => {
            const content = document.querySelector(
              ".agent-workbench-native-conversation [data-conversation-scroll]",
            );
            const contentBox = content.getBoundingClientRect();
            const column = { left: contentBox.left, right: contentBox.left + content.clientWidth };
            return [
              ".gea-agent-identity",
              ".gea-agent-prompts",
              ".agent-workbench-native-conversation [data-composer-card]",
            ].map((selector) => {
              const rect = document.querySelector(selector).getBoundingClientRect();
              return {
                selector,
                width: rect.width,
                offset: Math.abs((rect.left + rect.right) / 2 - (column.left + column.right) / 2),
              };
            });
          });
          for (const box of centered) {
            assert.ok(
              box.width <= (box.selector.includes("data-composer-card") ? 952.5 : 760.5),
              JSON.stringify(box),
            );
            assert.ok(box.offset <= 2, JSON.stringify(box));
          }
          const before = await page
            .locator(".agent-workbench-native-conversation [data-composer-card]")
            .boundingBox();
          await page.locator(".gea-agent-welcome").evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          const after = await page
            .locator(".agent-workbench-native-conversation [data-composer-card]")
            .boundingBox();
          assert.ok(Math.abs(before.y - after.y) < 1, "scrolling must not move the input");
          assert.ok(after.y > 58 && after.x >= 0 && after.x + after.width <= viewport.width + 1);
        }
      }
      await page.setViewportSize({ width: 1536, height: 920 });

      await page.waitForFunction(
        (expected) =>
          Math.abs(
            document.querySelector(".agent-workbench-native-conversation").getBoundingClientRect()
              .width - expected,
          ) < 1,
        desktopRailWidth,
      );

      // 登记 51：销售计划审批默认不展开筛选。
      const filterToggle = frame.locator("button[aria-expanded]").first();
      await filterToggle.waitFor();
      assert.equal(await filterToggle.getAttribute("aria-expanded"), "false");
      assert.equal(
        await frame.locator("[class*='advancedControls']").first().getAttribute("data-expanded"),
        "false",
      );

      // 三栏宽度归 DSH 自己的 inline grid + 拖拽手柄管，外壳不能再写 !important 压轨道，
      // 否则左右两侧手柄就拖不动了。
      const readLayout = () =>
        page.evaluate(() => {
          const sidebar = document.querySelector(".gea-sidebar-owned");
          const handle = document.querySelector("[data-side=sidebar]");
          if (!sidebar || !handle) return null;
          const sidebarBox = sidebar.getBoundingClientRect();
          const handleBox = handle.getBoundingClientRect();
          return {
            sidebar: Math.round(sidebarBox.width),
            handle: {
              x: Math.round(handleBox.x + handleBox.width / 2),
              y: Math.round(handleBox.y + handleBox.height / 2),
            },
          };
        });
      const layoutBefore = await readLayout();
      assert.ok(layoutBefore && layoutBefore.handle, "layout handle must exist");
      const conversationRail = () =>
        page.evaluate(() => {
          const rail = document.querySelector(".agent-workbench-native-conversation");
          const seat = document.querySelector("[data-composer-seat]");
          const input = document.querySelector('[contenteditable="true"]');
          if (!rail || !seat || !input) return null;
          const box = (element) => {
            const value = element.getBoundingClientRect();
            return {
              left: Math.round(value.left),
              right: Math.round(value.right),
              width: Math.round(value.width),
            };
          };
          return {
            rail: box(rail),
            seat: box(seat),
            input: box(input),
            borderLeft: getComputedStyle(rail).borderLeftWidth,
            borderLeftStyle: getComputedStyle(rail).borderLeftStyle,
            borderLeftColor: getComputedStyle(rail).borderLeftColor,
          };
        });
      const dragHandle = async (dx) => {
        // 手柄会跟着列宽移动，每次拖动前重新取当前位置。
        const current = await readLayout();
        await page.mouse.move(current.handle.x, current.handle.y);
        await page.mouse.down();
        for (let step = 1; step <= 8; step += 1) {
          await page.mouse.move(current.handle.x + (dx * step) / 8, current.handle.y, { steps: 2 });
        }
        await page.mouse.up();
        await page.waitForTimeout(250);
      };
      const railBefore = await conversationRail();
      assert.ok(railBefore, "右侧对话栏必须存在");
      await dragHandle(80);
      const layoutWider = await readLayout();
      assert.ok(
        layoutWider.sidebar - layoutBefore.sidebar >= 60,
        JSON.stringify({ layoutBefore, layoutWider }),
      );
      const railAfterPageResize = await conversationRail();
      assert.ok(railAfterPageResize, "调整页面宽度后右侧对话栏必须仍存在");
      assert.equal(railAfterPageResize.borderLeft, "1px", JSON.stringify(railAfterPageResize));
      assert.equal(
        railAfterPageResize.borderLeftStyle,
        "solid",
        JSON.stringify(railAfterPageResize),
      );
      assert.equal(
        railAfterPageResize.borderLeftColor,
        "rgb(173, 185, 200)",
        JSON.stringify(railAfterPageResize),
      );
      assert.ok(
        // 宿主列宽求解在两次测量间可能有几像素差（滚动条/clamp），4px 内视为"没跟着工作台变"。
        Math.abs(railAfterPageResize.rail.width - railBefore.rail.width) <= 4,
        `调整工作台宽度不能改变对话栏宽度: ${JSON.stringify({ railBefore, railAfterPageResize })}`,
      );
      assert.ok(
        railAfterPageResize.seat.left - railAfterPageResize.rail.left <= 1,
        JSON.stringify(railAfterPageResize),
      );
      assert.ok(
        railAfterPageResize.input.left >= railAfterPageResize.rail.left,
        JSON.stringify(railAfterPageResize),
      );
      assert.ok(
        railAfterPageResize.input.right <= railAfterPageResize.rail.right,
        JSON.stringify(railAfterPageResize),
      );
      await dragHandle(-80);
      const layoutRestored = await readLayout();
      assert.ok(
        Math.abs(layoutRestored.sidebar - layoutBefore.sidebar) <= 12,
        JSON.stringify({ layoutBefore, layoutRestored }),
      );

      // 登记 37（改）：窄窗口不再改成上下两行，而是分档收缩左右两栏，
      // 最窄一档把左侧菜单收进图标列，始终保留「中间工作台 + 右边对话」。
      const layoutAt = () =>
        page.evaluate(() => {
          const frame = document.querySelector("[data-rightbar-col]").parentElement;
          const cs = frame ? getComputedStyle(frame) : null;
          const rail = document.querySelector(".gea-sidebar-rail");
          return {
            columns: cs?.gridTemplateColumns ?? "",
            rows: cs?.gridTemplateRows ?? "",
            narrow: Boolean(document.querySelector("[data-gea-narrow]")),
            railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
            splitter: Boolean(document.querySelector(".gea-stacked-splitter")),
          };
        });
      await page.setViewportSize({ width: 1140, height: 900 });
      await page.waitForTimeout(900);
      const wrappedLayout = await layoutAt();
      // 单行三栏；左右两栏已被收缩；没有上下拖动条。
      assert.equal(
        wrappedLayout.rows.split(" ").filter((value) => Number.parseFloat(value) > 0).length,
        1,
        JSON.stringify(wrappedLayout),
      );
      assert.equal(wrappedLayout.columns.split(" ").length, 3, JSON.stringify(wrappedLayout));
      assert.equal(wrappedLayout.narrow, false, JSON.stringify(wrappedLayout));
      assert.equal(wrappedLayout.splitter, false, JSON.stringify(wrappedLayout));
      const sideColumn = Number.parseFloat(wrappedLayout.columns.split(" ")[0]);
      assert.ok(sideColumn >= 264 && sideColumn <= 420, JSON.stringify(wrappedLayout));
      await page.setViewportSize({ width: 1000, height: 820 });
      await page.waitForTimeout(900);
      const railLayout = await layoutAt();
      // 再窄一档：菜单收进图标列（左栏 64px），仍然是三栏单行。
      assert.equal(railLayout.narrow, true, JSON.stringify(railLayout));
      assert.ok(railLayout.railWidth > 0 && railLayout.railWidth <= 64, JSON.stringify(railLayout));
      assert.equal(
        Number.parseFloat(railLayout.columns.split(" ")[0]),
        56,
        JSON.stringify(railLayout),
      );
      assert.equal(
        railLayout.rows.split(" ").filter((value) => Number.parseFloat(value) > 0).length,
        1,
        JSON.stringify(railLayout),
      );
      const composerHit = await page.evaluate(() => {
        const input = document.querySelector('[contenteditable="true"]');
        if (!input) return null;
        const box = input.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit ? input.contains(hit) : null;
      });
      assert.equal(composerHit, true);
      await page.setViewportSize({ width: 1536, height: 920 });
      await page.waitForTimeout(400);

      // 登记 24：宿主兜底品牌文案不出现。
      assert.equal(
        await page.evaluate(
          () =>
            Array.from(document.querySelectorAll('[class*="fallbackBrandName"]')).filter(
              (el) => el.offsetParent !== null,
            ).length,
        ),
        0,
      );

      // 登记 20：左侧菜单选中项没有深红描边（边框、外描边、阴影都不带红色）。
      const redish = /rgb\(\s*(1[4-9]\d|2\d\d)\s*,\s*(?:[0-9]{1,2})\s*,\s*[0-9]{1,2}\)/;
      const selected = await page
        .locator(
          ".gea-shell-nav-child.is-active, .gea-shell-nav-heading.is-active, .gea-sidebar-tab[aria-expanded='true']",
        )
        .first()
        .evaluate((el) => {
          const cs = getComputedStyle(el);
          return {
            borderWidth: cs.borderTopWidth,
            borderStyle: cs.borderTopStyle,
            borderColor: cs.borderTopColor,
            outlineStyle: cs.outlineStyle,
            outlineColor: cs.outlineColor,
            boxShadow: cs.boxShadow,
          };
        });
      const drawsBorder = selected.borderWidth !== "0px" && selected.borderStyle !== "none";
      assert.equal(
        drawsBorder && redish.test(selected.borderColor),
        false,
        JSON.stringify(selected),
      );
      const drawsOutline = selected.outlineStyle !== "none";
      assert.equal(
        drawsOutline && redish.test(selected.outlineColor),
        false,
        JSON.stringify(selected),
      );
      assert.equal(redish.test(selected.boxShadow), false, JSON.stringify(selected));

      // 登记 28：侧栏收起后品牌圆标与图标列同一条中线。
      const collapse = page
        .getByRole("button", { name: "收起侧边栏", exact: true })
        .or(page.getByRole("button", { name: "关闭侧边栏", exact: true }));
      await collapse.first().click();
      await page.locator(".gea-sidebar-owned[data-sidebar-collapsed]").waitFor();
      // 侧栏收起带动画，量几何前先等宽度稳定。
      await page.waitForTimeout(700);
      const centering = await page.evaluate(() => {
        const logo = document.querySelector(".gea-shell-logo");
        const rail = Array.from(document.querySelectorAll(".gea-sidebar-rail-item")).find(
          (item) => item.getBoundingClientRect().width > 0,
        );
        if (!logo || !rail) return null;
        const logoBox = logo.getBoundingClientRect();
        const railBox = rail.getBoundingClientRect();
        return {
          logoCenter: Math.round(logoBox.x + logoBox.width / 2),
          railCenter: Math.round(railBox.x + railBox.width / 2),
        };
      });
      assert.ok(centering, "collapsed rail and logo must both exist");
      assert.ok(
        Math.abs(centering.logoCenter - centering.railCenter) <= 2,
        JSON.stringify(centering),
      );
      // 收起动画期间不闪：图标列固定成窄列（不铺满整条侧栏），且切换按侧栏实测宽度走。
      const collapsedRail = await page.evaluate(() => {
        const rail = document.querySelector(".gea-sidebar-rail");
        const sidebar = document.querySelector(".gea-sidebar-owned");
        return {
          railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
          narrowFlag: sidebar?.hasAttribute("data-gea-narrow") ?? false,
          drawerHidden:
            getComputedStyle(document.querySelector(".gea-sidebar-drawer")).display === "none",
        };
      });
      assert.ok(
        collapsedRail.railWidth > 0 && collapsedRail.railWidth <= 60,
        JSON.stringify(collapsedRail),
      );
      assert.equal(collapsedRail.narrowFlag, true, JSON.stringify(collapsedRail));
      assert.equal(collapsedRail.drawerHidden, true, JSON.stringify(collapsedRail));
      await page.getByTitle("展开业务菜单", { exact: true }).click();
      await page.waitForTimeout(500);

      // 登记 62/63：业务抽屉收起或历史会话展开时，右栏不回填第二个 Agent 标题。
      await openBusinessPage(page, "gea-proof");
      await page.locator(".agent-workbench-document").waitFor();
      await page.locator(".gea-drawer-function .gea-sidebar-tab").click();
      assert.equal(await page.locator(".gea-agent-head").count(), 0);
      assert.equal(
        await page.locator(".gea-agent-welcome").evaluate((el) => getComputedStyle(el).paddingTop),
        "28px",
      );
      await page
        .locator(".gea-conversation-toolbar")
        .getByRole("button", { name: "历史对话" })
        .click();
      await page.locator(".agent-workbench-document").waitFor();
      assert.equal(await page.locator(".gea-agent-head").count(), 0);
      assert.equal(
        await page.locator(".gea-agent-welcome").evaluate((el) => getComputedStyle(el).paddingTop),
        "28px",
      );

      // The authorized official Home centers its native hero row and retains the company brand.
      await page
        .getByRole("complementary", { name: "业务导航", exact: true })
        .getByRole("button", { name: "新会话", exact: true })
        .filter({ hasText: "AI工作台" })
        .click();
      const homeBrand = page.locator("[data-company-hero-brand]");
      await expect(homeBrand).toBeVisible();
      await expect(page.getByText("探索未至之境", { exact: true })).toBeVisible();
      const heroCentered = await homeBrand.evaluate((el) => {
        const row = el.parentElement.parentElement.getBoundingClientRect();
        const content = el.closest("[data-conversation-content]").getBoundingClientRect();
        return { delta: Math.round(row.left + row.width / 2 - content.left - content.width / 2) };
      });
      assert.ok(Math.abs(heroCentered.delta) <= 2, JSON.stringify(heroCentered));
      await page.setViewportSize({ width: 700, height: 1000 });
      await page.waitForTimeout(300);
      assert.equal(
        await homeBrand.evaluate((el) => {
          const content = el.closest("[data-conversation-content]");
          return content.scrollWidth <= content.clientWidth + 1;
        }),
        true,
      );

      assert.deepEqual(errors, []);
    } catch (failure) {
      await mkdir(".runtime/ui-public-harness", { recursive: true });
      await writeFile(
        ".runtime/ui-public-harness/shell-feedback-failure.json",
        JSON.stringify(
          {
            body: await page.locator("body").innerText(),
            geometry: await page.evaluate(() => ({
              viewport: [innerWidth, innerHeight],
              collapsedRail: (() => {
                const rail = Array.from(document.querySelectorAll(".gea-sidebar-rail-item")).find(
                  (node) => node.getBoundingClientRect().width > 0,
                );
                const ancestry = [];
                for (let node = rail; node && node !== document.body; node = node.parentElement) {
                  const style = getComputedStyle(node);
                  ancestry.push({
                    tag: node.tagName,
                    class: node.className,
                    slot: node.getAttribute("data-slot"),
                    rect: node.getBoundingClientRect().toJSON(),
                    clientWidth: node.clientWidth,
                    padding: [
                      style.paddingTop,
                      style.paddingRight,
                      style.paddingBottom,
                      style.paddingLeft,
                    ],
                    display: style.display,
                    width: style.width,
                    maxWidth: style.maxWidth,
                    alignItems: style.alignItems,
                    justifyContent: style.justifyContent,
                    margin: [
                      style.marginTop,
                      style.marginRight,
                      style.marginBottom,
                      style.marginLeft,
                    ],
                  });
                }
                return ancestry;
              })(),
              collapsedBrand: (() => {
                const logo = document.querySelector(".gea-shell-logo");
                const ancestry = [];
                for (let node = logo; node && node !== document.body; node = node.parentElement) {
                  const style = getComputedStyle(node);
                  ancestry.push({
                    tag: node.tagName,
                    class: node.className,
                    slot: node.getAttribute("data-slot"),
                    role: node.getAttribute("role"),
                    label: node.getAttribute("aria-label"),
                    collapsed: node.getAttribute("data-sidebar-collapsed"),
                    narrow: node.getAttribute("data-gea-narrow"),
                    rect: node.getBoundingClientRect().toJSON(),
                    clientWidth: node.clientWidth,
                    padding: [
                      style.paddingTop,
                      style.paddingRight,
                      style.paddingBottom,
                      style.paddingLeft,
                    ],
                    display: style.display,
                    width: style.width,
                    maxWidth: style.maxWidth,
                    alignItems: style.alignItems,
                    justifyContent: style.justifyContent,
                    margin: [
                      style.marginTop,
                      style.marginRight,
                      style.marginBottom,
                      style.marginLeft,
                    ],
                  });
                }
                return ancestry;
              })(),
              columns: [
                ...document.querySelectorAll(
                  ".agent-workbench-document, .agent-workbench-native-conversation, .agent-workbench-business, [data-composer-seat], [data-composer-card], [data-side]",
                ),
              ].map((e) => ({
                class: e.className,
                attr: e.getAttribute("data-side"),
                box: e.getBoundingClientRect().toJSON(),
                display: getComputedStyle(e).display,
              })),
            })),
          },
          null,
          2,
        ),
      );
      throw failure;
    }
  },
);
