"""Assemble a new platform runtime from audited package archives and an upstream Node distribution."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, subprocess, tarfile

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
manifest = {'name': 'gea-desktop-runtime', 'version': version, 'private': True, 'type': 'module', 'desktopDataSchema': json.loads((desktop / 'package.json').read_text())['desktopDataSchema'], 'dependencies': {name: overrides[name] for name in roots}}
(target / 'package.json').write_text(json.dumps(manifest, indent=2) + '\n')
workspace = {'nodeLinker': 'hoisted', 'virtualStoreDirMaxLength': 120 if args.platform == 'mac' else 60, 'minimumReleaseAge': 0, 'overrides': overrides, 'supportedArchitectures': {'os': ['darwin' if args.platform == 'mac' else 'win32'], 'cpu': ['arm64' if args.platform == 'mac' else 'x64']}}
if records['@deepseek-ai/dsh-client-modules']['version'] == '0.1.5-rc.2':
    patch = 'client-modules-newline-scan.patch'
    shutil.copy2(desktop / 'patches' / patch, target / 'packages' / patch)
    workspace['patchedDependencies'] = {'@deepseek-ai/dsh-client-modules@0.1.5-rc.2': 'packages/' + patch}
(target / 'pnpm-workspace.yaml').write_text(json.dumps(workspace, indent=2) + '\n')
(target / 'archives.json').write_text(json.dumps(records, indent=2) + '\n')
shutil.copytree(args.node_distribution, target / 'node', symlinks=True)
for name in ['runtime-start.mjs', 'onboarding.mjs', 'company-resources.mjs', 'html-plugins.mjs']:
    shutil.copy2(desktop / name, target / ('start.mjs' if name == 'runtime-start.mjs' else name))
subprocess.run(['node', str(desktop / 'prepare-tools.mjs'), str(target)], check=True)
subprocess.run(['node', str(target / 'tools/node_modules/pnpm/bin/pnpm.cjs'), 'install', '--prod', '--ignore-scripts', '--prefer-offline'], cwd=target, check=True)
source = 'http://100.100.6.191:20656/chenyonghao/company-agent-suites.git'
resource = target / 'resources' / 'company-agent-suites'
subprocess.run(['git', 'clone', '--depth', '1', '--branch', 'main', source, str(resource)],
               check=True, env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
commit = subprocess.check_output(['git', '-C', str(resource), 'rev-parse', 'HEAD'], text=True).strip()
shutil.rmtree(resource / '.git')
(target / 'resources' / 'receipt.json').write_text(json.dumps({'source': source, 'commit': commit}, indent=2) + '\n')
print(target)
