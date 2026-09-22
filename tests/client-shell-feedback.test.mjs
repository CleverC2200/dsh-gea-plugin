/**
 * 视觉样式及功能问题反馈（客户端）回归：
 * 会话区命名、左侧菜单选中态、收起后品牌居中、AI 工作台文字对齐、
 * 宿主兜底品牌文案、销售计划筛选默认收起。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
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
          result: { userInfo: { id: "9007199254740993", realname: "测试用户", loginTenantId: "0" } },
        });
        return true;
      }
      if (path.endsWith("/plans")) {
        reply({ success: true, result: { records: [plan], total: 1, pages: 1, current: 1, size: 20 } });
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
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1536, height: 920 } });
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
      allowLogin ? route.continue() : route.fulfill({ json: { ok: true, value: { status: "pending" } } }),
    );
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: "内测声明", exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    const frame = page.frameLocator("iframe[data-gea-workbench]");
    await frame.getByRole("button", { name: "刷新二维码", exact: true }).waitFor();
    allowLogin = true;
    await frame.getByRole("heading", { name: "销售计划审批", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "业务导航", exact: true }).waitFor();

    // 登记 32 / 48：会话框标题只留「模块名 + 助手」，副标整行去掉。
    await page.locator(".gea-agent-head").waitFor();
    assert.equal(await page.locator(".gea-agent-head-sub").count(), 0);
    assert.equal(await page.locator(".gea-agent-head-name").textContent(), "销售计划助手");

    // 登记 51：销售计划审批默认不展开筛选。
    const filterToggle = frame.locator("button[aria-expanded]").first();
    await filterToggle.waitFor();
    assert.equal(await filterToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await frame.locator("[class*='advancedControls']").first().getAttribute("data-expanded"), "false");

    // 登记 24：宿主兜底品牌文案不出现。
    assert.equal(
      await page.evaluate(
        () => Array.from(document.querySelectorAll('[class*="fallbackBrandName"]')).filter((el) => el.offsetParent !== null).length,
      ),
      0,
    );

    // 登记 41：等待态文案的样式必须压过宿主那套「渐变文字 + 微光动画」。
    const thinking = await page.evaluate(() => {
      const host = document.createElement("style");
      host.textContent =
        ".gea-host-thinking-sim{color:rgba(0,0,0,0);-webkit-text-fill-color:rgba(0,0,0,0);" +
        "background:linear-gradient(90deg,rgb(65,118,230) 0%,rgb(211,226,255) 50%,rgb(65,118,230) 100%);" +
        "background-clip:text;-webkit-background-clip:text;animation:gea-sim 1.8s linear infinite}";
      document.head.append(host);
      const el = document.createElement("div");
      el.className = "gea-host-thinking-sim";
      el.setAttribute("data-gea-think-status", "");
      el.textContent = "深度思考中...";
      document.body.append(el);
      const cs = getComputedStyle(el);
      const value = {
        color: cs.color,
        fill: cs.webkitTextFillColor,
        backgroundImage: cs.backgroundImage,
        backgroundClip: cs.backgroundClip,
        animation: cs.animationName,
      };
      el.remove();
      host.remove();
      return value;
    });
    assert.equal(thinking.color, "rgb(226, 79, 102)", JSON.stringify(thinking));
    assert.equal(thinking.fill, "rgb(226, 79, 102)", JSON.stringify(thinking));
    assert.equal(thinking.backgroundImage, "none", JSON.stringify(thinking));
    assert.equal(thinking.animation, "none", JSON.stringify(thinking));

    // 登记 20：左侧菜单选中项没有深红描边（边框、外描边、阴影都不带红色）。
    const redish = /rgb\(\s*(1[4-9]\d|2\d\d)\s*,\s*(?:[0-9]{1,2})\s*,\s*[0-9]{1,2}\)/;
    const selected = await page
      .locator(".gea-shell-nav-child.is-active, .gea-shell-nav-heading.is-active, .gea-sidebar-tab[aria-expanded='true']")
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
    assert.equal(drawsBorder && redish.test(selected.borderColor), false, JSON.stringify(selected));
    const drawsOutline = selected.outlineStyle !== "none";
    assert.equal(drawsOutline && redish.test(selected.outlineColor), false, JSON.stringify(selected));
    assert.equal(redish.test(selected.boxShadow), false, JSON.stringify(selected));

    // 登记 28：侧栏收起后品牌圆标与图标列同一条中线。
    const collapse = page
      .getByRole("button", { name: "收起侧边栏", exact: true })
      .or(page.getByRole("button", { name: "关闭侧边栏", exact: true }));
    await collapse.first().click();
    await page.locator("[data-sidebar-collapsed]").waitFor();
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
    await page
      .getByRole("button", { name: "展开侧边栏", exact: true })
      .or(page.getByRole("button", { name: "打开侧边栏", exact: true }))
      .first()
      .click();
    await page.waitForTimeout(500);

    // 登记 30 经验收改回：AI 工作台主视觉保持居中；窄屏不横向溢出（登记 53 加固）。
    await page.getByRole("button", { name: "AI工作台", exact: true }).click();
    await page.locator(".gea-home-hero").waitFor();
    assert.equal(
      await page.locator(".gea-home-hero").evaluate((el) => getComputedStyle(el).textAlign),
      "center",
    );
    const heroCentered = await page.locator(".gea-home-hero").evaluate((el) => {
      const hero = el.getBoundingClientRect();
      const logo = el.querySelector(".gea-home-logo").getBoundingClientRect();
      const title = el.querySelector(".gea-home-title").getBoundingClientRect();
      const center = (box) => box.left + box.width / 2;
      return {
        logo: Math.round(center(logo) - center(hero)),
        title: Math.round(center(title) - center(hero)),
      };
    });
    assert.ok(Math.abs(heroCentered.logo) <= 2, JSON.stringify(heroCentered));
    assert.ok(Math.abs(heroCentered.title) <= 2, JSON.stringify(heroCentered));
    await page.setViewportSize({ width: 700, height: 1000 });
    await page.waitForTimeout(300);
    assert.equal(
      await page.locator(".gea-home-hero").evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      true,
    );

    assert.deepEqual(errors, []);
  },
);
