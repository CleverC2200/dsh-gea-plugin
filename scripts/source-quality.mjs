import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const listed = (...args) => git(...args).split('\0').filter(Boolean);
const skill = file => /(?:^|\/)(?:SKILL\.md|[^/]+\.skill\.md)$/.test(file);
function resource(file) {
  if (file.split('/').includes('fixtures')) return false;
  if (/(?:^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-(?:lock|workspace)\.yaml|yarn\.lock|requirements[^/]*\.txt)$/.test(file)) return false;
  return /^(?:business-resources|presets|default-presets|docs\/agent-inputs)\//.test(file) || skill(file) || /^business\/[^/]+\/(?:plugin\.json|page\.json|sql\.config\.json|SOURCE\.md)$/.test(file);
}
function plan() {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const head = process.env.SOURCE_HEAD_SHA || event.pull_request?.head?.sha || event.after || git('rev-parse', 'HEAD').trim();
  if (git('rev-parse', head) !== git('rev-parse', 'HEAD')) throw Error('SOURCE_HEAD_MISMATCH');
  const base = process.env.SOURCE_BASE_SHA || event.pull_request?.base?.sha || event.before;
  const hasBase = base && !/^0+$/.test(base);
  const diffBase = hasBase ? process.env.GITHUB_EVENT_NAME === 'pull_request' ? git('merge-base', base, head).trim() : base : null;
  const files = hasBase ? listed('diff', '--no-renames', '--name-only', '-z', diffBase, head) : listed('ls-files', '-z');
  const documentation = file => /^(?:docs\/|docs-site\/|\.agents\/notes\/)/.test(file) && /\.(?:md|mdx|txt)$/.test(file) || /^[^/]+\.md$/.test(file);
  const mode = hasBase && files.length && files.every(file => !resource(file) && documentation(file)) ? 'docs' : hasBase && files.length && files.every(file => resource(file) || documentation(file)) ? 'resources' : 'code';
  return { mode, files, base: diffBase, head, engineering: mode === 'code', 'dependency-review': mode === 'code' && process.env.GITHUB_EVENT_NAME === 'pull_request', codeql: mode === 'code' || files.some(file => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) };
}

function checkResources(result) {
  const tracked = listed('ls-files', '-z');
  const groups = result.files.filter(resource).map(file => /^(?:business-resources|business)\/[^/]+\//.exec(file)?.[0] || dirname(file) + '/');
  const skillChanged = result.files.some(skill);
  const files = tracked.filter(file => resource(file) && (groups.some(group => file.startsWith(group)) || skillChanged && /^business-resources\/[^/]+\/(?:prompt|capability)\.json$/.test(file)));
  const root = realpathSync(process.cwd());
  function reference(file, target) {
    const path = resolve(dirname(file), target);
    if (!tracked.some(entry => entry === relative(root, path) || entry.startsWith(relative(root, path) + '/')) || !existsSync(path)) throw Error(`RESOURCE_REFERENCE_MISSING: ${file}: ${target}`);
    const local = relative(root, realpathSync(path));
    if (local === '..' || local.startsWith('../') || isAbsolute(local)) throw Error(`RESOURCE_REFERENCE_OUTSIDE: ${file}: ${target}`);
    return path;
  }
  for (const file of files) {
    if (!/\.(?:md|json|mjs|cjs|js|py)$/.test(file)) continue;
    const text = readFileSync(reference(file, basename(file)), 'utf8');
    if (/\.(?:mjs|cjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (file.endsWith('.py')) execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), filename=sys.argv[1])', file], { stdio: 'inherit' });
    if (file.endsWith('.json')) {
      const value = JSON.parse(text);
      if (file.endsWith('/SOURCE.json') && Array.isArray(value.files)) for (const entry of value.files) {
        if (typeof entry.path !== 'string' || typeof entry.packagedSha256 !== 'string') throw Error(`RESOURCE_INTEGRITY_METADATA: ${file}`);
        const path = reference(file, entry.path);
        if (createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.packagedSha256) throw Error(`RESOURCE_INTEGRITY_MISMATCH: ${file}: ${entry.path}`);
      }
      if (/(?:^|\/)(?:prompt|capability)\.json$/.test(file) && Array.isArray(value.skills)) {
        const names = tracked.filter(path => /^business-resources\//.test(path) && skill(path)).map(path => readFileSync(reference(path, basename(path)), 'utf8').match(/^name:\s*(.+)$/m)?.[1].trim());
        for (const name of value.skills) if (!names.includes(name)) throw Error(`RESOURCE_SKILL_MISSING: ${file}: ${name}`);
      }
      if (/^business\/[^/]+\/plugin\.json$/.test(file)) {
        if (!value.id || value.id !== dirname(file).split('/').at(-1)) throw Error(`RESOURCE_ID_MISMATCH: ${file}`);
        for (const target of [value.declarations?.page, value.sqlConfig].filter(Boolean)) reference(file, target);
      }
    }
    if (file.endsWith('.md')) {
      if (skill(file) && (!/^name:\s*\S+/m.test(text) || !/^description:\s*\S+/m.test(text))) throw Error(`RESOURCE_SKILL_METADATA: ${file}`);
      for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const target = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue;
        reference(file, decodeURIComponent(target));
      }
    }
  }
  if (groups.includes('business-resources/inventory-orderfulfillment/') && existsSync('tests/fulfillment-resource-package.test.mjs')) execFileSync(process.execPath, ['--test', 'tests/fulfillment-resource-package.test.mjs'], { stdio: 'inherit' });
  console.log(JSON.stringify({ mode: result.mode, checked: files.length }));
}

function check(result) {
  if (result.mode === 'docs') return console.log(JSON.stringify({ mode: 'docs', checked: 0 }));
  checkResources(result);
  if (result.mode !== 'code') return;
  if (result.base) {
    const changedCode = result.files.filter(file => !file.endsWith('.md') && !file.endsWith('.mdx'));
    if (changedCode.length) execFileSync('git', ['diff', '--check', result.base, result.head, '--', ...changedCode], { stdio: 'inherit' });
  }
  for (const file of listed('ls-files', '-z')) {
    if (file.split('/').includes('fixtures')) continue;
    if (/\.(?:mjs|cjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    else if (file.endsWith('.json')) JSON.parse(readFileSync(file, 'utf8'));
  }
}

const phase = process.argv[process.argv.indexOf('--phase') + 1];
const result = plan();
if (phase === 'plan') {
  if (process.env.GITHUB_OUTPUT) for (const key of ['mode', 'engineering', 'dependency-review', 'codeql']) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${result[key]}\n`);
  console.log(JSON.stringify(result));
} else if (phase === 'check') check(result);
else if (phase === 'final') {
  const expected = { PLAN_RESULT: 'success', CHECK_RESULT: result.mode === 'docs' ? 'skipped' : 'success', DEPENDENCY_RESULT: result['dependency-review'] ? 'success' : 'skipped' };
  if (process.env.HAS_CODEQL === 'true') expected.CODEQL_RESULT = result.codeql ? 'success' : 'skipped';
  for (const [key, value] of Object.entries(expected)) if (process.env[key] !== value) throw Error(`SOURCE_RESULT_REJECTED: ${key}=${process.env[key] || 'missing'}, expected ${value}`);
  console.log(JSON.stringify({ mode: result.mode, status: 'success' }));
} else throw Error('SOURCE_PHASE_REQUIRED');
