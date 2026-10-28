import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValue = (value, detail) => {
  if (!value) throw Error("DEPENDENCY_POLICY_REJECTED: " + detail);
};
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
async function binding(context) {
  requireValue(context.runId && context.runAttempt, "run binding required");
  const sources = {};
  for (const name of ["gea", "core"]) {
    const root = resolve(context[name]);
    const changes = git(root, "status", "--porcelain");
    requireValue(changes === "", "dirty " + name + ": " + changes);
    const bytes = await fs.readFile(join(root, "package.json"));
    const manifest = JSON.parse(bytes);
    requireValue(/^pnpm@11\.\d+\.\d+$/.test(manifest.packageManager), "declared pnpm required");
    sources[name] = {
      head: git(root, "rev-parse", "HEAD"),
      packageManager: manifest.packageManager,
      packageSha256: hash(bytes),
      lockSha256: hash(await fs.readFile(join(root, "pnpm-lock.yaml"))),
    };
  }
  return {
    runId: String(context.runId),
    runAttempt: String(context.runAttempt),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    sources,
  };
}
function nativeCheck(root, cache) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "corepack",
      [
        "pnpm",
        "install",
        "--lockfile-only",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prefer-offline",
        "--trust-lockfile=false",
        "--cache-dir",
        cache,
      ],
      { cwd: root, env: { ...process.env, CI: "true" }, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(Error("DEPENDENCY_POLICY_CHECK_FAILED: " + code)),
    );
  });
}
export async function prepareDependencyPolicy(context) {
  const before = await binding(context);
  const directory = resolve(context.directory);
  await fs.mkdir(directory);
  const cache = join(directory, "cache");
  await fs.mkdir(cache);
  for (const name of ["core", "gea"]) await nativeCheck(resolve(context[name]), cache);
  requireValue(
    JSON.stringify(await binding(context)) === JSON.stringify(before),
    "source changed during preparation",
  );
  const bytes = await fs.readFile(join(cache, "lockfile-verified.jsonl"));
  requireValue(bytes.length > 0, "native verification cache missing");
  const receipt = {
    schemaVersion: 1,
    status: "prepared",
    binding: before,
    producerRoots: Object.fromEntries(
      ["gea", "core"].map((name) => [name, resolve(context[name])]),
    ),
    cacheSha256: hash(bytes),
  };
  await fs.writeFile(join(directory, "policy-cache.jsonl"), bytes, { mode: 0o600 });
  await fs.writeFile(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
  return receipt;
}
export async function restoreDependencyPolicy(context) {
  const directory = resolve(context.directory);
  const receipt = JSON.parse(await fs.readFile(join(directory, "receipt.json"), "utf8"));
  requireValue(receipt.schemaVersion === 1 && receipt.status === "prepared", "receipt format");
  requireValue(
    JSON.stringify(receipt.binding) === JSON.stringify(await binding(context)),
    "input binding mismatch",
  );
  const bytes = await fs.readFile(join(directory, "policy-cache.jsonl"));
  requireValue(hash(bytes) === receipt.cacheSha256, "cache digest mismatch");
  const lockfiles = await Promise.all(
    ["gea", "core"].map((name) => fs.realpath(join(resolve(context[name]), "pnpm-lock.yaml"))),
  );
  const entries = bytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  requireValue(
    entries.length > 0 &&
      entries.every(
        (entry) =>
          typeof entry.lockfile?.hash === "string" &&
          typeof entry.lockfile?.path === "string" &&
          !lockfiles.includes(entry.lockfile.path),
      ),
    "consumer must use native content verification",
  );
  const cache = resolve(context.cache);
  await fs.mkdir(cache);
  await fs.writeFile(join(cache, "lockfile-verified.jsonl"), bytes, { mode: 0o600 });
  return {
    schemaVersion: 1,
    status: "restored",
    binding: receipt.binding,
    cacheSha256: receipt.cacheSha256,
    producerRoots: receipt.producerRoots,
    consumerRoots: Object.fromEntries(
      ["gea", "core"].map((name) => [name, resolve(context[name])]),
    ),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      prepare: { type: "boolean" },
      restore: { type: "boolean" },
      gea: { type: "string" },
      core: { type: "string" },
      directory: { type: "string" },
      cache: { type: "string" },
    },
  });
  requireValue(
    Boolean(values.prepare) !== Boolean(values.restore) &&
      values.gea &&
      values.core &&
      values.directory,
    "command",
  );
  const context = {
    ...values,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  requireValue(values.prepare || values.cache, "consumer cache required");
  const { ciCores } = await import("./ci-core-policy.mjs");
  const expected = ciCores("required")[0];
  requireValue(
    git(values.core, "rev-parse", "HEAD") === expected.head &&
      hash(await fs.readFile(join(values.core, "pnpm-lock.yaml"))) === expected.lockSha256,
    "registered Core required",
  );
  console.log(
    JSON.stringify(
      await (values.prepare ? prepareDependencyPolicy(context) : restoreDependencyPolicy(context)),
    ),
  );
}
