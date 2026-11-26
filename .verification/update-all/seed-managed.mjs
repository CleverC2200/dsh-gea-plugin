import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const input=JSON.parse(await readFile(process.argv[2]));
const seed=join(dirname(input.root),'company-seed');
const manifest=JSON.parse(await readFile(join(seed,'manifest.json')));
const {CompanyInstallation}=await import(pathToFileURL(join(input.root,'company-installation.mjs')));
const installation=new CompanyInstallation(input.profile,manifest.core.head);
await installation.initialize();
const baseline=await installation.beginBoot();
assert.equal(baseline.id,'baseline');
for(const row of input.artifacts){
  const actual=JSON.parse(await readFile(join(input.profile,'node_modules',row.name,'package.json')));
  assert.equal(actual.version,row.version);
}
