/** Native DSH profile proves theme resources do not depend on company plugins. */
import { changeThemeSetting } from "./theme-settings.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

test("native profile consumes shared theme without loading workbench", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async (t) => {
  const child = spawn(process.execPath, ["scripts/start-isolated-validation.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { log += data; });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await exited; });
  let launch;
  for (let n = 0; n < 600; n++) {
    launch = [...log.matchAll(/dsh web: (http[^\s]+)(?=\r?\n)/g)].at(-1)?.[1];
    if (launch) break;
    if (child.exitCode !== null) throw Error("Native profile exited before readiness");
    await delay(50);
  }
  assert.ok(launch, "native profile ready");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(launch);
  await page.getByRole("dialog", { name: /内测声明|预览版说明/ }).getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("button", { name: "稍后配置", exact: true }).click();
  await expect(page.locator('style[data-plugin-css$="/workbench-theme.css"]')).toHaveCount(1);
  const resources = await page.evaluate(() => performance.getEntriesByType("resource").map(x => x.name));
  assert.equal(resources.some(x => x.includes("dsh-agent-workbench")), false);
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.fill("独立原生输入验收");
  await page.screenshot({ path: ".runtime/theme-evidence/native-light.png", fullPage: true });
  const buttons = await page.getByRole("button").evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, label: n.getAttribute("aria-label"), title: n.getAttribute("title") })));
  await mkdir(".runtime/theme-evidence", { recursive: true });
  await writeFile(".runtime/theme-evidence/native-buttons.json", JSON.stringify(buttons, null, 2));
  await page.getByRole("button", { name: /设置|Settings/ }).first().click();
  await page.getByRole("button", { name: "通用设置", exact: true }).click();
  await changeThemeSetting(page, "深色", "preference");
  await changeThemeSetting(page, "增大字号", "fontSize");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(composer).toHaveCSS("font-size", "15px");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(27, 29, 33)");
  await page.reload();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(27, 29, 33)");
  await expect(composer).toHaveCSS("font-size", "15px");
  await page.getByRole("button", { name: "稍后配置", exact: true }).click();
  await expect(page.getByRole("button", { name: "稍后配置", exact: true })).toHaveCount(0);
  await page.screenshot({ path: ".runtime/theme-evidence/native-dark.png", fullPage: true });
  assert.deepEqual(errors, []);
});
