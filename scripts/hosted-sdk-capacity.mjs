import fs from "node:fs";
import os from "node:os";
import child from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { acquireBuild, readBuildCapacity } from "./build-admission.mjs";

const directories = [
  "/usr/share/dotnet",
  "/usr/local/lib/android",
  "/usr/share/swift",
  "/usr/local/.ghcup",
  "/opt/ghc",
];

export function reclaimHostedSdks({ cwd = process.cwd(), output = cwd } = {}) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    os.platform() !== "linux"
  )
    throw Error("HOSTED_SDK_RUNNER_REQUIRED: GitHub-hosted Linux only");
  const options = { operation: "sdk", cwd, output };
  const result = { status: "checking", before: readBuildCapacity(options), removed: [] };
  let refusal;
  const admit = () => {
    try {
      const release = acquireBuild(options);
      release();
      result.after = readBuildCapacity(options);
      return true;
    } catch (error) {
      if (error.code !== "BUILD_CAPACITY_INSUFFICIENT") throw error;
      refusal = error;
      result.after = readBuildCapacity(options);
      return false;
    }
  };
  try {
    if (admit()) {
      result.status = "not-needed";
      return result;
    }
    const candidates = directories
      .filter((path) => fs.lstatSync(path, { throwIfNoEntry: false })?.isDirectory())
      .map((path) => {
        const started = performance.now();
        const listing = child.execFileSync("du", ["-sk", "--", path], { encoding: "utf8" });
        const bytes = Number(listing.trim().split(/\s+/)[0]) * 1024;
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("HOSTED_SDK_SIZE_INVALID");
        return { path, bytes, inspectedMs: performance.now() - started };
      })
      .sort((left, right) => left.bytes - right.bytes);
    result.inspected = candidates.map((entry) => ({ ...entry }));
    while (candidates.length) {
      const deficit = result.after.requiredBytes - result.after.availableBytes;
      const index = candidates.findIndex((entry) => entry.bytes >= deficit);
      const selected = candidates.splice(index < 0 ? candidates.length - 1 : index, 1)[0];
      const action = { path: selected.path, bytesBefore: selected.bytes, status: "started" };
      result.removed.push(action);
      const started = performance.now();
      try {
        child.execFileSync("sudo", ["rm", "-rf", "--", selected.path], { encoding: "utf8" });
        action.status = "removed";
      } catch (error) {
        action.status = "failed";
        throw error;
      } finally {
        action.durationMs = performance.now() - started;
      }
      if (admit()) {
        result.status = "reclaimed";
        return result;
      }
    }
    throw refusal;
  } catch (error) {
    result.status = "failed";
    error.reclamation = result;
    throw error;
  }
}

if (
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))
) {
  const { values } = parseArgs({
    options: { output: { type: "string" }, report: { type: "string" } },
  });
  if (!isAbsolute(values.output ?? ""))
    throw Error("HOSTED_SDK_OUTPUT_REQUIRED: absolute output volume");
  const save = (result) => {
    if (values.report) {
      const file = resolve(values.report);
      fs.mkdirSync(dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    }
  };
  try {
    const result = reclaimHostedSdks({ output: values.output });
    save(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    if (error.reclamation) save({ ...error.reclamation, error: error.message });
    console.error(error.message);
    process.exitCode = 1;
  }
}
