/** Read-only admission inputs for the disposable Window fixture. */
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { corePackages } from "../../scripts/source-composition.mjs";

const declaredPath = (value) => typeof value === "string" && isAbsolute(value);

export async function readSourceWindowInputs(
  inputFile = process.env.GEA_TEST_CANDIDATE_INPUTS,
) {
  if (!inputFile)
    throw Error("SOURCE_WINDOW_INPUT_REQUIRED: declare GEA_TEST_CANDIDATE_INPUTS or inputFile");
  if (!declaredPath(inputFile))
    throw Error("SOURCE_WINDOW_INPUT_ABSOLUTE_REQUIRED: inputFile");
  const input = JSON.parse(await readFile(inputFile, "utf8"));
  if (!declaredPath(input?.corePath) || !/^[a-f0-9]{40}$/.test(input?.core ?? ""))
    throw Error("SOURCE_WINDOW_CORE_REQUIRED: corePath and frozen core commit");
  const owner = (repo) => {
    const entries = Array.isArray(input.repositories)
      ? input.repositories.filter((entry) => entry?.repo === repo)
      : [];
    if (entries.length !== 1 || !declaredPath(entries[0].path) || !/^[a-f0-9]{40}$/.test(entries[0].head ?? ""))
      throw Error("SOURCE_WINDOW_OWNER_REQUIRED: " + repo);
    return entries[0];
  };
  const workbench = owner("dsh-agent-workbench");
  owner("dsh-agent-manage");
  const gea = owner("dsh-gea-plugin");
  const failure = input.historicalFailure;
  if (!declaredPath(failure?.file) || !/^[a-f0-9]{64}$/.test(failure?.sha256 ?? ""))
    throw Error("SOURCE_WINDOW_HISTORY_REQUIRED: historicalFailure file and sha256");
  const failureBytes = await readFile(failure.file);
  if (createHash("sha256").update(failureBytes).digest("hex") !== failure.sha256)
    throw Error("SOURCE_WINDOW_HISTORY_DIGEST_MISMATCH: " + failure.file);
  const checkout = await realpath(resolve(import.meta.dirname, "../.."));
  if (await realpath(gea.path) !== checkout)
    throw Error("SOURCE_WINDOW_CHECKOUT_MISMATCH: declare the GEA checkout under test " + checkout);
  const receipt = JSON.parse(execFileSync(
    process.execPath,
    [join(workbench.path, "scripts/verify-candidate-input.mjs"), "--input", inputFile, "--checkout", gea.path],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  if (receipt.status !== "passed" || receipt.core !== input.core)
    throw Error("SOURCE_WINDOW_CANDIDATE_REQUIRED: Workbench candidate input receipt");
  const core = await realpath(input.corePath);
  const coreHead = execFileSync("git", ["-C", core, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (coreHead !== input.core)
    throw Error("SOURCE_WINDOW_CORE_COMMIT_MISMATCH: " + core);
  const packages = await corePackages(core);
  const cordis = packages.filter(({ manifest }) => manifest.name === "@deepseek-ai/cordis");
  if (cordis.length !== 1)
    throw Error("SOURCE_WINDOW_CORE_PACKAGE_REQUIRED: @deepseek-ai/cordis");
  const { manifest, directory } = cordis[0];
  const types = manifest.exports?.["."]?.types ?? manifest.types;
  if (typeof types !== "string")
    throw Error("SOURCE_WINDOW_CORE_EXPORT_REQUIRED: @deepseek-ai/cordis types");
  const configuration = JSON.parse(await readFile(join(workbench.path, "tsconfig.official.json"), "utf8"));
  const declaredTypes = await realpath(resolve(workbench.path, configuration.compilerOptions.paths["@deepseek-ai/cordis"][0]));
  if (declaredTypes !== await realpath(resolve(directory, types)))
    throw Error("SOURCE_WINDOW_CORE_BINDING_MISMATCH: declared Core and Workbench SDK must be the same input");
  return {
    core,
    workbench: workbench.path,
    candidateOwners: receipt.repositories.map(({ repo }) => repo),
    historicalFailure: failure.file,
  };
}
