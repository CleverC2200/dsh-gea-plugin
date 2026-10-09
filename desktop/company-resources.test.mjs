import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {companySources,provisionCompanyResources} from './company-resources.mjs';
test('a new desktop has the company catalog offline and an internal GitLab refresh URL',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-suites-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const payload=join(root,'payload'),home=join(root,'home');
 const bundled=join(payload,'resources/company-agent-suites');await mkdir(bundled,{recursive:true});await writeFile(join(bundled,'README.md'),'bundled');
 await provisionCompanyResources(payload,home);
 const copy=join(home,'agent-plugins/.sources/company-agent-suites/README.md');assert.equal(await readFile(copy,'utf8'),'bundled');
 assert.deepEqual(companySources,[{id:'company-agent-suites',kind:'git',url:'http://100.100.6.191:20656/chenyonghao/company-agent-suites.git',branch:'main'}]);
 await writeFile(copy,'refreshed');await provisionCompanyResources(payload,home);assert.equal(await readFile(copy,'utf8'),'refreshed');
});
test('upgrading the earlier company Git source keeps installs and custom sources while moving to GitLab',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-suites-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const payload=join(root,'payload'),home=join(root,'home'),bundled=join(payload,'resources/company-agent-suites');
 await mkdir(bundled,{recursive:true});await writeFile(join(bundled,'README.md'),'bundled');await mkdir(join(home,'agent-plugins'),{recursive:true});
 const state={version:1,sources:[{id:'company-agent-suites',url:'https://github.com/CleverC2200/company-agent-suites.git',kind:'git',branch:'main'},{id:'custom',url:'/owned/local',kind:'local'}],installed:{'company-agent-suites/business-analysis-starter':{enabled:true,installedAt:'2026-09-14T00:00:00Z'}}};
 const path=join(home,'agent-plugins/state.json');await writeFile(path,JSON.stringify(state));await provisionCompanyResources(payload,home);
 const after=JSON.parse(await readFile(path,'utf8'));assert.equal(after.sources[0].kind,'git');assert.equal(after.sources[0].url,companySources[0].url);assert.deepEqual(after.sources[1],state.sources[1]);assert.deepEqual(after.installed,state.installed);
});
test('adopted checkouts and a deliberately selected branch remain user-owned',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-suites-custom-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home');await mkdir(join(home,'agent-plugins/.sources/company-agent-suites'),{recursive:true});
 for(const ownership of [{adopted:true},{branch:'pilot'},{local:true},{kind:'local'}]){
  const state={version:1,sources:[{id:'company-agent-suites',url:'https://github.com/CleverC2200/company-agent-suites.git',kind:'git',...ownership}],installed:{}};
  const path=join(home,'agent-plugins/state.json'),bytes=JSON.stringify(state);await writeFile(path,bytes);await provisionCompanyResources(join(root,'unused'),home);assert.equal(await readFile(path,'utf8'),bytes);
 }
});

test('legacy GitHub archives migrate once and preserve installed suites',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-suites-archive-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const home=join(root,'home');await mkdir(join(home,'agent-plugins/.sources/company-agent-suites'),{recursive:true});
 const path=join(home,'agent-plugins/state.json');
 const installed={'company-agent-suites/sinian-base-safety-stock':{enabled:true,installedAt:'2026-09-21'}};
 await writeFile(path,JSON.stringify({version:1,sources:[{id:'company-agent-suites',kind:'archive',url:'https://api.github.com/repos/CleverC2200/company-agent-suites/zipball/main',sha256:'old-archive-hash'}],installed}));
 await provisionCompanyResources(join(root,'unused'),home);
 const first=await readFile(path,'utf8');const state=JSON.parse(first);
 assert.deepEqual(state.sources,companySources);assert.deepEqual(state.installed,installed);
 await provisionCompanyResources(join(root,'unused'),home);assert.equal(await readFile(path,'utf8'),first);
});
