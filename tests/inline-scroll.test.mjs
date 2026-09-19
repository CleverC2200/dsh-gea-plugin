import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
test('SKU viewport scrolls internally, then passes upward scrolling to its parent',async t=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();
 const css=await readFile(new URL('../src/workbench/original/workbenches/regionalApproval/InlineSkuDetails.module.css',import.meta.url),'utf8');
 await page.setContent(`<style>${css} #outer{height:500px;overflow:auto} .spacer{height:250px}</style><div id="outer"><div class="spacer"></div><div class="viewport"><div style="height:1500px">SKU</div></div><div class="spacer"></div></div>`);
 await page.locator('#outer').evaluate(e=>e.scrollTop=200);
 const inner=page.locator('.viewport');await inner.evaluate(e=>e.scrollTop=100);
 await inner.hover();await page.mouse.wheel(0,-120);
 await expect.poll(()=>inner.evaluate(e=>e.scrollTop)).toBe(0);
 await page.mouse.move(900,600);await inner.hover();await page.mouse.wheel(0,-150);
 await expect.poll(()=>page.locator('#outer').evaluate(e=>e.scrollTop)).toBeLessThan(200);
 assert.equal(await inner.evaluate(e=>e.scrollTop),0);
});
