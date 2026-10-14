import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

test("standalone tarball installs without GEA and exposes the picker and shared bridge", { timeout: 180000 }, async t => {
  const root = resolve(import.meta.dirname, "..");
  const destination = resolve(root, ".runtime/packages");
  await mkdir(destination, { recursive: true });
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {cwd: resolve(root, "packages/page-interaction"), encoding: "utf8"}));
  const directory = await mkdtemp(resolve(tmpdir(), "dsh-page-package-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  execFileSync("npm", ["install", resolve(destination, packed.filename), "@deepseek-ai/cordis@4.0.2", "@deepseek-ai/dsh-tools@0.1.5-rc.2", "--ignore-scripts", "--no-audit", "--no-fund"], {cwd: directory, timeout: 120000, stdio: "pipe"});
  const installed = resolve(directory, "node_modules/@cleverc2200/dsh-page-interaction");
  const manifest = JSON.parse(await readFile(resolve(installed, "package.json"), "utf8"));
  const bridge = await import(pathToFileURL(resolve(installed, manifest.exports["./bridge"])));
  assert.equal(typeof bridge.createPageBridge, "function");
  assert.equal(typeof bridge.createPageToolRegistry, "function");
  const browser = await chromium.launch({channel: "chrome", headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage();
  const picker = await readFile(resolve(installed, manifest.exports["./picker"]), "utf8");
  const exports = await page.evaluate(async source => {
    const module = await import("data:text/javascript;base64," + source);
    const dispose = module.mountPicker();
    const mounted = Boolean(document.querySelector(".dspi"));
    dispose();
    return {mounted, cleared: !document.querySelector(".dspi"), describe: typeof module.describeElement};
  }, Buffer.from(picker).toString("base64"));
  assert.deepEqual(exports, {mounted: true, cleared: true, describe: "function"});
});
