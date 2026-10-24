/** Controlled OS commands for the public quality CLI fixture; never imported by the runner. */
import fs from "node:fs";
import os from "node:os";
import commands from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const job = process.env.QUALITY_STAGE_FIXTURE_ROOT;
if (!job) throw Error("QUALITY_STAGE_FIXTURE_ROOT_REQUIRED");
fs.statfsSync = () => ({ bavail: 100 * 1024 ** 3, bsize: 1 });
os.tmpdir = () => job;
if (process.env.FIXTURE_PLATFORM)
  Object.defineProperty(process, "platform", { value: process.env.FIXTURE_PLATFORM });
const originalSpawn = commands.spawnSync;
const originalKill = process.kill.bind(process);
if (process.env.FIXTURE_REQUIRE_SUDO === "1")
  process.kill = (pid, signal) => {
    if (pid < 0 && signal !== 0)
      throw Object.assign(Error("controlled root-owned group"), { code: "EPERM" });
    return originalKill(pid, signal);
  };
const originalExec = commands.execFileSync;
const success = { status: 0, stdout: "", stderr: "" };
const log = (command, args, cwd, shell) =>
  appendFileSync(
    resolve(job, "commands.jsonl"),
    JSON.stringify({ command, args, cwd, shell }) + "\n",
  );
commands.execFileSync = (command, args, options = {}) => {
  if (command === "corepack" && args.includes("--dry-run"))
    return ["chromium", "headless", "ffmpeg"]
      .map((name) => "Install location: " + resolve(job, ".quality-browser", name))
      .join("\n");
  if (command === "corepack" || command === "npm") return command === "npm" ? "11.11.0" : "11.27.0";
  return originalExec(command, args, options);
};
const originalAsyncSpawn = commands.spawn;
const browserCommand = (command, args) =>
  command === "corepack" && args.includes("playwright") && args.includes("install");
const browserFixture = resolve(
  job,
  "candidate/dsh-gea-plugin/scripts/fixtures/quality-browser-install.cjs",
);
commands.spawn = (command, args, options = {}) =>
  browserCommand(command, args)
    ? originalAsyncSpawn(process.execPath, [browserFixture], options)
    : originalAsyncSpawn(command, args, options);
commands.spawnSync = (command, args, options = {}) => {
  if (command === "sudo") {
    log(command, args, options.cwd);
    if (process.env.FIXTURE_SUDO_FAIL === "1")
      return { ...success, status: 1, stderr: "controlled sudo denial" };
    try {
      originalKill(Number(args.at(-1)), args[3]);
      return success;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return { ...success, status: 1, stderr: "No such process" };
    }
  }
  if (["corepack.cmd", "npm.cmd"].includes(command)) {
    log(command, args, options.cwd, options.shell);
    command = command.slice(0, -4);
  }
  if (browserCommand(command, args))
    return originalSpawn(process.execPath, [browserFixture], { ...options, shell: false });
  const cwd = options.cwd ?? process.cwd();
  if (command === process.execPath && args[0] === "node_modules/typescript/bin/tsc") {
    log("workbench-declarations", args, cwd);
    if (process.env.FIXTURE_FAIL === "declarations") return { ...success, status: 1 };
    mkdirSync(resolve(cwd, "lib/types"), { recursive: true });
    writeFileSync(resolve(cwd, "lib/types/host.d.ts"), "export declare const prepared: true;\n");
    return success;
  }
  if (command === process.execPath && args[0] === "node_modules/esbuild/bin/esbuild") {
    log("workbench-model", args, cwd);
    if (process.env.FIXTURE_FAIL === "workbench-model") return { ...success, status: 1 };
    mkdirSync(resolve(cwd, "lib"), { recursive: true });
    writeFileSync(resolve(cwd, "lib/sales-plan.js"), "export const prepared = true;\n");
    return success;
  }
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
    if (process.env.QUALITY_STAGE_FIXTURE_MACOS === "1") {
      mkdirSync(resolve(core, "apps/web/dist"), { recursive: true });
      writeFileSync(resolve(core, "apps/web/dist/index.html"), "fixture Web\n");
      for (const kind of ["artifacts", "web"])
        writeFileSync(resolve(core, ".git/dsh-sdk-" + kind + ".json"), "{}\n");
    }
    return success;
  }
  if (command === process.execPath && args[0] === "scripts/build.mjs") {
    log("host-build", args, cwd);
    if (process.env.FIXTURE_FAIL === "build") return { ...success, status: 1 };
    mkdirSync(resolve(cwd, "lib"), { recursive: true });
    writeFileSync(resolve(cwd, "lib/host.js"), "export const prepared=true;\n");
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
