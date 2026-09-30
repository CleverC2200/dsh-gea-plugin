import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";

const built = await build({ stdin: { contents: `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {registerHtmlClient} from './src/html-client.tsx';
  import {createBusinessIdentityReader} from './src/business-identity-client.ts';
  import {createThemeClient} from './tests/fixtures/theme-client.mjs';
  const themeContext=createThemeClient();window.testTheme=themeContext;
  import {WorkbenchController} from '../dsh-agent-workbench/src/workbench.ts';
  const root=createRoot(document.getElementById('app'));
  let navigation=new AbortController();
  const controller=new WorkbenchController({
    create:async()=> 'session-created',prepare:async()=>{},available:()=>true,
    presetOf:()=>window.actualPreset,
    select:id=>{window.selectedSession=id;},panel:id=>controller.selectPanel(id),
    beginNavigation:()=>{navigation.abort();navigation=new AbortController();return navigation.signal;},
    showConversation:()=>()=>{},
  });
  window.restore=()=>controller.selectPanel('inventory-fc');
  window.bindAnother=()=>controller.open('inventory-fc','default','session-existing');
  const useMainSessionId=select=>select('session-old');
  registerHtmlClient({...themeContext,effect:f=>f(),agentWorkbench:controller,layout:{selectPanel(){}},
    slots:{inject:(_,f)=>f(),register:(_,Component)=>{root.render(<Component useMainSessionId={useMainSessionId}/>);return ()=>{};}}}, undefined, createBusinessIdentityReader());
`, loader: "tsx", resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", platform: "browser" });

for (const preset of [undefined, "user-custom"]) test(`legacy page preserves an existing Session with ${preset ?? "missing"} preset metadata`, {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 60000,
}, async t => {
  const app = await profile(t, { env: { GEA_HTML_PLUGIN_ROOTS: JSON.stringify([resolve("../dsh-agent-fc-plugin")]) } });
  const manifestResponse = await fetch(app.origin + "/api/gea-html/plugins", { headers: { Cookie: app.cookie } });
  assert.equal(manifestResponse.status, 200);
  const manifests = await manifestResponse.json();
  assert.equal(manifests[0].agentResources, undefined);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://localhost:43119/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="app"></div>' });
    if (path.endsWith("/status")) return route.fulfill({ json: { ok: true, value: { htmlPlugins: true } } });
    if (path.endsWith("/identity")) return route.fulfill({ json: { scope: "fixture-identity" } });
    if (path.endsWith("/plugins")) return route.fulfill({ json: manifests });
    if (path.endsWith("/open")) return route.fulfill({ json: { lease: "fixture-lease" } });
    if (path.endsWith("/call")) return route.fulfill({ json: [] });
    if (path.endsWith("/html")) return route.fulfill({ contentType: "text/html", body: '<p>旧业务页</p>' });
    return route.abort();
  });
  await page.goto("http://localhost:43119/");
  await page.evaluate(value => { window.actualPreset = value; }, preset);
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await expect(page.locator("iframe")).toBeVisible({ timeout: 3000 }).catch(async error => {
    t.diagnostic(JSON.stringify({ text: await page.locator("body").innerText(), allowedPresets: manifests[0].pageAgents, preset: preset ?? "missing" }));
    throw error;
  });
  assert.equal(await page.evaluate(() => selectedSession), "session-old");
  await page.evaluate(() => { actualPreset = "changed-by-user"; restore(); });
  assert.equal(await page.evaluate(() => selectedSession), "session-old");
  await page.evaluate(() => bindAnother());
  assert.equal(await page.evaluate(() => selectedSession), "session-existing");
});
