import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginUpdateOperation } from "../shared/plugin-update-state.ts";

export const windowsPackageRunner = String.raw`
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
async function main(){
 if(process.platform!=='win32')throw Error('WINDOWS_JOB_REQUIRED');
 const probe=process.argv[2]==='--probe',replace=process.argv[2]==='--replace',request=probe||replace?null:JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const anchor=probe||replace?process.argv[3]:request.anchor,expected=probe||replace?process.argv[4]:request.coreVersion,load=createRequire(anchor);
 const manifest=JSON.parse(fs.readFileSync(load.resolve('@deepseek-ai/dsh-win32-process/package.json'),'utf8'));
 if(manifest.name!=='@deepseek-ai/dsh-win32-process'||manifest.version!==expected)throw Error('WINDOWS_JOB_SDK_MISMATCH');
 const api=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-win32-process')).href),bindings=api.loadWin32ProcessBindings();
 const io=api.extendWin32ProcessBindings(({kernel32,bind})=>({move:bind(kernel32,'MoveFileExW','int',['str16','str16','uint32'])}));
 const commit=(from,to)=>{if(!io.move(from,to,9))throw Error('WINDOWS_WRITE_THROUGH_FAILED');};
 if(replace){commit(process.argv[5],process.argv[6]);return;}
 api.probeCurrentTokenJobSupport(bindings);
 if(probe)return;
 const directory=path.dirname(process.argv[2]),proof=path.join(directory,'windows-job.json'),ack=path.join(directory,'windows-job-ack.json'),cancel=path.join(directory,'windows-job-cancel.json');
 const publish=value=>{const tmp=proof+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify({nonce:request.nonce,pid:process.pid,...value}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}commit(tmp,proof);};
 const sleep=()=>new Promise(resolve=>setTimeout(resolve,10));
 publish({stage:'ready'});
 const deadline=Date.now()+10000;
 while(true){try{if(JSON.parse(fs.readFileSync(ack,'utf8')).nonce===request.nonce)break;}catch(error){if(error.code!=='ENOENT')throw error;}if(Date.now()>deadline)throw Error('WINDOWS_JOB_NOT_OBSERVED');await sleep();}
 const env=Object.fromEntries(Object.entries(process.env).filter(([,value])=>typeof value==='string'));
 let child,code,terminated=false;
 try{
  child=api.spawnCurrentTokenJobProcess(bindings,{command:request.command,applicationName:request.command,args:[...request.args,...process.argv.slice(3)],cwd:process.cwd(),env,stdio:{stdin:0,stdout:1,stderr:2}});
  publish({stage:'running',targetPid:child.pid});
  while(true){
   if(!terminated&&fs.existsSync(cancel)){const value=JSON.parse(fs.readFileSync(cancel,'utf8'));if(value.nonce===request.nonce){api.terminateJob(bindings,child.job,1);terminated=true;}}
   if(code===undefined)code=api.pollProcessExit(bindings,child.process);
   if(code!==undefined&&api.isJobEmpty(bindings,child.job))break;
   await sleep();
  }
  api.closeHandleChecked(bindings,child.process,'plugin package process');child.process=null;
  api.closeHandleChecked(bindings,child.job,'plugin package job');child.job=null;
  publish({stage:'empty',targetPid:child.pid,exitCode:code});
  process.exitCode=code;
 }finally{
  if(child?.job){try{api.terminateJob(bindings,child.job,1);}finally{api.closeHandleChecked(bindings,child.job,'plugin package failed job');}}
  if(child?.process)api.closeHandleChecked(bindings,child.process,'plugin package failed process');
 }
}
main().catch(error=>{const detail=typeof error?.api==='string'&&/^[A-Za-z0-9_]+$/.test(error.api)&&Number.isInteger(error.win32Code)?error.api+':'+error.win32Code:/^[A-Z][A-Z0-9_]+$/.test(error?.message)?error.message:/^[A-Z][A-Z0-9_]+$/.test(error?.code)?error.code:'UNKNOWN';process.stderr.write('UPDATE_WINDOWS_JOB_UNCONFIRMED '+detail+'\n');process.exitCode=1;});
`;

import type { ProfileContext } from "@deepseek-ai/dsh-app-boot";
type PackageManager = ProfileContext["packageManager"];
type Observation = PluginUpdateOperation["processes"][number];
export type PluginUpdateFileCommit = { replace(from: string, to: string): Promise<void> };

export async function prepareWindowsFileCommit(
  directory: string,
  anchor: string,
  coreVersion: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runner = join(directory, randomUUID() + ".cjs");
  await writeFile(runner, windowsPackageRunner, { flag: "wx", mode: 0o600 });
  return {
    async replace(from: string, to: string) {
      execFileSync(
        process.execPath,
        ["--expose-internals", runner, "--replace", anchor, coreVersion, from, to],
        {
          timeout: 10_000,
          stdio: "ignore",
          windowsHide: true,
        },
      );
    },
  } satisfies PluginUpdateFileCommit;
}

export async function prepareWindowsPackageRun(
  directory: string,
  profile: string,
  anchor: string,
  coreVersion: string,
  manager: PackageManager,
  persistObservation: (observation: Observation) => Promise<void>,
) {
  if (
    !manager?.command ||
    !isAbsolute(manager.command) ||
    !manager.command.toLowerCase().endsWith(".exe")
  )
    throw Error("UPDATE_WINDOWS_LAUNCHER_UNSUPPORTED");
  const runner = join(directory, "windows-package-runner.cjs"),
    requestPath = join(directory, "windows-package-request.json"),
    proofPath = join(directory, "windows-job.json"),
    nonce = randomUUID();
  await writeFile(runner, windowsPackageRunner, { flag: "wx", mode: 0o600 });
  try {
    execFileSync(process.execPath, ["--expose-internals", runner, "--probe", anchor, coreVersion], {
      env: { ...process.env, ...manager.env },
      timeout: 10_000,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    throw Error("UPDATE_WINDOWS_JOB_UNAVAILABLE");
  }
  await writeFile(
    requestPath,
    JSON.stringify({
      nonce,
      anchor,
      coreVersion,
      command: manager.command,
      args: manager.args ?? [],
    }),
    { flag: "wx", mode: 0o600 },
  );
  let observed: Observation | null = null,
    empty = false,
    unreliable = false,
    capturing = false;
  async function capture() {
    if (capturing || unreliable) return;
    capturing = true;
    try {
      const value: unknown = JSON.parse(readFileSync(proofPath, "utf8"));
      if (
        value === null ||
        typeof value !== "object" ||
        !("nonce" in value) ||
        value.nonce !== nonce ||
        !("pid" in value) ||
        typeof value.pid !== "number" ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        !("stage" in value) ||
        !["ready", "running", "empty"].includes(String(value.stage))
      )
        throw Error("WINDOWS_JOB_PROOF_INVALID");
      if (observed && observed.pid !== value.pid) throw Error("WINDOWS_JOB_PROCESS_CHANGED");
      if (!observed) {
        const record: unknown = JSON.parse(
          readFileSync(join(profile, ".plugin-manager/run.json"), "utf8"),
        );
        if (
          record === null ||
          typeof record !== "object" ||
          !("pid" in record) ||
          record.pid !== value.pid ||
          !("grouped" in record) ||
          record.grouped !== false ||
          value.stage !== "ready"
        )
          throw Error("WINDOWS_JOB_RUN_RECORD_MISMATCH");
        process.kill(value.pid, 0);
        const observation = {
          pid: value.pid,
          grouped: false,
          startIdentity: nonce,
          sawAlive: true,
        };
        try {
          await persistObservation(observation);
        } catch {
          unreliable = true;
          return;
        }
        observed = observation;
        const acknowledgement = join(directory, "windows-job-ack.json");
        writeFileSync(acknowledgement + ".tmp", JSON.stringify({ nonce }), {
          flag: "wx",
          mode: 0o600,
        });
        renameSync(acknowledgement + ".tmp", acknowledgement);
      }
      if (value.stage === "empty") {
        if (!("exitCode" in value) || !Number.isInteger(value.exitCode))
          throw Error("WINDOWS_JOB_EXIT_INVALID");
        empty = true;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        unreliable = true;
    } finally {
      capturing = false;
    }
  }
  const timer = setInterval(capture, 10);
  timer.unref();
  return {
    packageManager: {
      ...manager,
      command: process.execPath,
      args: ["--expose-internals", runner, requestPath],
    },
    capture,
    snapshot: () => (observed ? [{ ...observed }] : []),
    async waitForQuiescence(waitMs: number) {
      const deadline = Date.now() + waitMs;
      do {
        await capture();
        if (observed && empty && !unreliable) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      return false;
    },
    cancelObserved() {
      const path = join(directory, "windows-job-cancel.json"),
        temporary = path + ".tmp";
      writeFileSync(temporary, JSON.stringify({ nonce }), { mode: 0o600 });
      renameSync(temporary, path);
    },
    close() {
      clearInterval(timer);
    },
  };
}
