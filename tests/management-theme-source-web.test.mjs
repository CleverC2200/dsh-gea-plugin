/** Both management plugins in the real DSH source profile; mutations use local fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';
import { changeThemeSetting } from './theme-settings.mjs';

const evidence = resolve('.runtime/management-theme-evidence');
test('management and hub consume one theme and retain fixture operations', {
  skip: process.env.GEA_TEST_SOURCE_CORE !== '1', timeout: 180000,
}, async t => {
  const home = await mkdtemp(resolve(tmpdir(), 'management-theme-home-'));
  const fixture = resolve(home, 'suite');
  await mkdir(resolve(fixture, 'skills/check'), { recursive: true });
  await writeFile(resolve(fixture, 'plugin.json'), JSON.stringify({ name: 'theme-fixture', version: '1.0.0', description: 'Local theme acceptance suite' }));
  await writeFile(resolve(fixture, 'skills/check/SKILL.md'), '---\nname: fixture-check\ndescription: Local theme check\n---\nRead only fixture data.\n');
  const app = await profile(t, { env: { HOME: home, ZDOTDIR: home, HISTFILE: resolve(home, 'history') } });
  t.after(() => rm(home, { recursive: true, force: true }));
  await app.login();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  await context.addCookies(app.cookie.split('; ').map(pair => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: app.origin })));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  const updateState = { desktop: true, phase: 'idle', current: { 'dsh-agent-manage': '0.0.1' }, releases: [{ package: 'dsh-agent-manage', version: '0.0.2', notes: { zh: '本地更新样本', en: 'Local update fixture' } }], capabilities: { batchPrepare: true }, settings: { automatic: false, intervalHours: 2, channel: 'test' } };
  // Only the desktop owner is replaced: no desktop service or release channel is contacted.
  await page.route('**/dsh-plugin-hub/desktop-updates', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); requests.push(body);
      if (body.action === 'prepare') updateState.phase = 'pending';
    }
    await route.fulfill({ json: updateState });
  });
  await page.route('**/dsh-plugin-hub/desktop-installer**', route => route.fulfill({ json: { desktop: false } }));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return route.abort();
    return route.fallback();
  });
  await mkdir(evidence, { recursive: true });
  const post = async (path, body) => {
    const response = await context.request.post(app.origin + path, { data: body, headers: { Origin: app.origin } });
    assert.equal(response.ok(), true, await response.text()); return response.json();
  };
  await post('/api/agent-plugins/sources/add', { url: fixture, local: true });
  await page.goto(app.origin);
  await page.getByRole('dialog', { name: /内测声明|预览版说明/ }).getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('button', { name: '账户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await writeFile(resolve(evidence, 'settings-text.txt'), await page.locator('body').innerText());
  await page.getByRole('button', { name: '智能体市场', exact: true }).click();
  await expect(page.locator('[data-agent-plugins-workspace]')).toBeVisible();
  await page.screenshot({ path: resolve(evidence, 'manage-initial.png') });
  await writeFile(resolve(evidence, 'manage-text.txt'), await page.locator('body').innerText());
  await page.getByRole('button', { name: '安装', exact: true }).click();
  await writeFile(resolve(evidence, 'install-dialog-text.txt'), await page.locator('body').innerText());
  await page.screenshot({ path: resolve(evidence, 'install-dialog.png') });
  await page.getByRole('button', { name: '确认安装', exact: true }).click();
  const manage = page.locator('[data-agent-plugins-workspace]');
  await expect(manage.getByRole('switch', { name: '禁用', exact: true })).toBeVisible();
  await manage.getByRole('switch', { name: '禁用', exact: true }).click();
  await expect(manage.getByRole('switch', { name: '启用', exact: true })).toBeVisible();
  await manage.getByRole('switch', { name: '启用', exact: true }).click();
  await expect(manage.getByRole('switch', { name: '禁用', exact: true })).toBeVisible();
  const samples = [];
  const sample = async (selector) => page.locator(selector).evaluate(el => {
    const s = getComputedStyle(el), b = getComputedStyle(document.body);
    return { color: s.color, font: s.fontFamily, size: s.fontSize,
      version: b.getPropertyValue('--workbench-theme-version').trim(),
      text: b.getPropertyValue('--workbench-text').trim(),
      sheets: document.querySelectorAll('style[data-plugin-css$="/workbench-theme.css"]').length,
      overflow: el.scrollWidth > el.clientWidth + 1 };
  });
  for (const [theme, size] of [['浅色', 14], ['深色', 17]]) {
    await page.getByRole('button', { name: '通用设置', exact: true }).click();
    await changeThemeSetting(page, theme, 'preference');
    for (let n = 14; n < size; n++) await changeThemeSetting(page, '增大字号', 'fontSize');
    await page.getByRole('button', { name: '智能体市场', exact: true }).click();
    await expect(manage).toBeVisible();
    const m = await sample('[data-agent-plugins-workspace]');
    assert.equal(m.version, '"1.0.0"'); assert.equal(m.sheets, 1); assert.equal(m.size, `${size}px`);
    assert.equal(m.color, theme === '浅色' ? 'rgb(32, 35, 42)' : 'rgb(237, 240, 245)');
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await manage.getByRole('tab', { name: '技能', exact: true }).focus();
    await expect(manage.getByRole('tab', { name: '技能', exact: true })).toBeFocused();
    await manage.getByRole('tab', { name: '技能', exact: true }).press('Tab');
    await expect(manage.getByRole('tab', { name: '命令', exact: true })).toBeFocused();
    const focus = await page.evaluate(() => ({ style: getComputedStyle(document.activeElement).outlineStyle, html: document.activeElement.outerHTML, visible: document.activeElement.matches(':focus-visible') }));
    await writeFile(resolve(evidence, `focus-${size}.json`), JSON.stringify(focus));
    assert.equal(focus.style, 'solid');
    await page.screenshot({ path: resolve(evidence, `manage-${size}.png`) });
    await page.getByRole('button', { name: '软件更新', exact: true }).first().click();
    const hub = page.locator('[data-dsh-plugin-hub]');
    await expect(hub).toBeVisible();
    await writeFile(resolve(evidence, 'hub-text.txt'), await hub.innerText());
    await expect(hub.getByText('Agent 资源管理', { exact: true })).toBeVisible();
    const h = await sample('[data-dsh-plugin-hub]');
    assert.equal(h.version, m.version); assert.equal(h.color, m.color); assert.equal(h.font, m.font); assert.equal(h.size, m.size); assert.equal(h.sheets, 1);
    samples.push({ theme, manage: m, hub: h });
    await page.screenshot({ path: resolve(evidence, `hub-${size}.png`) });
    await hub.getByRole('button', { name: '自定义安装', exact: true }).click();
    await expect(hub.locator('input').first()).toBeVisible();
    await hub.locator('input').first().fill('@fixture/theme-check');
    const install = hub.getByRole('button', { name: '安装', exact: true }).first();
    await expect(install).toBeEnabled();
    const colors = await install.evaluate(el => {
      const style = getComputedStyle(el);
      return { foreground: style.color, background: style.backgroundColor };
    });
    const luminance = color => {
      const rgb = color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number).map(x => x / 255);
      const linear = rgb.map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    };
    const a = luminance(colors.foreground), b = luminance(colors.background);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(contrast >= 4.5, JSON.stringify({ theme, colors, contrast }));
    samples.at(-1).enabledFormButton = { ...colors, contrast };
    await page.screenshot({ path: resolve(evidence, `hub-form-${size}.png`) });
    await hub.getByRole('button', { name: '软件更新', exact: true }).click();
  }
  const hub = page.locator('[data-dsh-plugin-hub]');
  await hub.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect.poll(() => requests.some(x => x.action === 'check')).toBe(true);
  await hub.getByRole('button', { name: '全部下载', exact: true }).click();
  await expect.poll(() => requests.some(x => x.action === 'prepare')).toBe(true);
  await expect(hub.getByRole('button', { name: '应用并重启', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 720, height: 900 });
  assert.equal((await sample('[data-dsh-plugin-hub]')).overflow, false);
  await page.screenshot({ path: resolve(evidence, 'hub-narrow.png') });
  await page.getByRole('button', { name: '智能体市场', exact: true }).click();
  assert.equal((await sample('[data-agent-plugins-workspace]')).overflow, false);
  await page.screenshot({ path: resolve(evidence, 'manage-narrow.png') });
  await manage.getByRole('button', { name: '卸载', exact: true }).click();
  await page.getByRole('dialog', { name: '卸载 Agent Plugins', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(manage.getByRole('button', { name: '安装', exact: true })).toBeVisible();
  const overview = await (await context.request.get(app.origin + '/api/agent-plugins/overview')).json();
  const suite = overview.suites.find(x => x.name === 'theme-fixture');
  assert.equal(suite.installed, false); assert.equal(suite.enabled, false);
  await writeFile(resolve(evidence, 'computed.json'), JSON.stringify({ samples, requests }, null, 2));
  for (const theme of ['浅色', '深色']) {
    await page.getByRole('button', { name: '通用设置', exact: true }).click();
    await changeThemeSetting(page, theme, 'preference');
    const states = await context.newPage();
    states.on('pageerror', error => errors.push(error.message));
    let releaseManage, releaseHub;
    const manageWait = new Promise(done => { releaseManage = done; });
    const hubWait = new Promise(done => { releaseHub = done; });
    await states.route('**/api/agent-plugins/overview', async route => {
      await manageWait; await route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
    });
    await states.route('**/dsh-plugin-hub/desktop-updates', async route => {
      await hubWait; await route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
    });
    await states.route('**/dsh-plugin-hub/desktop-installer**', route => route.fulfill({ json: { supported: false } }));
    try {
      await states.goto(app.origin);
      await states.getByRole('button', { name: '账户菜单', exact: true }).click();
      await states.getByRole('menuitem', { name: '设置', exact: true }).click();
      await states.getByRole('button', { name: '智能体市场', exact: true }).click();
      await expect(states.getByText('加载中…', { exact: true })).toBeVisible();
      await states.screenshot({ path: resolve(evidence, `manage-loading-${theme}.png`) });
      releaseManage();
      await expect(states.getByText('Agent Plugins 目录加载失败，请稍后重试', { exact: true })).toBeVisible();
      await expect(states.getByRole('alert').filter({ hasText: 'Agent Plugins 目录加载失败，请稍后重试' })).toHaveCSS('opacity', '1');
      await states.screenshot({ path: resolve(evidence, `manage-error-${theme}.png`) });
      await states.getByRole('button', { name: '软件更新', exact: true }).first().click();
      await expect(states.getByText('正在读取更新状态…', { exact: true })).toBeVisible();
      await states.screenshot({ path: resolve(evidence, `hub-loading-${theme}.png`) });
      releaseHub();
      await expect(states.getByText('暂时无法读取更新状态，正在重试…', { exact: true })).toBeVisible();
      await states.screenshot({ path: resolve(evidence, `hub-error-${theme}.png`) });
    } finally { releaseManage(); releaseHub(); await states.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(evidence, 'host.log'), await readFile(resolve(app.runtime, 'server.log'), 'utf8'));
});
