import type { PluginUpdateProblem } from "./plugin-update-diagnostics.ts";
import type { CompanyPackageName } from "./plugin-release.mjs";
export type PluginPackageStamp = { name: CompanyPackageName; version: string };
export type CompiledModuleProof =
  | { kind: "active"; stamp: PluginPackageStamp; identity: string }
  | { kind: "unverified"; reason: string };
/** Constructed by the trusted public Loader/module readers, never a raw client POST. */
export type ClientModuleObservation =
  | {
      kind: "observed";
      stamp: PluginPackageStamp;
      identity: string;
      binding: {
        hostProcessIdentity: string;
        pageIdentity: string;
        nonce: string;
      };
    }
  | { kind: "unverified"; reason: string };
export type RuntimePackageProof = {
  name: CompanyPackageName;
  resolvedDir: string;
  host: CompiledModuleProof;
  client: ClientModuleObservation;
};
export type PluginUpdateStage =
  | "accepted"
  | "installing"
  | "verifying"
  | "restoring"
  | "pending-restart"
  | "completed"
  | "restored"
  | "failed"
  | "unknown";
export type PluginUpdateOperation = {
  schema: 2;
  targets?: {
    packageName: CompanyPackageName;
    targetVersion: string;
    targetSha256: string;
    archivePath: string;
  }[];
  completionProofs?: NonNullable<PluginUpdateOperation["completionProof"]>[];
  id: string;
  packageName: CompanyPackageName;
  targetVersion: string;
  targetSha256: string;
  processIdentity: string;
  stage: PluginUpdateStage;
  startedAt: string;
  updatedAt: string;
  archivePath: string;
  directory: string;
  diagnostic: string | null;
  completionProof: {
    processIdentity: string;
    host: Extract<CompiledModuleProof, { kind: "active" }>;
    client: Extract<ClientModuleObservation, { kind: "observed" }>;
  } | null;
  logs: string[];
  processes: {
    pid: number;
    grouped: boolean;
    startIdentity: string | null;
    sawAlive: boolean;
  }[];
};
export type PluginUpdateRow = {
  packageName: CompanyPackageName;
  installedVersion: string | null;
  runningHostVersion: string | null;
  runningClientVersion: string | null;
  candidateVersion: string | null;
  planId: string | null;
  state:
    | "idle"
    | "checking"
    | "check-failed"
    | "available"
    | "current"
    | "blocked"
    | "downloading"
    | "waiting-lock"
    | "snapshotting"
    | PluginUpdateStage;
  diagnostic: string | null;
  problem?: PluginUpdateProblem;
};
export type PluginUpdateSnapshot = {
  revision: number;
  items: PluginUpdateRow[];
  operation: PluginUpdateOperation | null;
};
