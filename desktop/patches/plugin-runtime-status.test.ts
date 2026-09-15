import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installedItemsOf } from '../src/client/logic/installed.ts'

test('installed but disabled bundle must not ask for a restart', () => {
  const name = '@linxin666/dsh-web-ui-all'
  const items = installedItemsOf(null, { [name]: '0.3.5' }, {}, null, [], [name], { [name]: 'disabled' })
  assert.equal(items[0].runtimeStatus, 'disabled')
})

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configuredBundles, pluginRuntimeStatus, isEntryLoaded, type LoaderHandle } from '../src/server/services/loader.ts'
import { runtimeStatusLabel } from '../src/client/logic/installed.ts'

test('profile → loader → installed row distinguishes disabled, pending and unsuccessful startup', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-runtime-status-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const name = '@linxin666/dsh-web-ui-all'
  const dir = join(home, 'profiles', 'full')
  const pkgDir = join(dir, 'node_modules', name)
  mkdirSync(pkgDir, { recursive: true })
  const configure = (bundles: string[]) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }))
  const loader: LoaderHandle = { entries: () => [], remove: async () => {} }
  try {
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    configure([])
    const startup = configuredBundles('full')
    const project = () => {
      const status = pluginRuntimeStatus('full', name, loader, startup)
      return installedItemsOf(null, { [name]: '0.3.5' }, {}, null, [], [name], { [name]: status })[0]
    }
    assert.equal(project().runtimeStatus, 'disabled')
    assert.equal(runtimeStatusLabel(project().runtimeStatus!), 'statusDisabled')
    // A second process sees the same disabled state: restart is not a remedy.
    assert.equal(pluginRuntimeStatus('full', name, loader, configuredBundles('full')), 'disabled')
    configure([name])
    assert.equal(project().runtimeStatus, 'pending')
    // After restart an absent configured entry is a load problem, not another restart request.
    assert.equal(pluginRuntimeStatus('full', name, loader, configuredBundles('full')), 'unloaded')
    loader.entries = () => [{ id: 'web-ui-compat', options: { name }, update: async () => {} }]
    assert.equal(pluginRuntimeStatus('full', name, loader, [name]), 'running')
    loader.entries = () => [{ id: 'web-ui-compat', options: { name, disabled: true }, update: async () => {} }]
    assert.equal(isEntryLoaded(loader, name), false)
    assert.equal(pluginRuntimeStatus('full', name, undefined, []), 'unknown')
    writeFileSync(join(dir, 'package.json'), '{')
    assert.equal(pluginRuntimeStatus('full', name, loader, []), 'unknown')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
