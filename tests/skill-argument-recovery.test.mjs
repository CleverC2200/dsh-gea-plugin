import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mountBusinessPrompts } from '../src/host/prompt-runtime.ts';

function fixture(t) {
  const registered = new Map();
  const tools = {
    register(tool) { registered.set(tool.name, tool); return () => {}; },
    guard: () => () => {}, restrict: () => () => {}, schemas: () => [],
  };
  const ctx = {
    tools, sessionProjections: { stateOf: () => 'gea-html-inventory-qll' },
    skills: { get: async () => ({
      invocation: { modelInvocable: true },
      resourceBase: { kind: 'directory', path: '/not-a-real-skill-directory' },
      content: '规则正文\n第二行\n[参考](references/rules.md)',
    }) },
    on: () => () => {}, inject: () => {},
  };
  const business = {
    config: { runtimeDir: tmpdir() }, watchIdentity: () => () => {},
    readTurnRevision: () => 1, turnStopKind: () => undefined, surfaceFor: () => undefined,
  };
  t.after(mountBusinessPrompts(ctx, business, { readModules: () => [] }, new Map()));
  const agent = {
    id: 'argument-recovery', ctx: { tools, effect: fn => fn() },
    session: { header: { cwd: tmpdir() }, snapshotEvents: () => [], deriveMessages: () => [] },
  };
  return args => registered.get('gea_skill').execute(
    { name: 'inventory-qll', ...args }, { agent, signal: new AbortController().signal },
  ).then(JSON.parse);
}

test('screenshot argument shape reads the skill body without treating paging as a file', async t => {
  const read = fixture(t);
  const result = await read({ path: 'offset 1, limit 80, reload=true' });
  assert.equal(result.content, '规则正文\n第二行\n[参考](references/rules.md)');
  assert.equal(result.path, undefined);
  assert.equal(result.complete, true);
  assert.match(result.argumentCorrection, /path/);
  const page = await read({ path: 'offset=2, limit=1, reload=false' });
  assert.equal(page.content, '第二行');
  assert.deepEqual(page.nextRead.args, { name: 'inventory-qll', offset: 3, limit: 1 });
});

test('ambiguous or invalid paging is rejected; real reference boundaries remain intact', async t => {
  const read = fixture(t);
  await assert.rejects(read({ path: 'offset 1, limit 80, reload=true', offset: 2 }), /GEA_SKILL_ARGUMENT/);
  await assert.rejects(read({ path: 'offset 0, limit 80, reload=true' }), /GEA_SKILL_RANGE/);
  await assert.rejects(read({ path: 'offset 1, limit 999, reload=true' }), /GEA_SKILL_RANGE/);
  for (const path of ['../../secret', 'file:///etc/passwd', 'https://example.com', 'offset 1, limit 80, reload=true; secret']) {
    await assert.rejects(read({ path }), error => {
      assert.match(error.message, /GEA_SKILL_REFERENCE_NOT_LINKED/);
      assert.match(error.message, /省略path/);
      assert.match(error.message, /"offset":1/);
      return true;
    });
  }
});
