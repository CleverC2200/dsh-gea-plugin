import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,openSync,closeSync} from 'node:fs';
import {mkdir,readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {createServer as netServer} from 'node:net';
import {createServer as httpServer} from 'node:http';
import {homedir} from 'node:os';
import {join,resolve,basename,dirname} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parse,stringify} from 'yaml';
import {chromium} from '@playwright/test';
import {attach} from './inspector.mjs';
import {prepareDesktopRelease} from '../../scripts/desktop-release.mjs';
assert.equal(process.platform,'darwin');
assert.equal(process.arch,'arm64');
assert.equal(process.env.GITHUB_ACTIONS,'true');
const caseData=JSON.parse(process.env.GEA_MAC_CASE);
const root=resolve(process.env.RUNNER_TEMP,'gea-native-proof');
const out=resolve(process.env.RUNNER_TEMP,'gea-native-evidence');
const home=join(homedir(),'.dsh');
const journal=join(root,'journals');
const entry=caseData.entries[0];
assert.ok(['card','settings'].includes(entry));
assert.ok(!(await stat(home).catch(()=>null)),'TEST_REQUIRES_UNUSED_RUNNER_PROFILE');
await mkdir(root);await mkdir(out);await mkdir(home);await mkdir(journal);
const mount=join(root,'mount'),app=join(root,'Synear GEA.app'),old=join(root,'baseline.dmg');
const res=join(app,'Contents/Resources'),appRoot=join(res,'app.asar'),exe=join(app,'Contents/MacOS/Synear GEA');
const profile=join(home,'profiles/desktop');
const pluginUpdates=join(profile,'gea','plugin-updates'),source=join(profile,'cordis.patch.yml');
const snapshot=join(root,'before.json');
const filesDir=resolve(process.argv[2]);
const dataTool=resolve('scripts/desktop-update-data.mjs');
const proof={status:'failed',entry,version:caseData.version,source:caseData.source};
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/TOKEN|SECRET|PASSWORD|ACCESS_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|^DSH_HOME$/i.test(key)));
Object.assign(env,{DSH_DESKTOP_UPDATE_JOURNAL_DIR:journal,DSH_TELEMETRY_DISABLED:'1'});
const op=(command,args,options={})=>execFileSync(command,args,{env,encoding:'utf8',timeout:180000,...options});
const bundled=(...args)=>op(exe,['--expose-internals',...args],{env:{...env,ELECTRON_RUN_AS_NODE:'1'}});
async function until(label,read,timeout=180000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await read();if(value)return value;await delay(400);}
  throw Error('MAC_REAL_UPDATE_TIMEOUT '+label);
}
async function download(url,sha256,file){
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(180000)});
  assert.equal(r.status,200);await pipeline(Readable.fromWeb(r.body),createWriteStream(file,{flags:'wx'}));
  const hash=createHash('sha256');for await(const part of createReadStream(file))hash.update(part);
  assert.equal(hash.digest('hex'),sha256);return file;
}
async function freePort(){
  const socket=netServer();
  await new Promise((done,reject)=>socket.once('error',reject).listen(0,'127.0.0.1',done));
  const port=socket.address().port;
  await new Promise(done=>socket.close(done));return port;
}
const files=new Map();
const responses=new Set();
const server=httpServer(async(req,res)=>{
  try{
    const key=new URL(req.url,'http://localhost').pathname,path=files.get(key);
    if(!path)return res.writeHead(404).end();
    const {size}=await stat(path),range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range??'');
    if(req.headers.range&&!range)return res.writeHead(416).end();
    const start=range?Number(range[1]):0,end=range?.[2]?Math.min(size-1,Number(range[2])):size-1;
    if(start>end)return res.writeHead(416).end();
    responses.add(key);res.writeHead(range?206:200,{'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(range?{'Content-Range':'bytes '+start+'-'+end+'/'+size}:{})});
    if(req.method==='HEAD')res.end();else await pipeline(createReadStream(path,{start,end}),res);
  }catch{res.destroy();}
});
let phase='preparation';
let initial;
try{
  const plan=await prepareDesktopRelease(filesDir,caseData.source,join(filesDir,'result.json'));
  assert.equal(plan.version,caseData.version);assert.equal(plan.platform,'mac-arm64');
  for(const file of plan.files)files.set('/candidate/'+file.name,file.path);
  await new Promise((done,reject)=>server.once('error',reject).listen(0,'127.0.0.1',done));
  const url='http://127.0.0.1:'+server.address().port+'/candidate/';
  await download(caseData.baseline.url,caseData.baseline.sha256,old);
  await mkdir(mount);
  op('hdiutil',['attach','-nobrowse','-readonly','-mountpoint',mount,old]);
  try{op('ditto',[join(mount,'Synear GEA.app'),app]);}
  finally{op('hdiutil',['detach',mount]);}
  op('codesign',['--verify','--deep','--strict',app]);
  assert.equal(bundled('-p','require(process.argv[1]).version',join(appRoot,'package.json')).trim(),caseData.baseline.version);
  const seed=JSON.parse(await readFile(join(res,'company-seed/manifest.json')));
  const rows=[];
  for(const row of caseData.packages)rows.push({...row,file:await download(row.url,row.sha256,join(root,row.filename))});
  const seedInput=join(root,'install.json');
  await writeFile(seedInput,JSON.stringify({root:appRoot,support:join(res,'runtime'),helperFile:join(appRoot,'company-bootstrap.mjs'),home,profile,store:join(root,'store'),artifacts:rows}));
  bundled('scripts/windows-complete-local/r9/install-old.mjs',seedInput);
  bundled(join(import.meta.dirname,'seed-managed.mjs'),seedInput);
  const patch=parse(await readFile(source,'utf8'));
  let gea=patch.find(row=>row.id==='gea-proof'||row.name==='@cleverc2200/gea-dsh-prototype');
  if(!gea){gea={id:'gea-proof'};patch.push(gea);}
  gea.config={...gea.config,runtimeDir:join(profile,'gea'),pluginUpdates:{source:{...seed.source,channelUrl:caseData.channel},core:{...seed.core,root:appRoot,kind:'desktop'},installationProtocol:1,checkTimeoutMs:60000,pollIntervalMs:1700}};
  let locale=patch.find(row=>row.id==='locale');
  if(!locale){locale={id:'locale'};patch.push(locale);}
  locale.config={...locale.config,preference:'zh'};
  await writeFile(source,stringify(patch));
  const history=join(root,'history.json');
  await writeFile(history,JSON.stringify({root:appRoot,home,cwd:root,sessionId:'gea-update-all-'+entry,mode:'create'}));
  bundled('scripts/windows-complete-local/r9/seed-history.mjs',history);
  const before=JSON.parse(bundled(dataTool,'--home',home,'--capture',snapshot));
  assert.ok(before.events>=3);
  const log=openSync(join(root,'native.log'),'a',0o600),inspector=await freePort(),cdp=await freePort();
  phase='baseline start';
  initial=spawn(exe,[`--inspect-brk=127.0.0.1:${inspector}`,`--remote-debugging-port=${cdp}`,'--remote-debugging-address=127.0.0.1'],{env,stdio:['ignore',log,log]});
  closeSync(log);
  const client=await attach(inspector,35000);
  try{
    await client.call('Debugger.enable');
    await client.call('Runtime.runIfWaitingForDebugger');
    const paused=await until('main start',()=>client.events.find(e=>e.method==='Debugger.paused'),10000);
    const expression=`(()=>{require('electron-updater').autoUpdater.setFeedURL({provider:'generic',url:${JSON.stringify(url)},channel:'nightly',useMultipleRangeRequest:false});return require('electron').app.getVersion()})()`;
    const result=await client.call('Debugger.evaluateOnCallFrame',{callFrameId:paused.params.callFrames[0].callFrameId,expression,returnByValue:true});
    assert.equal(result.result.value,caseData.baseline.version,result.exceptionDetails?.text);
    await client.call('Debugger.resume');
  }finally{client.socket.close();}
  const browser=await until('renderer debugging',()=>chromium.connectOverCDP('http://127.0.0.1:'+cdp,{timeout:1500}).catch(()=>null));
  const page=await until('workspace',async()=>{
    const pages=browser.contexts()[0]?.pages()??[];
    for(const view of pages.filter(p=>/welcome/.test(p.url())))await view.locator('#company-login').click({timeout:500}).catch(()=>{});
    return pages.find(p=>p.url().startsWith('dsh-app://app/'));
  });
  await page.waitForFunction(()=>window.dshDesktop?.updates?.status,undefined,{timeout:25000});
  await writeFile(join(out,'process.json'),JSON.stringify({cdp}));
  phase='read candidates and click';
  const result=op(process.execPath,[join(import.meta.dirname,'exercise-installed-entry.mjs'),out,entry,caseData.version],{env:{...env},timeout:150000});
  assert.equal(result.trim(),'');
  const selected=JSON.parse(await readFile(join(out,'before-'+entry+'.json')));
  assert.ok(selected.expectedPlugins.length>=2);
  assert.equal(JSON.parse(await readFile(join(out,'clicked-'+entry+'.json'))).clicks,1);
  phase='native successor';
  let successorPid;
  await until('new native GUI process',async()=>{
    const installed=op('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',join(app,'Contents/Info.plist')]).trim();
    if(installed!==caseData.version)return false;
    const lines=op('ps',['-axo','pid=,comm=']).split('\n').map(line=>line.trim()).filter(line=>line.endsWith(' '+exe));
    for(const line of lines){
      const pid=Number(line.split(' ')[0]);
      if(pid===initial.pid)continue;
      const windows=op('osascript',['-l','JavaScript','-e',`ObjC.import('CoreGraphics'); const windows=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(17,0)); windows.filter(window=>window.kCGWindowOwnerPID===${pid}&&window.kCGWindowLayer===0).length`],{timeout:10000}).trim();
      if(Number(windows)>0){successorPid=pid;return true;}
    }
    return false;
  },360000);
  assert.ok(responses.has('/candidate/'+plan.files.find(row=>row.name.endsWith('.zip')).name));
  assert.equal(bundled('-p','require(process.argv[1]).version',join(appRoot,'package.json')).trim(),caseData.version);
  op('codesign',['--verify','--deep','--strict',app]);
  phase='plugin confirmation';
  await until('all plugin versions confirmed',async()=>{
    const pointer=await readFile(join(pluginUpdates,'latest.json'),'utf8').then(JSON.parse).catch(()=>null);
    if(!pointer)return false;
    const data=await readFile(join(pluginUpdates,'operations',pointer.id,'receipt.json'),'utf8').then(JSON.parse).catch(()=>null);
    if(data?.stage!=='completed')return false;
    const targets=data.targets??[data];
    assert.equal(targets.length,selected.expectedPlugins.length);
    for(const row of selected.expectedPlugins){
      assert.equal(targets.find(item=>item.packageName===row.packageName)?.targetVersion,row.candidateVersion);
      const current=JSON.parse(await readFile(join(profile,'node_modules',row.packageName,'package.json')));
      assert.equal(current.version,row.candidateVersion);
    }
    return true;
  });
  phase='preserved data';
  const data=join(out,'data-'+entry+'.json');
  bundled(dataTool,'--home',home,'--before',snapshot,'--output',data);
  assert.equal(JSON.parse(await readFile(data)).status,'passed');
  Object.assign(proof,{status:'passed',updateClicks:1,nativeSuccessor:true,successorPid,plugins:selected.expectedPlugins,signedAppVerified:true,dataRetained:true,accountResumed:false});
}catch(error){
  proof.failure=phase+': '+error.message.split('\n')[0].replaceAll(root,'<OWNED_ROOT>').replaceAll(home,'<OWNED_HOME>');
  throw error;
}finally{
  await writeFile(join(out,'receipt.json'),JSON.stringify(proof,null,2));
  server.closeAllConnections();server.close();
  if(initial&&initial.exitCode===null)initial.kill('SIGTERM');
}
