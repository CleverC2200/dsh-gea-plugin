import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

const args = new Map(process.argv.slice(2).map((value, index, values) => value.startsWith('--') ? [value, values[index + 1]] : []));
const base = args.get('--base-tag');
if (!base) throw new Error('Usage: pnpm release:preflight -- --base-tag gea-vX.Y.Z');
const run = (...command) => execFileSync(command[0], command.slice(1), {encoding:'utf8'}).trim();
if (run('git','status','--porcelain')) throw new Error('RELEASE_DIRTY: commit or remove all working-tree changes first');
// 版本号相同也可能有技能漂移；发布前在线核对两项团队技能。
execFileSync('python3', ['scripts/team-workflow.py', 'check'], {stdio: 'inherit'});
const head = run('git','rev-parse','HEAD');
const tag = run('git','rev-parse',base);
const manifest = JSON.parse(readFileSync('package.json','utf8'));
const previous = JSON.parse(run('git','show',`${base}:package.json`));
if (manifest.version === previous.version) throw new Error(`VERSION_UNCHANGED: ${manifest.version}`);
const required = [
  ['summary detail title', '当前页明细汇总'],
  ['funnel filter icon', '<Filter size={16} strokeWidth={3} />'],
  ['toolbar progress icon', '<ChartHistogram size={16} />'],
  ['multi-select', 'setSelectedRowIds(keys.map(String))'],
];
const source = readFileSync('src/workbench/original/workbenches/regionalApproval/RegionalApprovalWorkbench.tsx','utf8');
const zh = readFileSync('src/workbench/original/zh-CN.json','utf8');
for (const [label, marker] of required) if (!(source.includes(marker) || zh.includes(marker))) throw new Error(`RELEASE_FEATURE_MISSING: ${label}`);
console.log(JSON.stringify({baseTag:base,baseCommit:tag,head,version:manifest.version,requiredFeatures:required.map(([label])=>label)}));
