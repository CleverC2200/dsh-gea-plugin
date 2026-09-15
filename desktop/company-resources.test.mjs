import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {companySources,provisionCompanyResources} from './company-resources.mjs';
test('a new desktop has the company catalog offline and a refresh URL without Git or credentials',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-suites-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const payload=join(root,'payload'),home=join(root,'home');
 const bundled=join(payload,'resources/company-agent-suites');await mkdir(bundled,{recursive:true});await writeFile(join(bundled,'README.md'),'bundled');
 await provisionCompanyResources(payload,home);
 const copy=join(home,'agent-plugins/.sources/company-agent-suites/README.md');assert.equal(await readFile(copy,'utf8'),'bundled');
 assert.deepEqual(companySources,[{id:'company-agent-suites',kind:'archive',url:'https://api.github.com/repos/CleverC2200/company-agent-suites/zipball/main'}]);
 await writeFile(copy,'refreshed');await provisionCompanyResources(payload,home);assert.equal(await readFile(copy,'utf8'),'refreshed');
});
