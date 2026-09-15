/** Opt-in real GitLab download + official DSH install + isolated graph activation. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {PluginStore} from './plugin-store.mjs';
import {createUpdates} from './updates.mjs';
import {installArtifact} from './installer.mjs';

assert.ok(process.env.GEA_GITLAB_BASELINE,'Set GEA_GITLAB_BASELINE to an existing desktop payload');
assert.ok(process.env.GEA_GITLAB_RELEASE_MODULE,'Set GEA_GITLAB_RELEASE_MODULE to the built Hub release-channel module');
const baseline=resolve(process.env.GEA_GITLAB_BASELINE);
const releases=await import(pathToFileURL(resolve(process.env.GEA_GITLAB_RELEASE_MODULE)).href);
const sources=JSON.parse(await readFile(new URL('./release-sources.json',import.meta.url),'utf8'));
const data=await mkdtemp(join(tmpdir(),'gea-gitlab-update-'));
const store=new PluginStore({data,baseline});
await mkdir(join(data,'data/workspace'),{recursive:true});
await writeFile(join(data,'data/workspace/keep.txt'),'preserve user workspace');
const require=createRequire(join(baseline,'package.json'));
const installed=async name=>JSON.parse(await readFile(require.resolve(name+'/package.json'),'utf8')).version;
const host={dsh:await installed('@deepseek-ai/dsh'),workbench:await installed('@cleverc2200/dsh-agent-workbench'),desktop:'0.0.5'};
const downloads=[];
for(const channel of ['stable','test']) {
 const result=await releases.fetchCompanyChannel(sources[channel],channel,host);
 for(const entry of result.releases){const bytes=await releases.fetchReleasePackage(entry);downloads.push({channel,package:entry.package,version:entry.version,bytes:bytes.length,sha256:entry.sha256});console.log('DOWNLOAD_VERIFIED',channel,entry.package,entry.version);}
}
let installs=0;
const updates=await createUpdates({data,store,desktopVersion:host.desktop,releases,sources,
 install:async(directory,artifact,signal,onProcess)=>{installs++;await installArtifact({directory,artifact,signal,onProcess,node:join(baseline,'node/bin/node'),pnpm:join(baseline,'tools/node_modules/pnpm/bin/pnpm.cjs'),onProgress:line=>{if(/ERR_|ERROR/.test(line))console.log(line);}});},
 // A graph activation check; the separate runtime smoke must confirm application startup.
 restart:async id=>{await store.activate(id);await store.beginBoot();await store.confirmBoot();},
});
try {
 await updates.settings({automatic:false,intervalHours:24,channel:'stable'});
 const before=await updates.check();assert.equal(before.checkError,null);
 const targets=before.releases.filter(entry=>before.current[entry.package]!==entry.version);
 assert.equal(targets.length,1,'Use a baseline that differs by one plugin for the single-update desktop owner');
 assert.deepEqual(await updates.prepare({package:targets[0].package}),{accepted:true});
 let state,last='';const deadline=Date.now()+600000;
 do {await new Promise(r=>setTimeout(r,500));state=await updates.status();const label=state.phase+':'+JSON.stringify(state.progress);if(label!==last){console.log(label);last=label;}assert.ok(Date.now()<deadline,'UPDATE_TIMEOUT');}while(['downloading','installing'].includes(state.phase));
 assert.equal(state.phase,'pending',state.error);assert.ok(installs>0);assert.equal((await store.selected()).id,'baseline');
 await updates.restart();do{await new Promise(r=>setTimeout(r,100));state=await updates.status();}while(state.phase==='restarting');
 assert.equal(state.phase,'succeeded');
 for(const entry of state.releases)assert.equal(state.current[entry.package],entry.version);
 assert.equal(await readFile(join(data,'data/workspace/keep.txt'),'utf8'),'preserve user workspace');
 const finalCheck=await updates.check();assert.equal(finalCheck.checkError,null);
 assert.equal(finalCheck.releases.filter(entry=>finalCheck.current[entry.package]!==entry.version).length,0);
 const result={data,downloads,installs,before:before.current,after:state.current,selection:await store.selected(),runtimeStarted:false};
 await writeFile(join(data,'result.json'),JSON.stringify(result,null,2));
 console.log('GITLAB_UPDATE_PASS '+data);
} finally {await updates.close();}
