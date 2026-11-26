import base64
import hashlib
import json
import subprocess
import sys
import tarfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

root = Path(__file__).parent
target = Path(sys.argv[1])
target.mkdir(mode=0o700)
archives = root / 'deployed-archives'
archives.mkdir(mode=0o700, exist_ok=True)
origin = 'https://synear-gea.oss-cn-hangzhou.aliyuncs.com/'
repos = ('dsh-agent-workbench', 'dsh-agent-manage', 'dsh-gea-plugin')

def obj(path):
    return json.loads(path.read_bytes())

def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def read(url):
    assert url.startswith(origin), 'UNKNOWN_DISTRIBUTION_ORIGIN'
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=90) as response:
        assert response.url == url
        return response.read()

def sha(content):
    return hashlib.sha256(content).hexdigest()

def source(repo):
    head = subprocess.check_output(['gh', 'api', f'repos/CleverC2200/{repo}/git/ref/heads/main', '--jq', '.object.sha'], text=True).strip()
    return {'repo': repo, 'head': head}

def archive(entry, url, digest):
    path = archives / (digest + '.tgz')
    if not path.exists():
        content = read(url)
        assert sha(content) == digest, entry['name']
        with path.open('xb') as file:
            file.write(content)
    assert sha(path.read_bytes()) == digest
    with tarfile.open(path, mode='r:gz') as bundle:
        manifest = json.load(bundle.extractfile('package/package.json'))
    assert (manifest['name'], manifest['version']) == (entry['name'], entry['version'])
    return {**manifest, 'artifactSha256': digest}

def release(reference):
    data = read(reference['url'])
    assert sha(data) == reference['sha256'], reference['name']
    entry = json.loads(data)
    assert entry['name'] == reference['name']
    artifact = entry['artifact']
    manifest = archive(entry, artifact['url'], artifact['sha256'])
    assert artifact['size'] == (archives / (artifact['sha256'] + '.tgz')).stat().st_size
    return manifest

desktop_snapshots = []
for file in sorted(root.glob('desktop-2026*.json')):
    desktop = obj(file)
    with ThreadPoolExecutor(max_workers=4) as jobs:
        installed = list(jobs.map(lambda package: archive(package, package.get('url') or origin + 'plugin-release/packages/' + package['sha256'] + '/' + package['name'].lstrip('@').replace('/','-') + '-' + package['version'] + '.tgz', package['sha256']), desktop['packages']))
    desktop_snapshots.append((desktop['core'], {'id': file.stem, 'installed': installed}))
deployed = [snapshot for _, snapshot in desktop_snapshots]
extra = deployed[-1]['installed']
channels = {}
for name in ('test', 'stable'):
    envelope = read(origin + f'plugin-release/channels/plugin-detail-{name}.json')
    (target / f'channel-{name}.json').write_bytes(envelope)
    payload = json.loads(base64.b64decode(json.loads(envelope)['payloadBase64'], validate=True))
    assert payload['channel'] == ('plugin-detail-test' if name == 'test' else 'stable') and payload['suite'] is True
    channels[name] = payload
    refs = payload['releases'] + payload['companionReleases'] + payload.get('optionalReleases', [])
    with ThreadPoolExecutor(max_workers=4) as jobs:
        installed = list(jobs.map(release, refs))
    names = {item['name'] for item in installed}
    installed.extend(item for item in extra if item['name'] not in names)
    deployed.append({'id': name + '-channel', 'installed': installed})
    print(name, payload['revision'], [(item['name'], item['version']) for item in installed])
with ThreadPoolExecutor(max_workers=3) as jobs:
    sources = list(jobs.map(source, repos))
core = obj(root / 'desktop-core-environment.json')
dump(target / 'environment.json', {'core': core, 'installed': deployed[-1]['installed']})
dump(target / 'baseline.json', {'sources': sources, 'channels': channels, 'deployed': deployed})
