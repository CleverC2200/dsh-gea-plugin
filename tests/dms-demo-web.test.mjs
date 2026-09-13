import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

test(
  "Chrome mock demo: failure, unknown readback, Z partial retry and duplicate receipt",
  { timeout: 60000 },
  async (t) => {
    const [{ outputFiles }, html] = await Promise.all([
      build({
        entryPoints: ["demos/dms/main.ts"],
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
      }),
      readFile("demos/dms/index.html", "utf8"),
    ]);
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
      } else if (req.url === "/main.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(outputFiles[0].contents);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    const external = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(origin);
    const text = (id) => page.locator("#" + id).innerText();
    const click = (name) =>
      page.getByRole("button", { name, exact: true }).click();
    const send = () => click("模拟回写／原键重试");
    const choice = (value) =>
      page.getByRole("combobox", { name: "回写场景" }).selectOption(value);
    assert.equal(await page.locator("#send").isEnabled(), false);
    await click("模拟品类终审");
    assert.match(await text("status"), /^5/);
    assert.equal(await text("finished"), "尚未完成");
    await choice("failure");
    await send();
    assert.equal(await text("sync"), "FAILED");
    assert.equal(await text("deliveries"), "0");
    await choice("success");
    await send();
    assert.match(await text("status"), /^10/);
    assert.equal(await text("sync"), "SYNCED");
    const finished = await text("finished");
    await click("模拟重复回执");
    assert.equal(await text("finished"), finished);
    assert.equal(await text("deliveries"), "1");
    for (const scenario of ["lost-receipt", "timeout-before"]) {
      await click("重置模拟");
      await click("模拟品类终审");
      await choice(scenario);
      await send();
      assert.equal(await text("sync"), "UNKNOWN");
      assert.equal(await page.locator("#send").isEnabled(), false);
      assert.equal(await text("finished"), "尚未完成");
      await click("查询回执对账");
      if (scenario === "timeout-before") {
        assert.equal(await text("sync"), "FAILED");
        await choice("success");
        await send();
      } else assert.equal(await text("attempts"), "1");
      assert.equal(await text("sync"), "SYNCED");
      assert.equal(await text("deliveries"), "1");
    }
    await page
      .getByRole("combobox", { name: "计划类型", exact: true })
      .selectOption("JD");
    await page
      .getByRole("combobox", { name: "单据类型", exact: true })
      .selectOption("Z");
    await click("模拟品类终审");
    await choice("partial");
    await send();
    await click("查询回执对账");
    assert.match(await text("status"), /^5/);
    assert.equal(await text("finished"), "尚未完成");
    assert.equal(await text("deliveries"), "1");
    await choice("success");
    await send();
    assert.equal(await text("sync"), "SYNCED");
    assert.equal(await text("deliveries"), "2");
    const receipts = JSON.parse(await text("receipts"));
    assert.equal(receipts.length, 2);
    assert.notEqual(receipts[0].dmsId, receipts[1].dmsId);
    assert.ok(
      receipts.every(
        (row) =>
          row.sourcePlanId === "MOCK-JD-Z" && row.sourceVersionId === "MOCK-V1",
      ),
    );
    assert.match(await text("logs"), /RECONCILED_MISSING/);
    assert.match(await text("logs"), /DMS_SYNC/);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  },
);
