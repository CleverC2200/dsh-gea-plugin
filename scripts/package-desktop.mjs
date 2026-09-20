/**
 * Package the Electron shell from an isolated project directory.
 *
 * The runtime payload is prepared separately because it contains platform
 * native dependencies. Keeping it outside the staging project also prevents
 * electron-builder from walking the parent workspace's node_modules.
 */
import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "desktop");
const buildRoot = join(root, ".runtime", "electron-build");

export const SHELL_FILES = [
  "main.cjs",
  "config.cjs",
  "company.config.json",
  "permissions.cjs",
  "startup-state.cjs",
  "updates.mjs",
  "client-installer.mjs",
  "desktop-release-sources.json",
  "release-sources.json",
  "control-server.mjs",
  "plugin-store.mjs",
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

async function prepareStaging(target) {
  const staging = join(buildRoot, "staging", target);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const name of SHELL_FILES) {
    await cp(join(desktop, name), join(staging, name));
  }
  const manifest = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  // A staging project must never inherit the workspace manifest or dependencies.
  const staged = { name: manifest.name, version: manifest.version, private: true, main: manifest.main };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(staging, "package.json"), JSON.stringify(staged, null, 2) + "\n");
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
  const payloadRoot = resolve(process.env.GEA_DESKTOP_PAYLOAD_ROOT || join(buildRoot, "payload"));
  await validateDesktopPackage({ target: values.target, payloadRoot });
  const staging = await prepareStaging(values.target);
  process.env.GEA_DESKTOP_PAYLOAD_ROOT = payloadRoot;
  try {
    await runBuilder({ target: values.target, staging, dir: values.dir });
  } finally {
    if (!values.keepStaging) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
