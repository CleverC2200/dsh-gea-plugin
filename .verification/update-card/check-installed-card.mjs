import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream,openSync,closeSync} from 'node:fs';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {delimiter,join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
import {parse,stringify} from 'yaml';
import {attach,initialize} from './inspector.mjs';

const platform=process.platform;
assert.ok(['darwin','win32'].includes(platform));
if(platform==='win32')assert.equal(process.env.GITHUB_ACTIONS,'true');
const data=process.env.GEA_CARD_CASE?JSON.parse(process.env.GEA_CARD_CASE):JSON.parse(await readFile(process.argv[2]));
const root=resolve(platform==='win32'?join(process.env.RUNNER_TEMP,'gea-card-proof'):process.argv[3]);
const mac=platform==='darwin';
const install=join(root,'install');
const evidence=join(root,'evidence');
await mkdir(evidence,{recursive:true,mode:0o700});
await mkdir(install,{recursive:true,mode:0o700});
const app=join(install,'Synear GEA.app');
const exe=mac?join(app,'Contents/MacOS/Synear GEA'):join(install,'GEA Desktop.exe');
const resources=mac?join(app,'Contents/Resources'):join(install,'resources');
const asar=join(resources,'app.asar');
const processEnvironment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/TOKEN|SECRET|PASSWORD|ACCESS_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|^DSH_HOME$/i.test(key)));
processEnvironment.DSH_TELEMETRY_DISABLED='1';
if(!mac){
 const key=Object.keys(processEnvironment).find(name=>name.toLowerCase()==='path');
 processEnvironment[key]=join(process.env.ProgramFiles,'Git/usr/bin')+delimiter+processEnvironment[key];
 processEnvironment.TAR_OPTIONS='--force-local --quoting-style=literal';
}
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const write=(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const command=(file,args,env=processEnvironment)=>execFileSync(file,args,{encoding:'utf8',timeout:180000,windowsHide:true,env});
const bundled=(env,args)=>command(exe,['--expose-internals',...args],{...env,ELECTRON_RUN_AS_NODE:'1'});
const repo=process.cwd();
const proof={status:'failed',platform,source:data.source,pluginVersion:data.version,desktopVersion:data.desktopVersion,cases:[]};

async function digest(path){
 const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest('hex');
}
async function download(row,path){
 if(!await stat(path).catch(()=>null)){
  const r=await fetch(row.url,{redirect:'error',signal:AbortSignal.timeout(200000)});
  assert.equal(r.status,200);
  await pipeline(Readable.fromWeb(r.body),createWriteStream(path,{flags:'wx'}));
 }
 assert.equal(await digest(path),row.sha256);
 return path;
}
async function port(){
 const server=createServer();
 await new Promise((done,reject)=>server.once('error',reject).listen(0,'127.0.0.1',done));
 const result=server.address().port;await new Promise(done=>server.close(done));return result;
}
async function until(label,evaluate,timeout=95000){
 const ending=Date.now()+timeout;
 while(Date.now()<ending){
  const result=await evaluate();if(result)return result;
  await delay(400);
 }
 throw Error('INSTALLED_CARD_TIMEOUT '+label);
}
async function prepareCase(which){
 const path=join(root,which);
 await mkdir(path,{mode:0o700});
 for(const part of ['home','os-home','temp','os','journals','store'])await mkdir(join(path,part),{mode:0o700});
 const home=join(path,'home'),profile=join(home,'profiles/desktop');
 const env={...processEnvironment,DSH_HOME:home,DSH_DESKTOP_UPDATE_JOURNAL_DIR:join(path,'journals')};
 if(mac)Object.assign(env,{HOME:join(path,'os-home'),TMPDIR:join(path,'temp')});
 const artifacts=[];
 for(const row of data.cases[which])artifacts.push({...row,file:await download(row,join(root,'archives',row.filename))});
 const input=join(path,'install-input.json');
 await write(input,{root:asar,support:join(resources,'runtime'),helperFile:join(asar,'company-bootstrap.mjs'),home,profile,store:join(path,'store'),artifacts});
 bundled(env,[join(repo,'scripts/windows-complete-local/r9/install-old.mjs'),input]);
 bundled(env,[join(import.meta.dirname,'seed-managed.mjs'),input]);
 const seed=await read(join(resources,'company-seed/manifest.json'));
 const configFile=join(profile,'cordis.patch.yml');
 const patch=parse(await readFile(configFile,'utf8'));
 let gea=patch.find(row=>row.id==='gea-proof'||row.name==='@cleverc2200/gea-dsh-prototype');
 if(!gea){gea={id:'gea-proof'};patch.push(gea);}
 gea.config={...gea.config,runtimeDir:join(profile,'gea'),pluginUpdates:{source:data.sourceConfig,core:{...seed.core,kind:'desktop',root:asar},installationProtocol:1,checkTimeoutMs:45000,pollIntervalMs:1500}};
 let locale=patch.find(row=>row.id==='locale');
 if(!locale){locale={id:'locale'};patch.push(locale);}
 locale.config={...locale.config,preference:'zh'};
 await writeFile(configFile,stringify(patch),{mode:0o600});
 return {path,home,env,artifacts};
}
async function inspectCard(page,which,artifacts){
 const account=page.getByRole('button',{name:'账户菜单',exact:true});
 const login=page.locator('.gea-account-login-backdrop');
 const closeLogin=login.getByRole('button',{name:'关闭',exact:true});
 await closeLogin.waitFor({timeout:25000}).catch(()=>{});
 if(await closeLogin.isVisible())await closeLogin.click({timeout:6000});
 await page.addLocatorHandler(login.filter({has:page.getByRole('button',{name:'关闭',exact:true})}),async()=>{await closeLogin.click({timeout:5000});});
 const expected=artifacts.filter(row=>row.name!=='@cleverc2200/dsh-personal-memory');
 const pageIdentity=randomUUID();
 const rows=async()=>page.evaluate(async identity=>{
  const r=await fetch('/api/gea/plugin-updates/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageIdentity:identity})});
  return (await r.json()).value?.items?.map(({packageName,state,installedVersion,runningHostVersion,runningClientVersion,candidateVersion,diagnostic})=>({packageName,state,installedVersion,runningHostVersion,runningClientVersion,candidateVersion,diagnostic}));
 },pageIdentity);
 await page.bringToFront();
 assert.equal(await page.evaluate(()=>window.dshDesktop.appVersion()),data.desktopVersion);
 const runtimeLoaded=observed=>expected.every(({name,version})=>observed?.some(row=>row.packageName===name&&row.installedVersion===version&&row.runningHostVersion===version&&row.runningClientVersion===version));
 await until('installed versions loaded in host and renderer',async()=>runtimeLoaded(await rows()));
 const item=page.getByRole('menuitem',{name:'检查更新',exact:true});
 async function startCheck(){
  for(let attempt=0;attempt<3;attempt++){
   if(await account.getAttribute('aria-expanded')!=='true')await account.click({timeout:6500});
   try{await item.click({timeout:6500});return;}
   catch(e){if(attempt===2||e.name!=='TimeoutError')throw e;}
  }
 }
 await startCheck();
 const card=page.getByRole('article',{name:'版本更新',exact:true});
 await card.getByRole('button',{name:'是',exact:true}).click();
 await card.getByRole('region',{name:'客户端',exact:true}).getByText(/^已是最新版 · /).waitFor({timeout:75000});
 const plugins=card.getByRole('region',{name:'公司插件',exact:true});
 const expectedStatus=which==='current'?'已是最新版本':'有可用更新';
 const desired=plugins.getByText(expectedStatus,{exact:true});
 let observed;
 const settled=async()=>{
  observed=await rows();
  if(!runtimeLoaded(observed))return false;
  return expected.every(({name})=>{
   const row=observed.find(item=>item.packageName===name);
   return row.state===(which==='available'&&name==='@cleverc2200/dsh-agent-workbench'?'available':'current');
  });
 };
 try{
  await until('checked plugin statuses',settled,12000);
 }catch{
  await startCheck();
  await card.getByRole('button',{name:'是',exact:true}).click();
  await until('checked plugin statuses after startup',settled,70000).catch(error=>{throw Error(error.message+' '+JSON.stringify(observed));});
 }
 await desired.waitFor({timeout:15000});
 const all=card.getByRole('button');
 const update=card.getByRole('button',{name:'更新全部',exact:true});
 if(which==='available')await update.click({trial:true,timeout:12000});
 await card.screenshot({path:join(evidence,'card-'+which+'.png')});
 assert.equal(await card.getByRole('button',{name:'检查更新',exact:true}).count(),0,'duplicate check button in '+which);
 assert.equal(await update.count(),which==='available'?1:0);
 assert.equal(await all.count(),which==='available'?2:1);
 assert.equal(await card.getByRole('button',{name:'关闭更新提醒',exact:true}).count(),1);
 if(which==='available'){
  const candidate=observed.find(item=>item.packageName==='@cleverc2200/dsh-agent-workbench');
  assert.equal(candidate.candidateVersion,data.cases.current.find(item=>item.name===candidate.packageName).version);
 }
 const results={state:which,selection:'账户菜单 → 检查更新',desktopVersion:data.desktopVersion,checkButtonsInCard:0,updateButtons:which==='available'?1:0,candidatePluginVersion:data.version,observed};
 await write(join(evidence,'card-'+which+'.json'),results);
 proof.cases.push(results);
}
try{
 await mkdir(join(root,'archives'),{mode:0o700});
 if(mac){
  command('codesign',['--verify','--deep','--strict',app]);
 }else{
  const installer=await download(data.windows,join(root,'signed.exe'));
  const signature=join(root,'signature.ps1');
  await writeFile(signature,'param([string]$exe)\n$ErrorActionPreference=\'Stop\'\n$env:PSModulePath=Join-Path $PSHOME \'Modules\'\n$s=Get-AuthenticodeSignature -LiteralPath $exe\nif($s.Status -ne "Valid" -or !$s.TimeStamperCertificate){throw "INSTALLER_SIGNATURE_INVALID"}\n');
  command('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',signature,installer]);
  command(installer,['/S','/D='+install]);
  command('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',signature,exe]);
 }
 assert.equal(bundled(processEnvironment,['-p','require(process.argv[1]).version',join(asar,'package.json')]).trim(),data.desktopVersion);
 for(const which of ['current','available']){
  const {path,env,artifacts}=await prepareCase(which);
  const cdp=await port(),inspect=mac?await port():null;
  const args=[`--remote-debugging-port=${cdp}`,'--remote-debugging-address=127.0.0.1',`--user-data-dir=${join(path,'os/userData')}`];
  if(mac)args.unshift(`--inspect-brk=127.0.0.1:${inspect}`);
  const logs=openSync(join(path,'native.log'),'a',0o600);
  const child=spawn(exe,args,{env,stdio:['ignore',logs,logs],windowsHide:false});
  closeSync(logs);
  let browser;
  try{
   if(mac){
    const connection=await attach(inspect,35000);
    try{assert.equal((await initialize(connection,path)).version,data.desktopVersion);}
    finally{connection.socket.close();}
   }
   browser=await until('signed renderer connected',()=>chromium.connectOverCDP('http://127.0.0.1:'+cdp,{timeout:1400}).catch(()=>null));
   const main=await until('workspace launched',async()=>{
    const pages=browser.contexts()[0]?.pages()??[];
    for(const view of pages.filter(p=>/welcome/.test(p.url())))await view.locator('#company-login').click({timeout:500}).catch(()=>{});
    return pages.find(view=>view.url().startsWith('dsh-app://app/'));
   });
   await main.waitForFunction(()=>Boolean(window.dshDesktop?.appVersion),undefined,{timeout:15000});
   await inspectCard(main,which,artifacts);
  }finally{
   if(browser)await browser.close();
   if(child.exitCode===null&&child.signalCode===null){
    if(mac){
     const c=await attach(inspect,2500).catch(()=>null);
     if(c)try{
      const current=await c.evaluate('({pid:process.pid,exe:process.execPath})');
      assert.deepEqual(current,{pid:child.pid,exe});
      await c.evaluate('setTimeout(() => __q.electron.app.quit(), 80); true');
     }finally{c.socket.close();}
     else child.kill('SIGTERM');
    }else child.kill();
   }
   await until('isolated process exit',()=>child.exitCode!==null||child.signalCode!==null,20000);
  }
 }
 proof.status='passed';
}catch(error){
 proof.failure=String(error.message).split('\n')[0].replaceAll(root,'<ISOLATED_ROOT>');
 throw error;
}finally{
 await write(join(evidence,'receipt.json'),proof);
}
console.log(JSON.stringify(proof));
