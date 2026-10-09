import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceWindow, snapshot } from './fixtures/source-window.mjs';

test('startup rejects incomplete selection digests and manifest-only changes before launching a Host', async t => {
  for (const kind of ['missing', 'empty', 'null', 'manifest-changed']) {
    await t.test(kind, async t => {
      const fixture = await sourceWindow(t, 'source-host');
      const file = join(fixture.runtime, 'source-selection.json');
      const selected = JSON.parse(await readFile(file, 'utf8'));
      if (kind === 'missing') delete selected.manifestSha256;
      if (kind === 'empty') selected.manifestSha256 = '';
      await writeFile(file, JSON.stringify(kind === 'null' ? null : selected));
      if (kind === 'manifest-changed') {
        const manifest = join(fixture.runtime, 'source-combinations', selected.id, 'combination.json');
        await writeFile(manifest, (await readFile(manifest, 'utf8')) + ' ');
      }
      await writeFile(join(fixture.runtime, 'user-data.txt'), 'keep user data');
      const before = await snapshot(fixture.runtime), result = fixture.run('runSourceProfile');
      assert.equal(result.status, 1); assert.match(result.stderr, /SOURCE_SELECTION_DIGEST_MISMATCH|WINDOW_COMBINATION_MISMATCH/);
      assert.deepEqual(await snapshot(fixture.runtime), before);
      const effects = JSON.parse(await readFile(fixture.observation, 'utf8'));
      assert.deepEqual(effects.writes, []); assert.deepEqual(effects.processes, []); assert.deepEqual(effects.network, []); assert.deepEqual(effects.credentialReads, []); assert.deepEqual(effects.after, effects.before);
    });
  }
});
