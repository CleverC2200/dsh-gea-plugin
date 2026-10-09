import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { stockReferencePage } from "./fixtures/stock-reference-page.mjs";

test(
  "the assembled FC page publishes current elements without any injected scanner",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const catalogs = [];
    const { page, frame } = await stockReferencePage(t, {
      async preparePage(page) {
        await page.addInitScript(() => {
          window.publishedCatalogs = [];
          const send = MessagePort.prototype.postMessage;
          MessagePort.prototype.postMessage = function (message, ...rest) {
            if (message?.type === "catalog") window.publishedCatalogs.push(message);
            return send.call(this, message, ...rest);
          };
        });
        page.on("request", (request) => {
          if (!request.url().endsWith("/api/agent-workbench/page") || !request.postData()) return;
          const data = request.postDataJSON();
          if (data.operation === "catalog") catalogs.push(data.parameters);
        });
      },
    });
    await expect
      .poll(() =>
        catalogs.at(-1)?.catalog?.elements?.some((element) => element.id === "readout:inventory"),
      )
      .toBe(true);
    const current = catalogs.at(-1);
    assert.equal(current.pageSource, "self-report");
    assert.ok(current.catalog.elements.some((element) => element.id === "filter:warehouseId"));
    assert.ok(
      current.catalog.elements.some(
        (element) => element.id === "filter:search" && element.editable,
      ),
    );
    const child = page
      .frames()
      .find((frame) => frame.url().includes("/api/agent-workbench/html?id=inventory-fc&"));
    assert.equal(await child.evaluate(() => typeof window.__geaPageScan), "undefined");
    await frame.getByRole("button", { name: "刷新", exact: true }).click();
    await expect
      .poll(() =>
        catalogs.at(-1)?.catalog?.elements?.some((element) => element.id === "readout:inventory"),
      )
      .toBe(true);
    assert.ok(
      await child.evaluate(() =>
        window.publishedCatalogs.some(
          (catalog) => !catalog.elements?.some((element) => element.id === "readout:inventory"),
        ),
      ),
      "loading emits a catalog without retained facts",
    );
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(frame.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
  },
);
