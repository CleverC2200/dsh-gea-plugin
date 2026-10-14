import { companyPackageNames, type CompanyPackageName } from "./plugin-release.mjs";
import type { PluginPackageStamp, PluginUpdateRow } from "./plugin-update-state.ts";

export function updateObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error("UPDATE_REQUEST_INVALID");
  return value as Record<string, unknown>;
}
export function updatePackageName(value: unknown): CompanyPackageName {
  const name = companyPackageNames.find((name) => name === value);
  if (!name) throw Error("UPDATE_PACKAGE_INVALID");
  return name;
}
export function compiledPackageStamp(value: unknown, name: CompanyPackageName): PluginPackageStamp {
  const stamp = updateObject(value);
  if (
    Object.keys(stamp).length !== 2 ||
    stamp.name !== name ||
    typeof stamp.version !== "string" ||
    !stamp.version
  )
    throw Error("UPDATE_COMPILED_STAMP_INVALID");
  return { name, version: stamp.version };
}
export type UpdateClientReport = {
  hostProcessIdentity: string;
  pageIdentity: string;
  nonce: string;
  /** Revision of the desired public graph; actual loaded identity is the ACTIVE namespace stamp. */
  modules: { stamp: PluginPackageStamp; identity: string; desiredArtifactRevision: string }[];
};
export type UpdateClientStatus = {
  revision: number;
  items: PluginUpdateRow[];
  hostProcessIdentity: string;
  challenge: string;
  checkTimeoutMs: number;
  pollIntervalMs: number;
};
export function parseUpdateClientReport(value: unknown): UpdateClientReport {
  const report = updateObject(value);
  if (
    Object.keys(report).some(
      (key) => !["hostProcessIdentity", "pageIdentity", "nonce", "modules"].includes(key),
    )
  )
    throw Error("UPDATE_REQUEST_INVALID");
  const fields = [report.hostProcessIdentity, report.pageIdentity, report.nonce];
  if (
    !fields.every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 200,
    ) ||
    !Array.isArray(report.modules) ||
    report.modules.length > 3
  )
    throw Error("UPDATE_REQUEST_INVALID");
  const modules = report.modules.map((raw) => {
    const module = updateObject(raw),
      stamp = updateObject(module.stamp);
    if (
      Object.keys(module).some(
        (key) => !["stamp", "identity", "desiredArtifactRevision"].includes(key),
      ) ||
      typeof module.identity !== "string" ||
      !module.identity ||
      module.identity.length > 200 ||
      typeof module.desiredArtifactRevision !== "string" ||
      !module.desiredArtifactRevision ||
      module.desiredArtifactRevision.length > 200
    )
      throw Error("UPDATE_REQUEST_INVALID");
    return {
      stamp: compiledPackageStamp(stamp, updatePackageName(stamp.name)),
      identity: module.identity,
      desiredArtifactRevision: module.desiredArtifactRevision,
    };
  });
  if (new Set(modules.map((module) => module.stamp.name)).size !== modules.length)
    throw Error("UPDATE_REQUEST_INVALID");
  return {
    hostProcessIdentity: report.hostProcessIdentity as string,
    pageIdentity: report.pageIdentity as string,
    nonce: report.nonce as string,
    modules,
  };
}

const states: PluginUpdateRow["state"][] = [
  "idle",
  "checking",
  "available",
  "current",
  "blocked",
  "downloading",
  "waiting-lock",
  "snapshotting",
  "accepted",
  "installing",
  "verifying",
  "restoring",
  "pending-restart",
  "completed",
  "restored",
  "failed",
  "unknown",
];
const nullableText = (value: unknown): string | null => {
  if (value === null || (typeof value === "string" && value.length <= 300)) return value;
  throw Error("UPDATE_STATUS_INVALID");
};
/** Validate Host status before publishing it into the official provider observable. */
export function parseUpdateClientStatus(raw: unknown): UpdateClientStatus {
  const value = updateObject(raw);
  if (
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    typeof value.hostProcessIdentity !== "string" ||
    !value.hostProcessIdentity ||
    typeof value.challenge !== "string" ||
    !value.challenge ||
    !Number.isSafeInteger(value.checkTimeoutMs) ||
    Number(value.checkTimeoutMs) < 1000 ||
    Number(value.checkTimeoutMs) > 120000 ||
    !Number.isSafeInteger(value.pollIntervalMs) ||
    Number(value.pollIntervalMs) < 1000 ||
    Number(value.pollIntervalMs) > 30000 ||
    !Array.isArray(value.items) ||
    value.items.length !== 3
  )
    throw Error("UPDATE_STATUS_INVALID");
  const items = value.items.map((raw) => {
    const row = updateObject(raw),
      state = states.find((state) => state === row.state);
    if (!state) throw Error("UPDATE_STATUS_INVALID");
    return {
      packageName: updatePackageName(row.packageName),
      state,
      installedVersion: nullableText(row.installedVersion),
      runningHostVersion: nullableText(row.runningHostVersion),
      runningClientVersion: nullableText(row.runningClientVersion),
      candidateVersion: nullableText(row.candidateVersion),
      planId: nullableText(row.planId),
      diagnostic: nullableText(row.diagnostic),
    };
  });
  if (new Set(items.map((row) => row.packageName)).size !== 3) throw Error("UPDATE_STATUS_INVALID");
  return {
    revision: Number(value.revision),
    items,
    hostProcessIdentity: value.hostProcessIdentity,
    challenge: value.challenge,
    checkTimeoutMs: Number(value.checkTimeoutMs),
    pollIntervalMs: Number(value.pollIntervalMs),
  };
}
