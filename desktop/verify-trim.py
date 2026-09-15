"""Verify trimmed payloads retain every runtime file and all inventory entries."""
from pathlib import Path
import json,hashlib,sys
root=Path(sys.argv[1]);results=[]
for platform in ['mac','win']:
 report=json.loads((root/platform/'trim-report.json').read_text());source=Path(report['source']);target=Path(report['target'])
 removed=[r['path'] for r in report['removedFiles']];changed={'plugins.json','package.json','使用说明.md'};checked=0
 for p in source.rglob('*'):
  rel=str(p.relative_to(source))
  if any(rel==r or rel.startswith(r+'/') for r in removed) or rel in changed:continue
  q=target/rel
  if p.is_symlink():assert q.is_symlink() and p.readlink()==q.readlink(),rel
  elif p.is_file():assert q.is_file() and hashlib.sha256(p.read_bytes()).digest()==hashlib.sha256(q.read_bytes()).digest(),rel;checked+=1
 manifest=json.loads((target/'plugins.json').read_text());assert len(manifest['packages'])==300
 for name,record in manifest['packages'].items():
  if record['distribution']=='installed':assert json.loads((target/record['installedPath']/'package.json').read_text())['version']==record['version']
  else:assert (target/'packages'/record['file']).is_file()
 results.append({'platform':platform,'unchangedFilesChecked':checked,'pluginEntries':300,'installed':report['installedPlugins'],'archives':report['archivePlugins']})
(root/'payload-verification.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps(results))
