import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {createReadStream,createWriteStream,openSync,closeSync} from "node:fs";
import {readFile,writeFile,mkdir,readdir,stat} from "node:fs/promises";
import {execFile,spawn} from "node:child_process";
import {createServer} from "node:http";
import {createServer as createSocket} from "node:net";
import {homedir} from "node:os";
import {basename,dirname,join,resolve} from "node:path";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {setTimeout as delay} from "node:timers/promises";
import {promisify} from "node:util";
import {parse} from "yaml";
import {chromium} from "playwright";
import {readDraft} from "./verify-draft.mjs";

const run=promisify(execFile);
const [artifacts,root]=process.argv.slice(2).map(x=>resolve(x));
const receipt=JSON.parse(await readFile(join(artifacts,"result.json"),"utf8"));
const head="b2c1f5faf5198e9390491773c78be8dd8302e426";
const old="0.2.0-rc.2.20261116.1";
const newer="0.2.0-rc.2.20261118.1";
const core="8cc49e9b5c5ddf3751af2f6fb21276513a14bf9b";
assert.equal(receipt.geaSha,head);
assert.equal(receipt.desktopVersion,newer);
assert.match(receipt.signing,/notarized and stapled/);
assert.equal(process.platform,"darwin");
assert.equal(process.arch,"arm64");
const company = new Set(["@cleverc2200/dsh-agent-workbench", "dsh-agent-manage", "@cleverc2200/gea-dsh-prototype"]);
const expected = JSON.parse(await readFile(join(import.meta.dirname,"desktop-input.json"),"utf8")).seed.packages.filter(row => company.has(row.name));
assert.equal(expected.length, 3);
await mkdir(root);
const privateDir=join(root,"private"),publicDir=join(root,"public");
await mkdir(privateDir,{mode:0o700});
await mkdir(publicDir);
const home=join(homedir(),".dsh");
assert.equal(await stat(home).then(()=>true).catch(e=>{if(e.code!=="ENOENT")throw e;return false}),false,"FRESH_ISOLATED_RUNNER_REQUIRED");
const profile=join(home,"profiles/desktop");
const userData=join(homedir(),"Library","Application Support","GEA Desktop");
const app=join(privateDir,"Synear GEA.app");
const executable=join(app,"Contents/MacOS/Synear GEA");
const asar=join(app,"Contents/Resources/app.asar");
const baseline=join(privateDir,"baseline.dmg");
const journal=join(privateDir,"journal");
const results={status:"running",fromVersion:old,toVersion:newer,sourceSha:head,milestones:[]};
const step=(name)=>{results.milestones.push({name,at:new Date().toISOString()});console.log(name);};
async function digest(path,alg="sha256",encoding="hex"){
 const hash=createHash(alg);
 for await(const chunk of createReadStream(path))hash.update(chunk);
 return hash.digest(encoding);
}
async function wait(name,fn,ms=180000){
 const end=Date.now()+ms;
 while(Date.now()<end){
  const result=await fn();
  if(result) return result;
  await delay(400);
 }
 throw Error("WAIT: "+name);
}
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(TOKEN|SECRET|KEY|PASSWORD|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)/i.test(key)));
env.DSH_DESKTOP_UPDATE_JOURNAL_DIR=journal;
env.DSH_TELEMETRY_DISABLED="1";
async function bundled(script,args){
 const result=await run(executable,["--expose-internals",script,...args],{env:{...env,ELECTRON_RUN_AS_NODE:"1"},timeout:45000});
 return JSON.parse(result.stdout.trim());
}
async function version(){
 return bundled("-p",["JSON.stringify(require(process.argv[1]).version)",join(asar,"package.json")]);
}
async function records(){
 const rows=[];
 for(const name of await readdir(journal).catch(()=>[])){
  for(const line of (await readFile(join(journal,name),"utf8")).split("\n").filter(Boolean)){
   try {rows.push(JSON.parse(line));} catch {}
  }
 }
 return rows;
}
const sessionId="session-6e10a0f1-c9de-4174-ae9c-b088f52fe009";
const draftKey="dsh.conversation."+sessionId;
const draftText="Managed upgrade saved composer draft 6e10a0f1";
const rows = parse(await readFile(join(artifacts,"nightly-mac.yml"),"utf8"));
assert.equal(rows.version,newer);
results.feedSha256=await digest(join(artifacts,"nightly-mac.yml"));
const files=new Map([["/nightly-mac.yml",join(artifacts,"nightly-mac.yml")]]);
for(const row of rows.files){
 const path=join(artifacts,basename(row.url));
 assert.equal(row.url,basename(row.url));
 assert.equal((await stat(path)).size,row.size);
 assert.equal(await digest(path,"sha512","base64"),row.sha512);
 files.set("/"+row.url,path);
 if(row.url.endsWith(".zip"))files.set("/"+row.url+".blockmap",path+".blockmap");
}
assert.equal(await digest(join(artifacts,receipt.artifact)),receipt.sha256);
results.installerSha256=receipt.sha256;
const served=[];
const fake=createServer(async(request,response)=>{
 try {
  const name=new URL(request.url,"http://127.0.0.1").pathname;
  const path=files.get(name);
  if(!path){response.writeHead(404).end();return;}
  const {size}=await stat(path);
  const range=/^bytes=(\d+)-(\d+)$/.exec(request.headers.range??"");
  if(request.headers.range&&!range){response.writeHead(416).end();return;}
  const start=range?Number(range[1]):0;
  const end=range?Math.min(Number(range[2]),size-1):size-1;
  response.writeHead(range?206:200,{"Content-Length":end-start+1,"Accept-Ranges":"bytes",...(range?{"Content-Range":`bytes ${start}-${end}/${size}`}:{})});
  served.push({name,method:request.method});
  if(request.method==="HEAD")response.end();
  else await pipeline(createReadStream(path,{start,end}),response);
 }catch{response.destroy();}
});
let child,browser;
try {
 const baselineUrl="https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/a0d77eb2a84f7284c56fd8e6ef23635bba894cac/desktop/Synear-GEA-0.2.0-rc.2.20261116.1-mac-arm64-signed.dmg";
 const response=await fetch(baselineUrl,{redirect:"error",signal:AbortSignal.timeout(180000)});
 assert.equal(response.status,200);
 await pipeline(Readable.fromWeb(response.body),createWriteStream(baseline,{flags:"wx"}));
 assert.equal(await digest(baseline),"3f183e42ee6dc0e5df70de84163669ee42b7ed317be1db1ed52b074a264028d4");
 const mount=join(privateDir,"mount");
 await mkdir(mount);
 await run("hdiutil",["attach",baseline,"-readonly","-nobrowse","-mountpoint",mount],{timeout:90000});
 try{await run("ditto",[join(mount,"Synear GEA.app"),app],{timeout:90000});}
 finally{await run("hdiutil",["detach",mount],{timeout:45000});}
 await run("codesign",["--verify","--deep","--strict",app],{timeout:90000});
 assert.equal(await version(),old);
 const asarBefore=await digest(asar),exeBefore=await digest(executable);
 await new Promise((ok,fail)=>{fake.once("error",fail);fake.listen(0,"127.0.0.1",ok);});
 const config=join(dirname(asar),"app-update.yml");
 const oldConfig=await readFile(config,"utf8");
 const production="https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/mac-arm64/";
 const candidate=oldConfig.replace(production,"http://127.0.0.1:"+fake.address().port+"/");
 assert.notEqual(candidate,oldConfig);
 await writeFile(config,candidate);
 assert.equal(await digest(asar),asarBefore);
 assert.equal(await digest(executable),exeBefore);
 results.baselineCodeUntouched=true;
 results.isolatedFeedConfigOnly=true;
 step("signed-baseline-and-candidate-bytes-verified");
 const clientPort=await new Promise((ok,fail)=>{
  const socket=createSocket();
  socket.once("error",fail);
  socket.listen(0,"127.0.0.1",()=>{const port=socket.address().port;socket.close(()=>ok(port));});
 });
 const fd=openSync(join(privateDir,"native.log"),"ax");
 child=spawn(executable,["--remote-debugging-port="+clientPort,"--remote-debugging-address=127.0.0.1"],{env,stdio:["ignore",fd,fd]});
 closeSync(fd);
 let exited=false;
 child.once("exit",()=>{exited=true;});
 browser=await wait("old native renderer",()=>chromium.connectOverCDP("http://127.0.0.1:"+clientPort,{timeout:1500}).catch(()=>null));
 const context=browser.contexts()[0];
 const first=await wait("old window",()=>context.pages().find(p=>/welcome|^dsh-app:\/\/app/.test(p.url())));
 if(!first.url().startsWith("dsh-app://app/"))await first.locator("#company-login").click({timeout:60000});
 const main=await wait("old workspace",()=>context.pages().find(p=>p.url().startsWith("dsh-app://app/")));
 await main.waitForFunction(()=>Boolean(window.dshDesktop?.updates?.open),{timeout:90000});
 const history=join(privateDir,"history.json"),snapshot=join(privateDir,"before.json");
 await writeFile(history,JSON.stringify({root:asar,home,cwd:privateDir,sessionId,mode:"create"}));
 assert.equal((await bundled(fileURLToPath(new URL("../windows-complete-local/r9/seed-history.mjs",import.meta.url)),[history])).status,"history-created-and-read-back");
 assert.equal(await main.evaluate(({draftKey,draftText})=>{
  localStorage.setItem(draftKey,JSON.stringify({draft:draftText,view:null,viewRequest:null}));
  return JSON.parse(localStorage.getItem(draftKey)).draft;
 },{draftKey,draftText}),draftText);
 const data=fileURLToPath(new URL("../desktop-update-data.mjs",import.meta.url));
 assert.ok((await bundled(data,["--home",home,"--capture",snapshot])).events>0);
 step("old-sessions-and-composer-draft-captured");
 await main.evaluate(()=>{void window.dshDesktop.updates.open();});
 const dialog=await wait("check/download dialog",()=>context.pages().find(p=>p.url().includes("update-dialog.html")));
 const action=dialog.locator("#actions button").first();
 let downloadInvoked = false, lastView;
 await wait("download or install action",async()=>{
  const view = await dialog.evaluate(() => window.dshUpdateDialog.status()).catch(() => null);
  const label = view?.buttons?.[0] ?? "";
  const events = await records();
  const state = events.filter(row=>row.event==="state").at(-1);
  const diagnostic = JSON.stringify({ label, phase:state?.phase ?? null, targetVersion:state?.targetVersion ?? null, error:state?.error ?? null, requests:served.length });
  if (diagnostic !== lastView) {
   lastView = diagnostic;
   console.log("Update dialog: "+diagnostic);
  }
  if (state?.phase === "error") throw Error("NATIVE_UPDATE_ERROR: " + diagnostic);
  if (/download|下载/i.test(label)) {
   if (!downloadInvoked) {
    await action.click({timeout:8000});
    downloadInvoked = true;
   }
   return false;
  }
  return /restart|重启|重新启动/i.test(label) && events.some(row=>row.phase==="ready"&&row.targetVersion===newer);
 },300000);
 assert.ok(served.some(row=>row.name===rows.path||row.name==="/"+rows.path));
 step("native-update-journal-and-signed-download-ready");
 await action.click({timeout:8000}).catch(error=>{if(!String(error).includes("closed"))throw error;});
 await wait("old process graceful exit",()=>exited,90000);
 const newPid=await wait("native updated executable",async()=>{
  const result=await run("pgrep",["-f",executable.replace(/[.]/g,"\\.")]).catch(()=>null);
  const ids=(result?.stdout??"").trim().split(/\s+/).map(Number).filter(x=>x>0&&x!==child.pid);
  if(!ids.length)return false;
  return await version().catch(()=>null)===newer?ids[0]:false;
 });
 results.relaunch={method:"native-updater",oldExited:true,newPid,manualSuccessorLaunch:false};
 await run("codesign",["--verify","--deep","--strict",app],{timeout:90000});
 step("new-signed-app-relaunched");
 const readJson=async path=>JSON.parse(await readFile(path,"utf8"));
 const observed=await wait("actual managed Host and renderer stamps confirmed",async()=>{
  try {
   const mounted=await readJson(join(profile,"gea/installation.json"));
   const selected=await readJson(join(profile,"gea/installations",core,"plugins/selection.json"));
   if(mounted.coreHead!==core||selected.active!==mounted.graphId||selected.verified!==mounted.graphId||selected.booting||mounted.graphId==="baseline")return false;
   return await Promise.all(expected.map(async row=>{
    const actual=await readJson(join(profile,"node_modules",row.name,"package.json"));
    assert.equal(actual.version,row.version);
    return {name:row.name,version:row.version,hostAndClientVerified:true};
   }));
  }catch(e){if(e.code==="ENOENT")return false;throw e;}
 },150000);
 results.runtimePackages=observed;
 results.data=await bundled(data,["--home",home,"--before",snapshot,"--output",join(privateDir,"data-receipt.json")]);
 assert.equal(results.data.status,"passed");
 results.composerDraftPreserved=await wait("old logical draft through Chromium local storage",()=>readDraft(userData,draftKey,draftText,join(privateDir,"draft-check")),20000);
 step("all-company-runtime-versions-and-original-data-read-back");
 results.status="passed";
}catch(error){
 results.status="failed";
 results.failure=String(error.message).split("\n")[0].replaceAll(privateDir,"<PRIVATE>");
 results.network=served;
 results.updateStates=(await records()).filter(row=>row.event==="state").map(({phase,targetVersion,reason})=>({phase,targetVersion,reason}));
 const log=await readFile(join(privateDir,"native.log"),"utf8").catch(()=>"");
 results.platformDiagnostics=log.split("\n").filter(line=>/code signature|sha512|Squirrel|update check|expected version|status code|failed operation|invalid ZIP|blockmap/i.test(line) && !/[?&](token|sig)=|authorization|credential/i.test(line)).slice(-14).map(line=>line.replaceAll(privateDir,"<PRIVATE>").slice(0,500));
 console.log(JSON.stringify({failure:results.failure,network:results.network,updateStates:results.updateStates,platformDiagnostics:results.platformDiagnostics}));
 throw Error(results.failure);
}finally{
 fake.close();
 await browser?.close().catch(()=>{});
 await writeFile(join(publicDir,"receipt.json"),JSON.stringify(results,null,2));
}
