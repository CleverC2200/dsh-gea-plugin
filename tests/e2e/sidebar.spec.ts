import { test, expect } from "@playwright/test";

// Run against the locally launched GEA profile; no business writes or model calls.
test("brand switches both ways and both views open native settings", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3201/");
  const brand = page.locator(".gea-brand-switch");
  await expect(brand).toBeVisible();
  const frame = page.locator("iframe[data-gea-workbench]");
  if (!(await frame.isVisible())) await brand.click();
  await expect(frame).toBeVisible();
  const avatar = page.locator(".gea-user-avatar");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveCSS("border-radius", "50%");
  await expect(page.locator(".gea-shell-logo")).toHaveCSS(
    "background-color",
    "rgb(237, 0, 0)",
  );
  for (let view = 0; view < 2; view++) {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "通用设置", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await brand.click();
    if (view === 0) await expect(frame).toHaveCount(0);
    else await expect(frame).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "DSH 对话", exact: true }),
  ).toHaveCount(0);
});
