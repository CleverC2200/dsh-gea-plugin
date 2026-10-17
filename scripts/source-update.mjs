/** Local current-interface updates compare component baselines under the existing profile lock. */
import * as fs from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { isNewer } from "../desktop/updates.mjs";
import {
  readSourceCombination,
  readSourceCombinationRecord,
  mergeSourceComponents,
  sourceComponent,
} from "./source-profile.mjs";

/** The existing immutable release-history rule, now owned by this local source-update module. */
export function verifyReleaseHistory(channel, previous) {
  const next = { ...previous };
  for (const release of channel.releases) {
    const key = release.package + "@" + release.version;
    if (next[key] !== undefined && next[key] !== release.sha256)
      throw Error("RELEASE_VERSION_REPLACED");
    next[key] = release.sha256;
  }
  return next;
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

/** Capture the actual selected component identities, rather than an offered channel list. */
export async function readSourceUpdateBaseline(runtime, core, { io = fs } = {}) {
  const selection = JSON.parse(await io.readFile(join(runtime, "source-selection.json"), "utf8"));
  const { record, plugins, manifestSha256 } = await readSourceCombinationRecord(
    runtime,
    selection.id,
    core,
  );
  if (selection.manifestSha256 !== manifestSha256) throw Error("SOURCE_SELECTION_DIGEST_MISMATCH");
  const components = {};
  for (const name of Object.keys(record.composition.dependencies))
    components[name] = sourceComponent(record, plugins, name);
  return {
    id: selection.id,
    manifestSha256,
    core: record.core,
    components,
    compatibility: record.compatibility,
    history: selection.releaseHistory ?? {},
  };
}

/** Apply local channel artifacts; preparation failures never activate a partial combination. */
export async function applySourceUpdate(runtime, proposal, { core, io = fs }) {
  const operation = {
    id: randomUUID(),
    phase: "preparing",
    prepared: [],
    failed: [],
    activation: "unchanged",
  };
  const report = join(runtime, `source-update-${operation.id}.json`);
  let lock;
  const save = () =>
    fs.writeFile(report, JSON.stringify(operation, null, 2) + "\n", {
      mode: 0o600,
    });
  try {
    proposal = structuredClone(proposal);
    if (
      !proposal ||
      proposal.kind !== "current-source-update-v1" ||
      !Array.isArray(proposal.releases) ||
      !proposal.releases.length
    )
      throw Error("INVALID_SOURCE_UPDATE");
    const channel = fileURLToPath(proposal.source);
    const channelDirectory = await fs.realpath(resolve(channel, ".."));
    const prepared = new Map();
    for (const release of proposal.releases) {
      try {
        if (prepared.has(release.package)) throw Error("DUPLICATE_RELEASE");
        const artifact = await fs.realpath(fileURLToPath(release.url));
        if (!artifact.startsWith(channelDirectory + sep))
          throw Error("SOURCE_ARTIFACT_OUTSIDE_CHANNEL");
        const bytes = await io.readFile(artifact);
        if (digest(bytes) !== release.downloadSha256) throw Error("RELEASE_CHECKSUM_MISMATCH");
        const reference = JSON.parse(bytes);
        if (reference.package !== release.package) throw Error("SOURCE_ARTIFACT_PACKAGE_MISMATCH");
        const { record, plugins, manifestSha256 } = await readSourceCombinationRecord(
          runtime,
          reference.combination,
          core,
        );
        if (manifestSha256 !== reference.manifestSha256)
          throw Error("SOURCE_ARTIFACT_MANIFEST_MISMATCH");
        const actual = sourceComponent(record, plugins, release.package);
        if (
          actual.version !== release.version ||
          actual.sha256 !== release.sha256 ||
          !equal(actual.source, release.source)
        )
          throw Error("SOURCE_ARTIFACT_IDENTITY_MISMATCH");
        prepared.set(release.package, {
          combination: reference.combination,
          manifestSha256: reference.manifestSha256,
          actual,
          compatibility: record.compatibility?.[release.package],
          release,
        });
        operation.prepared.push(release.package);
      } catch (error) {
        operation.failed.push({
          package: release.package,
          error: error.message,
        });
      }
    }
    if (operation.failed.length) {
      operation.phase = "prepare-failed";
      await save();
      return operation;
    }
    lock = await io.open(join(runtime, "source-profile.lock"), "wx", 0o600);
    operation.phase = "validating";
    const current = await readSourceUpdateBaseline(runtime, core);
    operation.before = current;
    if (proposal.baseline.core !== current.core) throw Error("STALE_SOURCE_CORE");
    const planned = { ...current.components };
    for (const [name, candidate] of prepared) {
      const previous = current.components[name];
      if (!previous || !equal(proposal.baseline.components[name], previous))
        throw Error("STALE_SOURCE_UPDATE");
      if (candidate.actual.source.origin !== previous.source.origin)
        throw Error("SOURCE_ORIGIN_CHANGED");
      if (
        candidate.actual.version === previous.version &&
        candidate.actual.sha256 !== previous.sha256
      )
        throw Error("RELEASE_VERSION_REPLACED");
      if (!isNewer(candidate.actual.version, previous.version))
        throw Error("SOURCE_UPDATE_NOT_NEWER");
      planned[name] = candidate.actual;
    }
    const compatibility = structuredClone(current.compatibility);
    if (!compatibility) throw Error("SOURCE_COMPATIBILITY_REQUIRED");
    for (const [name, candidate] of prepared) {
      const declared = candidate.compatibility,
        advertised = candidate.release.compatible;
      if (
        declared?.interface !== "current-unified-v2" ||
        advertised?.interface !== "current-unified-v2" ||
        !Array.isArray(declared.core) ||
        !Array.isArray(advertised.core) ||
        !Array.isArray(declared.workbench) ||
        !Array.isArray(advertised.workbench)
      )
        throw Error("SOURCE_RELEASE_INCOMPATIBLE");
      compatibility[name] = {
        core: declared.core.filter((value) => advertised.core.includes(value)),
        interface: "current-unified-v2",
        workbench: declared.workbench.filter((value) => advertised.workbench.includes(value)),
      };
    }
    for (const name of Object.keys(planned)) {
      const accepted = compatibility[name];
      if (
        !accepted?.core?.includes(current.core) ||
        accepted.interface !== "current-unified-v2" ||
        !accepted.workbench?.includes(planned["@cleverc2200/dsh-agent-workbench"].version)
      )
        throw Error("SOURCE_RELEASE_INCOMPATIBLE");
    }
    const observedHistory = verifyReleaseHistory(
      {
        releases: Object.entries(current.components).map(([name, value]) => ({
          package: name,
          version: value.version,
          sha256: value.sha256,
        })),
      },
      current.history,
    );
    const history = verifyReleaseHistory(
      { releases: [...prepared.values()].map(({ release }) => release) },
      observedHistory,
    );
    operation.phase = "assembling";
    const combination = await mergeSourceComponents(
      runtime,
      current.id,
      Object.fromEntries([...prepared].map(([name, value]) => [name, value.combination])),
      core,
      {
        expectedManifests: {
          [current.id]: current.manifestSha256,
          ...Object.fromEntries(
            [...prepared.values()].map((value) => [value.combination, value.manifestSha256]),
          ),
        },
      },
    );
    operation.target = combination.id;
    const assembledRecord = await json(
      join(runtime, "source-combinations", combination.id, "combination.json"),
    );
    const assembledPlugins = await json(
      join(runtime, "source-combinations", combination.id, "company-plugins.json"),
    );
    for (const name of Object.keys(planned))
      if (!equal(sourceComponent(assembledRecord, assembledPlugins, name), planned[name]))
        throw Error("SOURCE_MERGE_IDENTITY_MISMATCH");
    assembledRecord.compatibility = compatibility;
    const assembledBytes = JSON.stringify(assembledRecord, null, 2) + "\n";
    await fs.writeFile(
      join(runtime, "source-combinations", combination.id, "combination.json"),
      assembledBytes,
    );
    const manifestSha256 = digest(assembledBytes);
    await readSourceCombination(runtime, combination.id, core);
    operation.phase = "writing";
    const temporary = join(runtime, `source-selection-${operation.id}.json`);
    await io.writeFile(
      temporary,
      JSON.stringify({
        id: combination.id,
        manifestSha256,
        releaseHistory: history,
      }) + "\n",
      { mode: 0o600 },
    );
    await io.rename(temporary, join(runtime, "source-selection.json"));
    operation.activation = "written-unverified";
    operation.phase = "reading-back";
    const actual = JSON.parse(await io.readFile(join(runtime, "source-selection.json"), "utf8"));
    if (
      actual.id !== combination.id ||
      actual.manifestSha256 !== manifestSha256 ||
      !equal(actual.releaseHistory, history)
    )
      throw Error("SOURCE_SELECTION_READBACK_MISMATCH");
    operation.after = await readSourceUpdateBaseline(runtime, core, { io });
    operation.activation = "verified";
    operation.phase = "succeeded";
  } catch (error) {
    const failedPhase = operation.phase;
    operation.phase =
      failedPhase === "writing"
        ? "write-failed"
        : failedPhase === "reading-back"
          ? "readback-failed"
          : "failed";
    operation.failed.push({ phase: failedPhase, error: error.message });
    // A rename can succeed before reporting an I/O failure; observe actual selection without retrying a write.
    if (["writing", "reading-back"].includes(failedPhase)) {
      try {
        operation.observed = await readSourceUpdateBaseline(runtime, core, {
          io,
        });
        operation.activation =
          operation.observed.id === operation.target ? "selected-unverified" : "unchanged";
      } catch (observationError) {
        operation.activation = "unknown";
        operation.observationError = observationError.message;
      }
    }
  } finally {
    if (lock) {
      await lock.close();
      await fs.unlink(join(runtime, "source-profile.lock"));
    }
  }
  await save();
  return operation;
}
