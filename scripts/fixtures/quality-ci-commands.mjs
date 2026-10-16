/** Controlled OS commands for the public quality CLI fixture; never imported by the runner. */
import commands from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const job = process.env.QUALITY_STAGE_FIXTURE_ROOT;
if (!job) throw Error("QUALITY_STAGE_FIXTURE_ROOT_REQUIRED");
if (process.env.FIXTURE_PLATFORM)
  Object.defineProperty(process, "platform", { value: process.env.FIXTURE_PLATFORM });
const originalSpawn = commands.spawnSync;
const originalExec = commands.execFileSync;
const success = { status: 0, stdout: "", stderr: "" };
const log = (command, args, cwd) =>
  appendFileSync(resolve(job, "commands.jsonl"), JSON.stringify({ command, args, cwd }) + "\n");
commands.execFileSync = (command, args, options = {}) => {
  if (command === "corepack" || command === "npm") return command === "npm" ? "11.11.0" : "11.27.0";
  return originalExec(command, args, options);
};
commands.spawnSync = (command, args, options = {}) => {
  const cwd = options.cwd ?? process.cwd();
  if (command === process.execPath && args[0]?.endsWith("/prepare-official-sdk.mjs")) {
    log("sdk", args, cwd);
    const core = args[args.indexOf("--core") + 1];
    if (process.env.FIXTURE_FAIL === "prepare") return { ...success, status: 1 };
    if (args.includes("--prepare") && !existsSync(core)) {
      const clone = originalSpawn(
        "git",
        ["clone", "-q", resolve(job, "source/official-core"), core],
        {
          encoding: "utf8",
        },
      );
      if (clone.status) return clone;
    }
    if (!existsSync(core)) return { ...success, status: 1, stderr: "missing prepared SDK" };
    return success;
  }
  if (command === process.execPath && args[0]?.endsWith("/verify-candidate-input.mjs")) {
    log("verify-candidate", args, cwd);
    return success;
  }
  if (command === "corepack" || command === "npm") {
    log(command, args, cwd);
    if (args.includes("--version"))
      return { ...success, stdout: cwd.includes("dsh-better-sidebar") ? "11.8.0" : "11.27.0" };
    if (args.includes("build") || args.includes("build:plugin")) {
      if (process.env.FIXTURE_FAIL === "build" && cwd === resolve(job, "candidate/dsh-gea-plugin"))
        return { ...success, status: 1 };
      mkdirSync(resolve(cwd, "lib"), { recursive: true });
      writeFileSync(resolve(cwd, "lib/host.js"), "fixture built output\n");
      if (cwd === resolve(job, "candidate/dsh-agent-manage")) {
        mkdirSync(resolve(cwd, "client"), { recursive: true });
        writeFileSync(resolve(cwd, "client/client.js"), "fixture client output\n");
        writeFileSync(resolve(cwd, "client/client.js.map"), "fixture client sourcemap\n");
      }
    }
    if (args.includes("quality:fast") && process.env.FIXTURE_BLOCK)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    if (args.includes("quality:fast") && process.env.FIXTURE_FAIL === "checks")
      return { ...success, status: 1 };
    return success;
  }
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
