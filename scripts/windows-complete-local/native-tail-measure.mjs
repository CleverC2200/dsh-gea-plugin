import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs } from 'node:util';
import { assertPrivate, privateJson, readPrivate } from './native-tail-measure/privacy.mjs';
import { verifyServiceListener } from './native-tail-measure/native-profile-port.mjs';
import { verifyServiceListener as verifyExplicitImports, lastTimings } from './native-tail-measure/native-profile-port.timed-candidate.mjs';
const execute = promisify(execFile), file = fileURLToPath(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let diagnosticPhase = 'initializing';
const sourceBindings = {"privacy.mjs": "d809e5c740c58369f913b7d8a23a5909fb18de31d13fa68e1d40011dc8d3034e", "native-profile-port.mjs": "f64f85b0cf7c52b3258b7434d43580600a2c556f9e072f238ad157cf52127cca", "native-profile-port.imports-candidate.mjs": "749c5637b527b7319bafdee73a1551d4534d78188bcec97fa03fd80167a92376", "native-profile-port.timed-candidate.mjs": "0aaaa5c7008cc98690c0af83f51fa0c0c6d99b7ee6ffd3d8d203118dfde99065"};
async function secureDirectory(path) {
  diagnosticPhase = 'secure-owner-create';
  await mkdir(path, { recursive: false, mode: 0o700 });
  if (process.platform !== 'win32') { await assertPrivate(path); return; }
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  diagnosticPhase = 'secure-owner-identity';
  const me = (await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true })).stdout.trim();
  assert(/^S-1-(?:\d+-)+\d+$/.test(me), 'WINDOWS_OWNER_SID_REQUIRED');
  diagnosticPhase = 'secure-owner-acl-apply';
  const command = "$ErrorActionPreference='Stop'; $me=[Security.Principal.SecurityIdentifier]::new($env:R9_OWNER_SID); $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18'); $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false); $acl.SetOwner($me); foreach($identity in @($me,$system)){ $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)) }; [IO.Directory]::SetAccessControl($env:R9_PRIVATE_PATH, $acl)";
  await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, R9_PRIVATE_PATH: path, R9_OWNER_SID: me }, windowsHide: true });
  diagnosticPhase = 'secure-owner-verify';
  await assertPrivate(path);
}

const baseEnvironment = state => {
    const selected = Object.fromEntries(['SystemRoot', 'ComSpec', 'PATHEXT', 'PATH', 'ProgramFiles', 'ProgramFiles(x86)', 'WINDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    return { ...selected, HOME: state.osHome, ZDOTDIR: state.osHome, CFFIXED_USER_HOME: state.osHome, USERPROFILE: state.osHome, APPDATA: state.appData, LOCALAPPDATA: state.appData, TEMP: state.temp, TMP: state.temp, TMPDIR: state.temp + '/', DSH_HOME: state.home, DSH_AGENTS_HOME: join(state.home, 'agents'), DSH_TELEMETRY_DISABLED: '1', npm_config_userconfig: join(state.runRoot, 'empty.npmrc'), npm_config_globalconfig: join(state.runRoot, 'empty.npmrc'), npm_config_registry: 'https://registry.npmjs.org' };
  };
async function ownedNode(environment, listener) {
  const code = listener
    ? "const s=require('node:http').createServer((q,r)=>r.end('owned'));s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port}));process.on('message',m=>{if(m==='close')s.close(()=>process.disconnect())})"
    : "process.on('message',m=>{if(m==='close')process.disconnect()});process.send({ready:true})";
  const child = spawn(process.execPath, ['-e', code], { env: environment, stdio: ['ignore','ignore','ignore','ipc'], windowsHide: true });
  const exit = new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))});
  const ready = await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('OWNED_NODE_START_FAILED')))});
  return { child, exit, ready };
}
async function closeNode(node) {
  if (!node) return;
  if (node.child.connected) node.child.send('close');
  const result = await node.exit;
  assert(result.code === 0 && result.signal === null, 'OWNED_NODE_NORMAL_EXIT_REQUIRED');
}
async function measure(environment, root, report, save) {
  let listener, foreign;
  const records = report[environment] = [];
  const timed = async (label, round, fn) => {
    const record = {label,round,ms:0,passed:false,finished:false}; records.push(record); await save();
    const started = performance.now();
    try { await fn(); record.passed = true; }
    finally { record.ms = Math.round(performance.now()-started); record.finished = true; if(label==='listener-owned-explicit-imports'||label==='listener-foreign-explicit-imports-rejected')record.timings=lastTimings; await save(); }
  };
  try {
    listener = await ownedNode(process.env, true);
    foreign = await ownedNode(process.env, false);
    assert(Number.isSafeInteger(listener.ready.port) && listener.ready.port > 1024 && listener.ready.port !== 19387, 'OWNED_LISTENER_PORT_REQUIRED');
    const origin = `http://127.0.0.1:${listener.ready.port}`;
    for (let round=1;round<=2;round++) {
      await timed('phase-four-private-json',round,async()=>{for(let n=0;n<4;n++)await privateJson(join(root,`${environment}-${round}-${n}.private.json`),{owned:true})});
      await timed('preservation-private-json',round,()=>privateJson(join(root,`${environment}-${round}-preservation.private.json`),{owned:true}));
      await timed('listener-owned-explicit-imports',round,async()=>{const proof=await verifyExplicitImports(origin,listener.ready.port,process.pid);assert(proof.ownedAppAncestorConfirmed===true && proof.appPid===process.pid && proof.listenerPids.length===1 && proof.listenerPids[0]===listener.child.pid,'OWNED_LISTENER_PROOF_REQUIRED')});
      await timed('listener-foreign-explicit-imports-rejected',round,()=>assert.rejects(verifyExplicitImports(origin,listener.ready.port,foreign.child.pid),error=>error.code==='ERR_ASSERTION' && error.message.split('\n')[0]==='SERVICE_LISTENER_NOT_OWNED'));
    }
  } finally {
    await closeNode(listener); await closeNode(foreign);
    report[environment+'CleanupConfirmed']=true; await save();
  }
}
const {values}=parseArgs({options:{output:{type:'string'},child:{type:'string'}}});
assert(process.platform==='win32','WINDOWS_MEASUREMENT_REQUIRED');
for(const [name,expected] of Object.entries(sourceBindings))assert.equal(hash(await readFile(join(dirname(file),'native-tail-measure',name))),expected,'FROZEN_NATIVE_MODULE_REQUIRED');
if(values.child){
  const state=await readPrivate(resolve(values.child));
  const report=state.report;
  const save=()=>writeFile(state.safeOutput,JSON.stringify(report,null,2)+'\n');
  try {await measure('nativeChild',state.runRoot,report,save);report.passed=true;}
  catch {report.passed=false;process.exitCode=1;}
  finally {await save();}
}else{
  assert(isAbsolute(values.output??'') && isAbsolute(process.env.RUNNER_TEMP??''),'OWNED_OUTPUT_REQUIRED');
  const owner=join(process.env.RUNNER_TEMP,'native-tail-measure-'+randomUUID());await secureDirectory(owner);
  const report={scope:'windows-native-tail-measurement-only',actualNativeAcceptance:false,sourceBindings,github:{ref:process.env.GITHUB_REF,head:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT},parent:[],nativeChild:[]};
  assert(report.github.ref==='refs/heads/codex/native-acl-probe-20261020' && /^[a-f0-9]{40}$/.test(report.github.head??'') && /^\d+$/.test(report.github.runId??'') && /^\d+$/.test(report.github.attempt??''),'ACTUAL_PROBE_EVENT_REQUIRED');
  const save=()=>writeFile(values.output,JSON.stringify(report,null,2)+'\n');
  try {
    await measure('parent',owner,report,save);
    const runRoot=join(owner,'native-child');await secureDirectory(runRoot);
    const state={runRoot,home:join(runRoot,'home'),osHome:join(runRoot,'os-home'),appData:join(runRoot,'app-data'),temp:join(runRoot,'temp'),safeOutput:values.output,report};
    for(const key of ['home','osHome','appData','temp'])await mkdir(state[key],{mode:0o700});
    await writeFile(join(runRoot,'empty.npmrc'),'');
    const input=join(runRoot,'request.private.json');await privateJson(input,state);
    const child=spawn(process.execPath,[file,'--child',input],{env:baseEnvironment(state),cwd:runRoot,stdio:'ignore',windowsHide:true});
    const exited=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}))});
    const result=JSON.parse(await readFile(state.safeOutput,'utf8'));
    report.nativeChild=result.nativeChild;report.nativeChildCleanupConfirmed=result.nativeChildCleanupConfirmed===true;
    assert(exited.code===0 && exited.signal===null && result.passed===true,'NATIVE_CHILD_MEASUREMENT_REQUIRED');
    report.passed=[report.parent,report.nativeChild].every(rows=>rows.length===8 && rows.every(row=>row.passed===true)) && report.parentCleanupConfirmed && report.nativeChildCleanupConfirmed;
    assert(report.passed,'ALL_MEASUREMENTS_REQUIRED');
  }catch{report.passed=false;process.exitCode=1;}finally{await save();}
}
