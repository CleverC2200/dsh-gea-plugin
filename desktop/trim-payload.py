"""Copy an existing platform payload, retaining runtime code and uninstalled plugins."""
from pathlib import Path
import shutil,json,time,sys,datetime
source=Path(sys.argv[1]).resolve();target=Path(sys.argv[2]).resolve()
if target.exists():raise SystemExit('Refusing to overwrite existing trim destination')
started=datetime.datetime.now(datetime.timezone.utc).isoformat();timer=time.perf_counter()
shutil.copytree(source,target,symlinks=True)
removed=[]
def remove(p,reason):
 if p.is_symlink():size=0;p.unlink()
 elif p.is_file():size=p.stat().st_size;p.unlink()
 else:
  size=sum(f.stat().st_size for f in p.rglob('*') if f.is_file() and not f.is_symlink());shutil.rmtree(p)
 removed.append({'path':str(p.relative_to(target)),'reason':reason,'bytes':size})
for p in list((target/'node_modules').rglob('*.map')):
 if p.is_file() and not p.is_symlink():remove(p,'source-map')
for name in ['node/include','node/share']:
 p=target/name
 if p.exists():remove(p,'node-development-files')
manifest=json.loads((target/'plugins.json').read_text());installed=0
for name,record in manifest['packages'].items():
 package=target/'node_modules'/name/'package.json'
 if package.exists() and json.loads(package.read_text()).get('version')==record['version']:
  archive=target/'packages'/record['file']
  if archive.exists():remove(archive,'already-installed-plugin')
  record['distribution']='installed';record['installedPath']='node_modules/'+name;installed+=1
 else:record['distribution']='archive'
(target/'plugins.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
# This payload is immutable; its old installer lock references the removed duplicate archives.
for name in ['package-lock.json','使用说明.md']:
 p=target/name
 if p.exists():remove(p,'superseded-installation-metadata')
package=json.loads((target/'package.json').read_text());package.pop('overrides',None)
package['dependencies']={n:manifest['packages'][n]['version'] for n in package['dependencies']}
(target/'package.json').write_text(json.dumps(package,indent=2)+'\n')
shutil.copy2(Path(__file__).with_name('README.md'),target/'使用说明.md')
report={'startedUtc':started,'endedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':round(time.perf_counter()-timer,3),'source':str(source),'target':str(target),'installedPlugins':installed,'archivePlugins':len(manifest['packages'])-installed,'removedBytes':sum(r['bytes']for r in removed),'removedFiles':removed}
(target.parent/'trim-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items()if k!='removedFiles'},ensure_ascii=False))
