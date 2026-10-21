import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./source-quality.mjs', import.meta.url));
function fixture(t, files, changed) {
  const root = mkdtempSync(join(tmpdir(), 'source-quality-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Source quality test');
  git('config', 'user.email', 'source-quality@example.invalid');
  const put = entries => { for (const [file, content] of Object.entries(entries)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    if (content === null) rmSync(join(root, file));
    else writeFileSync(join(root, file), content);
  } };
  put(files);
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  put(changed);
  git('add', '.'); git('commit', '-qm', 'change');
  const head = git('rev-parse', 'HEAD');
  const event = join(root, '.git/event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  const env = { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event };
  return { root, git, base, head, run: (phase, extra = {}) => spawnSync(process.execPath, [cli, '--phase', phase], { cwd: root, encoding: 'utf8', env: { ...env, ...extra } }) };
}

test('a README-only pull request needs no engineering checks, including Markdown hard breaks', t => {
  const repo = fixture(t, { 'README.md': 'Before\n', 'unrelated.js': 'broken syntax !' }, { 'README.md': 'After  \nHard break\n' });
  const result = repo.run('plan');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'docs');
});

test('packaged Skills and consumed agent inputs stay resources despite Markdown suffixes', t => {
  for (const file of ['business-resources/demo/skills/demo/SKILL.md', 'docs/agent-inputs/demo.md', 'presets/demo.skill.md']) {
    const repo = fixture(t, { [file]: 'before\n' }, { [file]: 'after  \n' });
    const result = repo.run('plan');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, 'resources', file);
  }
});

test('resource-only checks accept Markdown hard breaks and reject missing packaged references', t => {
  const file = 'business-resources/demo/skills/demo/SKILL.md';
  const repo = fixture(t, { [file]: '---\nname: demo\ndescription: Demo\n---\nBefore\n', 'unrelated.js': 'broken syntax !' }, { [file]: '---\nname: demo\ndescription: Demo\n---\n[Rules](rules.md)  \n' });
  const missing = repo.run('check');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RESOURCE_REFERENCE_MISSING.*rules\.md/);
  writeFileSync(join(repo.root, 'business-resources/demo/skills/demo/rules.md'), 'Rules  \n');
  repo.git('add', '.'); repo.git('commit', '-qm', 'include reference');
  const result = repo.run('check', { SOURCE_BASE_SHA: repo.base, SOURCE_HEAD_SHA: repo.git('rev-parse', 'HEAD') });
  assert.equal(result.status, 0, result.stderr);
});

test('candidate-quality accepts only intended skips and fails closed for failed, cancelled or unknown jobs', t => {
  const docs = fixture(t, { 'README.md': 'Before\n' }, { 'README.md': 'After\n' });
  const skipped = { PLAN_RESULT: 'success', CHECK_RESULT: 'skipped', DEPENDENCY_RESULT: 'skipped', CODEQL_RESULT: 'skipped', HAS_CODEQL: 'true' };
  assert.equal(docs.run('final', skipped).status, 0);
  for (const result of ['failure', 'cancelled', '', 'unknown']) {
    assert.notEqual(docs.run('final', { ...skipped, PLAN_RESULT: result }).status, 0);
    assert.notEqual(docs.run('final', { ...skipped, CHECK_RESULT: result }).status, 0);
  }
  const resources = fixture(t, { 'business-resources/demo/rules.md': 'Before\n' }, { 'business-resources/demo/rules.md': 'After\n' });
  assert.equal(resources.run('final', { ...skipped, CHECK_RESULT: 'success' }).status, 0);
  assert.notEqual(resources.run('final', skipped).status, 0);
  const code = fixture(t, { 'src/main.js': 'export const value = 1;\n' }, { 'src/main.js': 'export const value = 2;\n' });
  const success = { PLAN_RESULT: 'success', CHECK_RESULT: 'success', DEPENDENCY_RESULT: 'success', CODEQL_RESULT: 'success', HAS_CODEQL: 'true' };
  assert.equal(code.run('final', success).status, 0);
  for (const key of ['CHECK_RESULT', 'DEPENDENCY_RESULT', 'CODEQL_RESULT']) for (const result of ['skipped', 'failure', 'cancelled', '', 'unknown']) assert.notEqual(code.run('final', { ...success, [key]: result }).status, 0, `${key}=${result}`);
});

test('resource declarations reject skills absent from their packaged capability', t => {
  const repo = fixture(t, {
    'business-resources/demo/prompt.json': '{"skills":["demo"]}',
    'business-resources/demo/capability.json': '{"id":"demo","skills":["demo"]}',
    'business-resources/demo/skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo\n---\n'
  }, { 'business-resources/demo/capability.json': '{"id":"demo","skills":["missing"]}' });
  const result = repo.run('check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESOURCE_SKILL_MISSING/);
});

test('declared packaged bytes reject changed content', t => {
  const repo = fixture(t, {
    'business-resources/demo/SOURCE.json': '{"files":[{"path":"rules.md","packagedSha256":"invalid"}]}',
    'business-resources/demo/rules.md': 'Before\n'
  }, { 'business-resources/demo/rules.md': 'After\n' });
  const result = repo.run('check');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESOURCE_INTEGRITY_MISMATCH/);
});

test('unknown source files and missing bases retain engineering checks', t => {
  const repo = fixture(t, { 'docs/rules.md': 'Before\n' }, { 'scripts/new-tool.mjs': 'export const value = 1;\n' });
  assert.equal(JSON.parse(repo.run('plan').stdout).mode, 'code');
  assert.equal(JSON.parse(repo.run('plan', { GITHUB_EVENT_PATH: '', SOURCE_BASE_SHA: '' }).stdout).mode, 'code');
  assert.notEqual(repo.run('plan', { SOURCE_BASE_SHA: 'missing-commit' }).status, 0);
  assert.notEqual(repo.run('plan', { SOURCE_HEAD_SHA: repo.base }).status, 0);
});

test('dependency manifests inside a resource package still require engineering and dependency review', t => {
  const repo = fixture(t, { 'business-resources/demo/package.json': '{"name":"demo"}' }, { 'business-resources/demo/package.json': '{"name":"demo","dependencies":{"example":"1.0.0"}}' });
  const result = repo.run('plan');
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, 'code');
  assert.equal(plan['dependency-review'], true);
});

test('deleting or renaming a shared Skill rejects consumers that still reference its old name', t => {
  for (const rename of [false, true]) {
    const skill = 'business-resources/analysis/demo.skill.md';
    const changed = { [skill]: null };
    if (rename) changed['business-resources/analysis/renamed.skill.md'] = '---\nname: renamed\ndescription: Analysis\n---\n';
    const repo = fixture(t, {
      [skill]: '---\nname: demo\ndescription: Analysis\n---\n',
      'business-resources/consumer/prompt.json': '{"skills":["demo"]}'
    }, changed);
    const result = repo.run('check');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RESOURCE_SKILL_MISSING.*consumer\/prompt.json.*demo/);
  }
});

test('pull requests compare their merge-base while push events retain the pushed interval', t => {
  const repo = fixture(t, { 'README.md': 'Before\n' }, { 'README.md': 'After\n' });
  repo.git('checkout', '-qb', 'target', repo.base);
  writeFileSync(join(repo.root, 'new-code.js'), 'export const value = 1;\n');
  repo.git('add', '.'); repo.git('commit', '-qm', 'target-only code');
  const target = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '-q', '--detach', repo.head);
  const pullRequest = repo.run('plan', { SOURCE_BASE_SHA: target });
  assert.equal(pullRequest.status, 0, pullRequest.stderr);
  assert.equal(JSON.parse(pullRequest.stdout).mode, 'docs');
  const push = repo.run('plan', { SOURCE_BASE_SHA: target, GITHUB_EVENT_NAME: 'push' });
  assert.equal(push.status, 0, push.stderr);
  assert.equal(JSON.parse(push.stdout).mode, 'code');
});


test('JavaScript resources retain security scanning without unrelated engineering preparation', t => {
  const repo = fixture(t, { 'business-resources/demo/scripts/run.mjs': 'export const value = 1;\n' }, { 'business-resources/demo/scripts/run.mjs': 'export const value = 2;\n' });
  const planned = repo.run('plan');
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.mode, 'resources');
  assert.equal(plan.engineering, false);
  assert.equal(plan['dependency-review'], false);
  assert.equal(plan.codeql, true);
  const results = { PLAN_RESULT: 'success', CHECK_RESULT: 'success', DEPENDENCY_RESULT: 'skipped', CODEQL_RESULT: 'success', HAS_CODEQL: 'true' };
  assert.equal(repo.run('final', results).status, 0);
  assert.notEqual(repo.run('final', { ...results, CODEQL_RESULT: 'skipped' }).status, 0);
});
