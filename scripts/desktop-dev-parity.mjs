import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile);
export const runtimePackages = [
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "dsh-plugin",
];

async function packageVersion(root, name) {
  const manifest = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
  return manifest.version;
}

export async function readRuntimeVersions(root) {
  const versions = {};
  for (const name of runtimePackages) {
    try { versions[name] = await packageVersion(root, name); }
    catch { versions[name] = null; }
  }
  return versions;
}

export function assertRuntimeParity(versions) {
  const missing = runtimePackages.filter((name) => !versions[name]);
  if (missing.length) throw new Error(`DESKTOP_DEV_PAYLOAD_INCOMPLETE: ${missing.join(", ")}`);
  return versions;
}

export async function sourceProvenance(root, payload, sourcePackage) {
  let commit = null;
  try { commit = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(); }
  catch {}
  const payloadManifest = JSON.parse(await readFile(join(payload, "package.json"), "utf8"));
  return {
    mode: "desktop-dev",
    source: { package: sourcePackage.name, version: sourcePackage.version, commit },
    payload: { package: payloadManifest.name, version: payloadManifest.version, runtime: assertRuntimeParity(await readRuntimeVersions(payload)) },
    overlay: "@cleverc2200/gea-dsh-prototype",
    generatedAt: new Date().toISOString(),
  };
}

export async function writeProvenance(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}
