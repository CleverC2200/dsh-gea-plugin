import { test, expect } from "@playwright/test";

// Run against the locally launched GEA profile; no business writes or model calls.
test("brand stays a label and both shells open native settings", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:3201/");
  const brand = page.locator(".gea-brand-switch");
  await expect(brand).toBeVisible();
  const frame = page.locator("iframe[data-gea-workbench]");
  await expect(frame).toBeVisible();
  const avatar = page.locator(".gea-user-avatar");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveCSS("border-radius", "50%");
  await expect(page.locator(".gea-shell-logo")).toHaveAttribute(
    "src",
    /^data:image\/png;base64,/,
  );
  await expect(
    page.locator('[data-slot="sidebar.brand.name"] span'),
  ).toHaveCSS("color", "rgb(215, 10, 28)");
  // The brand mark is a label only; clicking it keeps the current page.
  await brand.click();
  await expect(frame).toBeVisible();
  for (let view = 0; view < 2; view++) {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "通用设置", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (view === 0) {
      await page.getByRole("button", { name: "AI工作台", exact: true }).click();
      await expect(frame).toHaveCount(0);
    }
  }
  await expect(
    page.getByRole("button", { name: "DSH 对话", exact: true }),
  ).toHaveCount(0);
});
