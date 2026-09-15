"""Assemble a new platform runtime from audited package archives and an upstream Node distribution."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('platform', choices=['mac', 'win'])
parser.add_argument('archives', type=Path)
parser.add_argument('node_distribution', type=Path)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
desktop = Path(__file__).resolve().parent
target = args.destination.resolve()
if target.exists():
    raise SystemExit('Use a new destination; existing payloads are never overwritten')
records = {}
for archive in sorted(args.archives.resolve().glob('*.tgz')):
    with tarfile.open(archive) as content:
        manifest_path = next(name for name in content.getnames() if name.endswith('/package.json') and len(Path(name).parts) == 2)
        manifest = json.load(content.extractfile(manifest_path))
    name = manifest['name']
    if name in records:
        raise SystemExit('Provide exactly one version per package: ' + name)
    records[name] = {'version': manifest['version'], 'file': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
roots = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@cleverc2200/gea-dsh-prototype', '@cleverc2200/dsh-agent-workbench', 'dsh-plugin', 'dsh-agent-manage', '@dsh-external/dsh-visualize']
for name in roots:
    if name not in records:
        raise SystemExit('Missing required package: ' + name)
(target / 'packages').mkdir(parents=True)
for record in records.values():
    shutil.copy2(args.archives / record['file'], target / 'packages' / record['file'])
overrides = {name: 'file:packages/' + record['file'] for name, record in records.items() if name.startswith('@deepseek-ai/') or name in roots}
version = json.loads((desktop / 'package.json').read_text())['version']
manifest = {'name': 'gea-desktop-runtime', 'version': version, 'private': True, 'type': 'module', 'desktopDataSchema': 1, 'dependencies': {name: overrides[name] for name in roots}}
(target / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
workspace = {'nodeLinker': 'hoisted', 'minimumReleaseAge': 0, 'overrides': overrides, 'supportedArchitectures': {'os': ['darwin' if args.platform == 'mac' else 'win32'], 'cpu': ['arm64' if args.platform == 'mac' else 'x64']}}
(target / 'pnpm-workspace.yaml').write_text(json.dumps(workspace, indent=2) + '\n')
(target / 'archives.json').write_text(json.dumps(records, indent=2) + '\n')
shutil.copytree(args.node_distribution, target / 'node', symlinks=True)
for name in ['runtime-start.mjs', 'onboarding.mjs', 'company-resources.mjs']:
    shutil.copy2(desktop / name, target / ('start.mjs' if name == 'runtime-start.mjs' else name))
subprocess.run(['node', str(desktop / 'prepare-tools.mjs'), str(target)], check=True)
subprocess.run(['node', str(target / 'tools/node_modules/pnpm/bin/pnpm.cjs'), 'install', '--prod', '--ignore-scripts', '--prefer-offline'], cwd=target, check=True)
subprocess.run(['node', '--input-type=module', '--eval', """
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
const root=process.argv[1];
const {archiveInstall}=await import(pathToFileURL(join(root,'node_modules/dsh-agent-manage/lib/catalog/archive.js')));
const source='https://api.github.com/repos/CleverC2200/company-agent-suites/zipball/main';
const result=await archiveInstall(source,join(root,'resources/company-agent-suites'));
await writeFile(join(root,'resources/receipt.json'),JSON.stringify({source,...result},null,2)+'\\n');
""", str(target)], check=True)
print(target)
