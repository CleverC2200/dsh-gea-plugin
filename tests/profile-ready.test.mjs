import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
const sourceTest = new URL("./fixtures/source-test.mjs", import.meta.url).href;
const readiness = new URL("./fixtures/profile-ready.mjs", import.meta.url).href;
async function execute(t, mode) {
  const runtime = await mkdtemp(join(tmpdir(), "gea-ready-clock-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const launcher = join(runtime, "launcher.mjs"),
    runner = join(runtime, "test.mjs");
  const receipt = join(runtime, "cleanup.json");
  await writeFile(
    launcher,
    `import {spawn} from 'node:child_process';import {writeFile} from 'node:fs/promises';
if(${JSON.stringify(mode)}!=='stale')setTimeout(async()=>{
 const host=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(mode === "never" ? "setInterval(()=>{},1000)" : "setTimeout(()=>console.log('dsh web: http://127.0.0.1:9999/?token=fixture'),25);setInterval(()=>{},1000)")}],{stdio:'inherit'});
 await writeFile(${JSON.stringify(join(runtime, "source-host.json"))},JSON.stringify({launcherPid:${mode === "wrong-launcher" ? "process.pid+1" : "process.pid"},hostPid:host.pid,status:'running',combination:${JSON.stringify(mode === "wrong-combination" ? "old" : "frozen")},core:'fixed'}));
},120);setInterval(()=>{},1000);`,
  );
  const previous =
    mode === "stale"
      ? JSON.stringify({
          launcherPid: 1,
          hostPid: 2,
          status: "running",
          combination: "frozen",
          core: "fixed",
        })
      : undefined;
  await writeFile(
    runner,
    `import test,{withSourceSetup} from ${JSON.stringify(sourceTest)};import {waitProfileReady} from ${JSON.stringify(readiness)};import {spawn} from 'node:child_process';import {once} from 'node:events';import {writeFile,readFile} from 'node:fs/promises';
const parent=new AbortController();${mode === "parent" ? "setTimeout(()=>parent.abort(Error('PARENT_CANCELLED')),75);" : ""}
test('public process readiness',{timeout:200,sourceSetupTimeoutMs:350,signal:parent.signal},async t=>{
 const child=spawn(process.execPath,[${JSON.stringify(launcher)}],{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let output='';for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>output+=b);
 const ended=once(child,'close');const stages=[];
 t.after(async()=>{try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}await ended;await writeFile(${JSON.stringify(receipt)},JSON.stringify({aborted:t.signal.aborted,childExited:child.exitCode!==null||child.signalCode!==null,stages}));});
 ${mode === "stale" ? `await writeFile(${JSON.stringify(join(runtime, "source-host.json"))},${JSON.stringify(previous)});` : ""}
 await withSourceSetup(t,()=>waitProfileReady({child,runtime:${JSON.stringify(runtime)},signal:t.signal,timeoutMs:80,source:${mode === "default" ? "undefined" : `{core:'fixed',combination:'frozen',previous:${JSON.stringify(previous)}}`},readOutput:()=>output,readLaunchLog:()=>output,recordLifecycle:e=>stages.push(e)}));
});`,
  );
  const env = { ...process.env, GEA_TEST_SOURCE_CORE: "1" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--test", runner], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const pipe of [child.stdout, child.stderr]) pipe.on("data", (bytes) => (output += bytes));
  const [status] = await once(child, "exit");
  return { status, output, cleanup: JSON.parse(await readFile(receipt, "utf8")) };
}
test("delayed admission keeps the original readiness duration after the fresh Host spawn", async (t) => {
  const result = await execute(t, "ready");
  assert.equal(result.status, 0, result.output);
  assert.equal(result.cleanup.stages.length, 1);
  assert.equal(result.cleanup.stages[0].startupTimeoutMs, 80);
  assert.equal(result.cleanup.childExited, true);
});
test("a fresh Host that never becomes ready still exhausts the original startup deadline", async (t) => {
  const result = await execute(t, "never");
  assert.equal(result.status, 1);
  assert.match(result.output, /Profile not ready/);
  assert.equal(result.cleanup.stages.length, 1);
  assert.equal(result.cleanup.childExited, true);
});
test("wrong launcher or frozen combination never starts the Host clock and preparation aborts", async (t) => {
  for (const mode of ["wrong-launcher", "wrong-combination"]) {
    const result = await execute(t, mode);
    assert.equal(result.status, 1);
    assert.match(result.output, /SOURCE_SETUP_TIMEOUT/);
    assert.equal(result.cleanup.stages.length, 0);
    assert.equal(result.cleanup.aborted, true);
    assert.equal(result.cleanup.childExited, true);
  }
});
test("a stale process receipt cannot grant the current launcher a readiness clock", async (t) => {
  const result = await execute(t, "stale");
  assert.equal(result.status, 1);
  assert.match(result.output, /SOURCE_SETUP_TIMEOUT/);
  assert.equal(result.cleanup.stages.length, 0);
  assert.equal(result.cleanup.childExited, true);
});
test("parent cancellation before Host spawn joins the owned launcher cleanup", async (t) => {
  const result = await execute(t, "parent");
  assert.equal(result.status, 1);
  assert.match(result.output, /PARENT_CANCELLED/);
  assert.equal(result.cleanup.stages.length, 0);
  assert.equal(result.cleanup.aborted, true);
  assert.equal(result.cleanup.childExited, true);
});
test("the default non-Source readiness clock still starts at wrapper spawn", async (t) => {
  const result = await execute(t, "default");
  assert.equal(result.status, 1);
  assert.match(result.output, /Profile not ready/);
  assert.equal(result.cleanup.stages.length, 0);
  assert.equal(result.cleanup.childExited, true);
});
