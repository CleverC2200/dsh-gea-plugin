import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';

const { outputFiles } = await build({
  entryPoints: ['src/workbench/original/workbenches/regionalApproval/RegionalApprovalLiveProgress.tsx'],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  packages: 'external', outdir: 'out',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const Progress = module.exports.default;
const resources = Object.fromEntries(await Promise.all(['zh-CN', 'en-US'].map(async language => [
  language, { translation: { common: JSON.parse(await readFile(new URL(`../src/workbench/original/${language}.json`, import.meta.url), 'utf8')) } },
])));

for (const language of ['zh-CN', 'en-US']) {
  test(`submission progress renders translated columns and states (${language})`, async () => {
    const locale = i18next.createInstance();
    await locale.init({ lng: language, fallbackLng: 'en-US', resources, interpolation: { escapeValue: false } });
    const html = renderToStaticMarkup(React.createElement(Progress, {
      records: [
        { status: 1, areaCode: 'a', areaName: 'North', dealerCode: 'c1' },
        { status: 10, areaCode: 'a', areaName: 'North', dealerCode: 'c2' },
        { status: 1, areaCode: 'b', areaName: 'South', dealerCode: 'c3' },
      ],
      status: 'success', t: locale.t.bind(locale), onRetry() {},
    }));
    assert.doesNotMatch(html, /common\.assistantSurface\.regionalApproval\.progressDialog\.[\w.]+/);
    const prefix = 'common.assistantSurface.regionalApproval.progressDialog.';
    for (const key of ['organization', 'completion', 'pendingCount', 'status', 'awaitingReview', 'inProgress', 'completed']) {
      assert.equal(locale.exists(prefix + key, { lng: language, fallbackLng: false }), true, `${language}: ${key}`);
    }
    assert.match(html, language === 'zh-CN' ? /审核中/ : /In progress/);
    assert.match(html, language === 'zh-CN' ? /待审核/ : /Awaiting review/);
  });
}
