/** Freeze only an explicitly prepared, disposable loopback engineering profile. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import {
  prepareSourcePlugins,
  readSourceSelection,
  selectSourceCombination,
} from "../../scripts/source-profile.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (file, value) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
export async function freezeProfileWindow({
  directory,
  runtime,
  config,
  deployment,
  sources,
  caseName,
  coreOnly,
  signal,
  recordLifecycle = () => {},
}) {
  signal?.throwIfAborted();
  const core = resolve(import.meta.dirname, "../../../../official-latest-standard");
  const candidateFile = process.env.GEA_TEST_CANDIDATE;
  if (!candidateFile) throw Error("PROFILE_CANDIDATE_REQUIRED");
  const candidate = { file: candidateFile, sha256: digest(await readFile(candidateFile)) };
  let combination = { kind: "core" };
  if (!coreOnly) {
    let selected = await readSourceSelection(runtime);
    if (!selected) {
      const composition = await prepareSourcePlugins(core, runtime, deployment, { sources });
      signal?.throwIfAborted();
      recordLifecycle({ event: "source-prepared" });
      await selectSourceCombination(runtime, composition.id, core);
      recordLifecycle({ event: "source-selected" });
      selected = await readSourceSelection(runtime);
    }
    signal?.throwIfAborted();
    combination = { kind: "selection", ...selected };
  }
  const budget = {
    limits: { hostStarts: 1, businessRequests: 0, modelTasks: 0, businessWrites: 0 },
    remaining: { hostStarts: 1, businessRequests: 0, modelTasks: 0, businessWrites: 0 },
  };
  const freeze = resolve(directory, "fixture-freeze.json");
  const frozen = {
    file: basename(freeze),
    case: caseName,
    owner: "local-loopback-test",
    mode: coreOnly ? "isolated-core-host" : "source-host",
    core,
    runtime,
    candidate,
    combination,
    budget,
    ...(!coreOnly
      ? {
          config: { file: config, sha256: digest(await readFile(config)) },
          deploymentSha256: digest(JSON.stringify(deployment)),
        }
      : {}),
  };
  signal?.throwIfAborted();
  await save(freeze, frozen);
  const file = resolve(directory, "fixture-window.json");
  signal?.throwIfAborted();
  await save(file, {
    status: "open",
    paused: false,
    case: frozen.case,
    owner: frozen.owner,
    budget,
    freeze: { file: freeze },
  });
  const window = {
    file,
    case: frozen.case,
    owner: frozen.owner,
    freezeSha256: digest(await readFile(freeze)),
  };
  const request = resolve(directory, "fixture-window-request.json");
  signal?.throwIfAborted();
  await save(request, window);
  return { window, request };
}
