/**
 * Package the Electron shell from an isolated project directory.
 *
 * The runtime payload is prepared separately because it contains platform
 * native dependencies. Keeping it outside the staging project also prevents
 * electron-builder from walking the parent workspace's node_modules.
 */
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {buildDesktopTools} from './build-desktop-tools.mjs';
import {prepareDesktopTrust} from './prepare-desktop-trust.mjs';
import {prepareCoreLayout} from '../desktop/prepare-core-layout.mjs';
import {readCoreLayout} from '../desktop/core-layer.mjs';
import {describeInstaller} from '../desktop/installer-artifact.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "desktop");
const buildRoot = join(root, ".runtime", "electron-build");

export const SHELL_FILES = [
  "main.cjs",
  "navigation.cjs",
  "config.cjs",
  "company.config.json",
  "permissions.cjs",
  "startup-state.cjs",
  "boot-watch.cjs",
  "updates.mjs",
  "client-installer.mjs",
  "installer-cache.mjs",
  "installer-blockmap.mjs",
  "installer-signature.mjs",
  "download-differential.cjs",
  "download-differential.LICENSE.txt",
  "windows-update-trust.json",
  "THIRD_PARTY_DESKTOP_NOTICES.txt",
  "desktop-release-sources.json",
  "release-sources.json",
  "control-server.mjs",
  "plugin-store.mjs",
  "plugin-store-lock.mjs",
  "plugin-storage.mjs",
  "core-layer.mjs",
  "core-file-mode.mjs",
  "core-asar-reader.cjs",
  "physical-fs.mjs",
  "copy-graph.mjs",
  "installer.mjs",
  "runtime-cookies.cjs",
  "onboarding.mjs",
  "preload.cjs",
];

function usage() {
  return "Usage: node scripts/package-desktop.mjs --target mac|win [--dir] [--keep-staging]";
}

function parseArgs(argv) {
  const values = { target: undefined, dir: false, keepStaging: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--target") values.target = argv[++i];
    else if (value === "--dir") values.dir = true;
    else if (value === "--keep-staging") values.keepStaging = true;
    else if (value === "--help" || value === "-h") { console.log(usage()); return null; }
    else throw new Error(`UNKNOWN_OPTION: ${value}\n${usage()}`);
  }
  if (!values.target || !["mac", "win"].includes(values.target))
    throw new Error(`Set --target to mac or win\n${usage()}`);
  return values;
}

async function assertDirectory(path, label) {
  try { if (!(await stat(path)).isDirectory()) throw Error(); }
  catch { throw new Error(`${label} must be an existing directory: ${path}`); }
}

/** The packaged manifest must keep the data-schema contract the shell validates against. */
export function stagedManifest(manifest) {
  return { name: manifest.name, version: manifest.version, private: true, main: manifest.main, desktopDataSchema: manifest.desktopDataSchema };
}

async function prepareStaging(target) {
  const staging = join(buildRoot, "staging", target);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const name of SHELL_FILES) {
    await cp(join(desktop, name), join(staging, name));
  }
  const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  // A staging project must never inherit the workspace manifest or dependencies.
  const staged = stagedManifest(manifest);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(staging, "package.json"), JSON.stringify(staged, null, 2) + "\n");
  await prepareDesktopTrust(staging,{target});
  return staging;
}

function runBuilder({ target, staging, dir }) {
  const bin = process.env.GEA_ELECTRON_BUILDER || "electron-builder";
  const args = ["--projectDir", staging, "--config", join(desktop, "electron-builder.cjs"), "--publish", "never"];
  if (dir) args.push("--dir");
  else args.push(target === "mac" ? "--mac" : "--win");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, GEA_DESKTOP_TARGET: target },
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolvePromise() : reject(new Error(`ELECTRON_BUILDER_FAILED:${code}`)));
  });
}

export async function validateDesktopPackage({ target, payloadRoot }) {
  if (!['mac', 'win'].includes(target)) throw new Error('INVALID_DESKTOP_TARGET');
  await assertDirectory(payloadRoot, "GEA_DESKTOP_PAYLOAD_ROOT");
  await assertDirectory(join(payloadRoot, target, "payload"), `payload for ${target}`);
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArgs(argv);
  if (!values) return;
  let payloadRoot = resolve(process.env.GEA_DESKTOP_PAYLOAD_ROOT || join(buildRoot, "payload"));
  await validateDesktopPackage({ target: values.target, payloadRoot });
  await buildDesktopTools();
  // Windows is the validated installation target for this change. macOS can
  // exercise the same layout explicitly before its separate signing acceptance.
  if((values.target==='win'||process.env.GEA_ENABLE_LAYERED_MAC==='1')&&!await readCoreLayout(join(payloadRoot,values.target,'payload'))){
    await mkdir(buildRoot,{recursive:true});const next=await mkdtemp(join(buildRoot,'layered-'));
    await mkdir(join(next,values.target));
    await prepareCoreLayout(join(payloadRoot,values.target,'payload'),join(next,values.target,'payload'));
    payloadRoot=next;
  }
  const staging = await prepareStaging(values.target);
  process.env.GEA_DESKTOP_PAYLOAD_ROOT = payloadRoot;
  try {
    await runBuilder({ target: values.target, staging, dir: values.dir });
    if(!values.dir){
      const manifest=JSON.parse(await readFile(join(staging,'package.json'),'utf8'));
      const file=join(buildRoot,'final',values.target,`GEA-Desktop-${manifest.version}-${values.target==='win'?'win-x64.exe':'mac-arm64.dmg'}`);
      const {writeFile}=await import('node:fs/promises');
      await writeFile(file+'.artifact.json',JSON.stringify(await describeInstaller(file),null,2)+'\n');
    }
  } finally {
    if (!values.keepStaging) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
