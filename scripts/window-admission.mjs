/** Read-only admission for the current source Host launch interfaces. */
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  readSourceSelection,
  readSourceCombination,
  resolveSourceInputs,
} from "./source-profile.mjs";
import { sourcePlugins } from "./source-composition.mjs";
import { readDeployment } from "./deployment.mjs";
async function physicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(await physicalPath(dirname(resolve(path))), basename(path));
  }
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sourceWindowModes = Object.freeze([
  "source-host",
  "isolated-source-host",
  "isolated-core-host",
]);
export async function admitSourceWindow({
  window,
  mode,
  core,
  runtime,
  config,
  deployment,
  sources,
  sourcesFile,
}) {
  if (
    !window?.file ||
    !window.case ||
    !window.owner ||
    !/^[a-f0-9]{64}$/.test(window.freezeSha256 ?? "")
  )
    throw Error("WINDOW_DECLARATION_REQUIRED");
  const current = JSON.parse(await readFile(window.file, "utf8"));
  if (current.status !== "open") throw Error("WINDOW_NOT_OPEN");
  if (current.paused !== false) throw Error("WINDOW_PAUSED");
  const bytes = await readFile(current.freeze.file);
  if (digest(bytes) !== window.freezeSha256) throw Error("WINDOW_FREEZE_DIGEST_MISMATCH");
  const frozen = JSON.parse(bytes);
  if (frozen.file !== basename(current.freeze.file)) throw Error("WINDOW_FREEZE_FILE_MISMATCH");
  if (current.case !== window.case || frozen.case !== window.case)
    throw Error("WINDOW_CASE_MISMATCH");
  if (current.owner !== window.owner || frozen.owner !== window.owner)
    throw Error("WINDOW_OWNER_MISMATCH");
  const budget = current.budget;
  if (!budget?.limits || !budget?.remaining) throw Error("WINDOW_BUDGET_REQUIRED");
  for (const key of ["hostStarts", "businessRequests", "modelTasks", "businessWrites"])
    if (budget.limits[key] === undefined || budget.remaining[key] === undefined)
      throw Error("WINDOW_BUDGET_REQUIRED");
  if (
    JSON.stringify(Object.keys(budget.limits).sort()) !==
    JSON.stringify(Object.keys(budget.remaining).sort())
  )
    throw Error("WINDOW_BUDGET_REQUIRED");
  for (const [key, remaining] of Object.entries(budget.remaining)) {
    if (!Number.isSafeInteger(remaining) || !Number.isSafeInteger(budget.limits[key]))
      throw Error("WINDOW_BUDGET_UNKNOWN");
    if (budget.limits[key] < 0 || remaining < 0 || remaining > budget.limits[key])
      throw Error("WINDOW_BUDGET_INVALID");
  }
  if (JSON.stringify(budget) !== JSON.stringify(frozen.budget))
    throw Error("WINDOW_BUDGET_MISMATCH");
  if (budget.remaining.hostStarts < 1) throw Error("WINDOW_BUDGET_EXHAUSTED");
  if (!sourceWindowModes.includes(mode) || frozen.mode !== mode)
    throw Error("WINDOW_MODE_MISMATCH");
  const expectedRuntime = await physicalPath(resolve(frozen.runtime));
  const actualRuntime = await physicalPath(resolve(runtime));
  if (
    mode !== "source-host" &&
    !expectedRuntime.startsWith((await realpath(resolve(import.meta.dirname, ".."))) + "/")
  )
    throw Error("WINDOW_RUNTIME_MISMATCH");
  if (
    actualRuntime !== expectedRuntime &&
    !(
      mode !== "source-host" &&
      dirname(actualRuntime) === expectedRuntime &&
      basename(runtime).startsWith("run-")
    )
  )
    throw Error("WINDOW_RUNTIME_MISMATCH");
  if ((await realpath(core)) !== (await realpath(frozen.core))) throw Error("WINDOW_CORE_MISMATCH");
  const candidateBytes = await readFile(frozen.candidate.file);
  if (digest(candidateBytes) !== frozen.candidate.sha256)
    throw Error("WINDOW_CANDIDATE_DIGEST_MISMATCH");
  const candidate = JSON.parse(candidateBytes);
  const workbench = candidate.repositories?.find((entry) => entry.repo === "dsh-agent-workbench");
  const gea = candidate.repositories?.find((entry) => entry.repo === "dsh-gea-plugin");
  if (
    !workbench ||
    !gea ||
    (await realpath(gea.path)) !== (await realpath(resolve(import.meta.dirname, "..")))
  )
    throw Error("WINDOW_CANDIDATE_CHECKOUT_MISMATCH");
  // Shared candidate/official checks own the fixed Core and clean three-repository contract.
  try {
    execFileSync(
      process.execPath,
      [
        join(workbench.path, "scripts/verify-candidate-input.mjs"),
        "--input",
        frozen.candidate.file,
        "--checkout",
        gea.path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw Error(error.stderr?.toString().trim() || "WINDOW_CANDIDATE_REJECTED");
  }
  if (
    execFileSync("git", ["-C", core, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() !== candidate.core
  )
    throw Error("WINDOW_CORE_MISMATCH");
  if (mode === "source-host") {
    if (!frozen.config || (config && resolve(config) !== resolve(frozen.config.file)))
      throw Error("WINDOW_CONFIG_MISMATCH");
    if (digest(await readFile(frozen.config.file)) !== frozen.config.sha256)
      throw Error("WINDOW_CONFIG_DIGEST_MISMATCH");
    const normalized = await readDeployment(frozen.config.file, {
      resolveCredentials: false,
      checkDirectCredential: false,
      credentialEnv: {},
    });
    if (
      digest(JSON.stringify(normalized)) !== frozen.deploymentSha256 ||
      (deployment && digest(JSON.stringify(deployment)) !== frozen.deploymentSha256)
    )
      throw Error("WINDOW_DEPLOYMENT_MISMATCH");
  } else if (deployment !== undefined || config !== undefined)
    throw Error("WINDOW_DEPLOYMENT_MISMATCH");
  const verifySnapshot = async (binding) => {
    if (!binding?.runtime || !binding.id || !binding.manifestSha256)
      throw Error("WINDOW_COMBINATION_REQUIRED");
    const directory = join(binding.runtime, "source-combinations", binding.id);
    if (digest(await readFile(join(directory, "combination.json"))) !== binding.manifestSha256)
      throw Error("WINDOW_COMBINATION_MISMATCH");
    const composition = await readSourceCombination(binding.runtime, binding.id, core);
    if (
      JSON.stringify(Object.keys(composition.dependencies).sort()) !==
      JSON.stringify(sourcePlugins.map((plugin) => plugin.name).sort())
    )
      throw Error("WINDOW_COMBINATION_MISMATCH");
    const metadata = JSON.parse(await readFile(join(directory, "company-plugins.json"), "utf8"));
    for (const entry of candidate.repositories) {
      const plugin = sourcePlugins.find((plugin) => plugin.repo === entry.repo);
      if (
        !plugin ||
        metadata[plugin.name]?.commit !== entry.head ||
        (await realpath(metadata[plugin.name].source)) !== (await realpath(entry.path))
      )
        throw Error("WINDOW_SOURCE_CANDIDATE_MISMATCH");
    }
    return directory;
  };
  const combination = frozen.combination;
  if (mode === "isolated-core-host") {
    if (combination?.kind !== "core" || sources !== undefined || sourcesFile !== undefined)
      throw Error("WINDOW_COMBINATION_MISMATCH");
  } else if (combination?.kind === "selection") {
    if (mode !== "source-host" || sources !== undefined || sourcesFile !== undefined)
      throw Error("WINDOW_COMBINATION_MISMATCH");
    const selected = await readSourceSelection(expectedRuntime);
    if (selected?.id !== combination.id || selected?.manifestSha256 !== combination.manifestSha256)
      throw Error("WINDOW_COMBINATION_MISMATCH");
    await verifySnapshot({ ...combination, runtime: expectedRuntime });
  } else if (combination?.kind === "sources") {
    if (sources === undefined && sourcesFile === undefined)
      throw Error("WINDOW_SOURCE_INPUTS_REQUIRED");
    if (await readSourceSelection(expectedRuntime)) throw Error("WINDOW_COMBINATION_MISMATCH");
    const bytes = await readFile(combination.file);
    if (
      digest(bytes) !== combination.sha256 ||
      (sourcesFile && (await realpath(sourcesFile)) !== (await realpath(combination.file)))
    )
      throw Error("WINDOW_SOURCE_DIGEST_MISMATCH");
    const fixed = JSON.parse(bytes);
    if (sources !== undefined && JSON.stringify(sources) !== JSON.stringify(fixed))
      throw Error("WINDOW_SOURCE_DIGEST_MISMATCH");
    const directory = await verifySnapshot(combination.snapshot);
    const entries = await resolveSourceInputs(fixed, { requireEntries: true });
    for (const entry of entries) {
      if (
        !entry.commit ||
        !entry.assets ||
        !entry.files ||
        (await realpath(entry.assets)) !==
          (await realpath(join(directory, "node_modules", entry.manifest.name))) ||
        (await realpath(entry.dependencies)) !==
          (await realpath(join(entry.assets, "node_modules")))
      )
        throw Error("WINDOW_FROZEN_ASSETS_REQUIRED");
      const owner = candidate.repositories.find((owner) => owner.repo === entry.repo);
      if (
        owner &&
        (entry.commit !== owner.head ||
          (await realpath(entry.source)) !== (await realpath(owner.path)))
      )
        throw Error("WINDOW_SOURCE_CANDIDATE_MISMATCH");
    }
  } else throw Error("WINDOW_COMBINATION_MISMATCH");
}
