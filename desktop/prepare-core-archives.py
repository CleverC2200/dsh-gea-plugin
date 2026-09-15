"""Give audited fork archives an immutable company version without publishing to npm."""
import argparse
import io
import json
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('destination', type=Path)
parser.add_argument('--version', required=True)
args = parser.parse_args()
if args.destination.exists():
    raise SystemExit('Use a new destination')
archives = sorted(args.source.glob('*.tgz'))
if not archives:
    raise SystemExit('No core archives')
manifests = {}
for archive in archives:
    with tarfile.open(archive) as tar:
        manifest = json.load(tar.extractfile('package/package.json'))
    if not manifest['name'].startswith('@deepseek-ai/dsh'):
        raise SystemExit('Not a DSH archive: ' + manifest['name'])
    manifests[archive] = manifest
names = {manifest['name'] for manifest in manifests.values()}
args.destination.mkdir(parents=True)
for archive, original in manifests.items():
    manifest = json.loads(json.dumps(original))
    manifest['version'] = args.version
    for section in ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']:
        for name in manifest.get(section, {}):
            if name in names:
                manifest[section][name] = args.version
    filename = manifest['name'].removeprefix('@').replace('/', '-') + '-' + args.version + '.tgz'
    with tarfile.open(archive) as source, tarfile.open(args.destination / filename, 'w:gz') as target:
        for member in source:
            if member.name == 'package/package.json':
                content = (json.dumps(manifest, indent=2) + '\n').encode()
                member.size = len(content)
                target.addfile(member, io.BytesIO(content))
            else:
                target.addfile(member, source.extractfile(member) if member.isfile() else None)
print(json.dumps({'version': args.version, 'packages': len(manifests)}))
