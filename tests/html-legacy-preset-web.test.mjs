/** Unsupported packages fail before registering any runtime effects. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {registerHtmlPlugins} from '../src/html-plugins.ts';

for (const resources of [undefined, {provider: 'dsh-agent-manage', prompt: 'prompt.json'}])
  test(`legacy HTML manifest is unsupported with ${resources ? 'partial' : 'absent'} resources`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'unsupported-html-'));
    t.after(() => rm(root, {recursive: true, force: true}));
    await writeFile(join(root, 'plugin.json'), JSON.stringify({schemaVersion: 1, id: 'inventory-probe', name: 'Probe', html: 'index.html', gea: {contract: 'gea-html-v1', readonly: true, consumerCode: 'probe'}, ...(resources ? {agentResources: resources} : {})}));
    let effects = 0;
    const business = {watchIdentity: () => () => {}, pageSessionScope: () => '', config: {runtimeDir: root}};
    await assert.rejects(registerHtmlPlugins({effect: () => effects++}, business, [root]), /INVALID_HTML_PLUGIN/);
    assert.equal(effects, 0);
  });
