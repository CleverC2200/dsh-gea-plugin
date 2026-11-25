import {
  companyUpdatePath,
  readCompanyUpdate,
  companyUpdateActive,
  companyUpdateFinished,
} from "../../desktop/company-update.mjs";
import { sourceUpdateProblem, planUpdateProblem } from "../shared/plugin-update-diagnostics.ts";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import { runProfilePnpm } from "@deepseek-ai/dsh-plugin-manager/operations";
import { resolveBundleDir } from "@deepseek-ai/dsh-app-boot";
import type { ProfileContext } from "@deepseek-ai/dsh-app-boot";
import { mkdir, open, readFile, writeFile, realpath, rename, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  companyPackageNames,
  personalMemoryPackageName,
  updatablePackageNames,
  parsePluginRelease,
  planPluginSuiteVersions,
  type FixedCore,
  type UpdatablePackageName,
  type PluginRelease,
} from "../shared/plugin-release.mjs";
import type {
  RuntimePackageProof,
  PluginUpdateSnapshot,
  PluginUpdateOperation,
  PluginUpdateRow,
  PluginUpdateStage,
} from "../shared/plugin-update-state.ts";
import type { createPluginReleaseSource } from "./plugin-release-source.ts";
import {
  canonical,
  object,
  optionalFile,
  pluginProfileStoreDirectory,
  readPluginProfile,
  retainsProfileUpdates,
  retainsUnmanagedManifestFields,
  within,
  type ProfileSnapshot,
} from "./plugin-update-profile.ts";
import {
  profilePackageRunStopped,
  previousPackageProcessesStopped,
  observeProfilePackageProcesses,
} from "./plugin-update-processes.ts";
import { prepareWindowsPackageRun, type PluginUpdateFileCommit } from "./plugin-update-windows.ts";
import {
  openCompanyInstallation,
  type CompanyInstallation,
} from "../../desktop/company-installation.mjs";
import { companyPnpmNetworkArguments } from "../../desktop/company-pnpm.mjs";

export const pluginUpdateProcessIdentity = `${process.pid}:${performance.timeOrigin}`;
type Source = Pick<
  ReturnType<typeof createPluginReleaseSource>,
  "check" | "download" | "assertCurrentRelease"
>;
export type PluginUpdateControllerOptions = {
  profile: Pick<
    ProfileContext,
    "name" | "dir" | "installAnchor" | "cwd" | "home" | "packageManager"
  >;
  core: FixedCore;
  fileCommit?: PluginUpdateFileCommit;
  runtimeDirectory: string;
  source: Source;

  readRuntimeProofs(processIdentity: string): Promise<RuntimePackageProof[]>;
  idleTimeoutMs?: number;
  lockWaitMs?: number;
  quiescenceWaitMs?: number;
};
type Plan = { id: string; release: PluginRelease; baseline: ProfileSnapshot };
const stageNames: PluginUpdateStage[] = [
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
function fail(code: string): never {
  throw Error(code);
}
const code = (error: unknown, fallback: string) =>
  error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : fallback;
const packageFailure = (
  outcome: Awaited<ReturnType<typeof runProfilePnpm>> | null,
  cancelled: boolean,
) => {
  if (cancelled) return "HOST_CANCELLED";
  if (outcome?.timedOut) return "PACKAGE_INSTALL_TIMEOUT";
  if (
    /\b(?:ERR_PNPM_)?(?:FETCH_5\d\d|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b/.test(
      outcome?.output ?? "",
    )
  )
    return "PACKAGE_DEPENDENCY_NETWORK_FAILED";
  return "PACKAGE_INSTALL_FAILED";
};
const activeHost = (proof: RuntimePackageProof | undefined) =>
  proof?.host.kind === "active" ||
  (proof?.name === personalMemoryPackageName && proof.host.kind === "unversioned");
const initialRow = (packageName: UpdatablePackageName): PluginUpdateRow => ({
  packageName,
  installedVersion: null,
  runningHostVersion: null,
  runningClientVersion: null,
  candidateVersion: null,
  planId: null,
  state: "idle",
  diagnostic: null,
});

async function durableJson(path: string, value: unknown, commit?: PluginUpdateFileCommit) {
  const temp = path + "." + randomUUID() + ".partial",
    file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (process.platform === "win32") {
      if (!commit) throw Error("UPDATE_WINDOWS_STORAGE_UNAVAILABLE");
      await commit.replace(temp, path);
      return;
    }
    await rename(temp, path);
    const directory = await open(join(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
function parseOperation(raw: unknown): PluginUpdateOperation {
  const value = object(raw);
  if (value.installationId !== undefined && value.installationId !== value.id)
    return fail("UPDATE_JOURNAL_INVALID");
  if (
    (value.schema !== 1 && value.schema !== 2) ||
    !updatablePackageNames.some((name) => name === value.packageName) ||
    !stageNames.some((stage) => stage === value.stage)
  )
    return fail("UPDATE_JOURNAL_INVALID");
  for (const key of [
    "id",
    "targetVersion",
    "targetSha256",
    "processIdentity",
    "startedAt",
    "updatedAt",
    "archivePath",
  ])
    if (typeof value[key] !== "string") return fail("UPDATE_JOURNAL_INVALID");
  if (
    !Array.isArray(value.logs) ||
    !value.logs.every((log) => typeof log === "string") ||
    !Array.isArray(value.processes)
  )
    return fail("UPDATE_JOURNAL_INVALID");
  for (const row of value.processes) {
    const process = object(row);
    if (
      typeof process.pid !== "number" ||
      !Number.isSafeInteger(process.pid) ||
      process.pid <= 0 ||
      typeof process.grouped !== "boolean" ||
      typeof process.sawAlive !== "boolean" ||
      !(process.startIdentity === null || typeof process.startIdentity === "string")
    )
      return fail("UPDATE_JOURNAL_INVALID");
  }
  if (
    !(
      value.completionProof === null ||
      (typeof value.completionProof === "object" &&
        value.completionProof !== null &&
        typeof object(value.completionProof).processIdentity === "string")
    )
  )
    return fail("UPDATE_JOURNAL_INVALID");
  if (value.completionProof !== null) {
    const completion = object(value.completionProof),
      host = object(completion.host),
      client = object(completion.client),
      binding = object(client.binding);
    for (const proof of [host, client]) {
      const stamp = object(proof.stamp);
      if (
        stamp.name !== value.packageName ||
        stamp.version !== value.targetVersion ||
        typeof proof.identity !== "string" ||
        !proof.identity
      )
        fail("UPDATE_JOURNAL_INVALID");
    }
    if (
      host.kind !== "active" ||
      client.kind !== "observed" ||
      completion.processIdentity === value.processIdentity ||
      binding.hostProcessIdentity !== completion.processIdentity ||
      typeof binding.pageIdentity !== "string" ||
      !binding.pageIdentity ||
      typeof binding.nonce !== "string" ||
      !binding.nonce
    )
      fail("UPDATE_JOURNAL_INVALID");
  }
  let legacyFailedCompletionProofs = false;
  if (value.targets !== undefined) {
    if (
      !Array.isArray(value.targets) ||
      value.targets.length < 2 ||
      value.targets.length > updatablePackageNames.length
    )
      fail("UPDATE_JOURNAL_INVALID");
    const names = new Set();
    for (const rawTarget of value.targets) {
      const target = object(rawTarget);
      if (
        !updatablePackageNames.some((name) => name === target.packageName) ||
        names.has(target.packageName) ||
        typeof target.targetVersion !== "string" ||
        !target.targetVersion ||
        typeof target.targetSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(target.targetSha256) ||
        typeof target.archivePath !== "string" ||
        !isAbsolute(target.archivePath)
      )
        fail("UPDATE_JOURNAL_INVALID");
      names.add(target.packageName);
    }
    const first = object(value.targets[0]);
    if (
      ["packageName", "targetVersion", "targetSha256", "archivePath"].some(
        (key) => first[key] !== value[key],
      )
    )
      fail("UPDATE_JOURNAL_INVALID");
    if (value.stage === "completed") {
      if (
        !Array.isArray(value.completionProofs) ||
        value.completionProofs.length !== value.targets.length
      )
        fail("UPDATE_JOURNAL_INVALID");
      for (const [index, target] of value.targets.entries())
        parseOperation({
          ...value,
          ...object(target),
          targets: undefined,
          completionProofs: undefined,
          completionProof: value.completionProofs[index],
        });
    } else if (value.completionProofs !== undefined) {
      if (
        value.schema !== 2 ||
        value.installationId !== value.id ||
        value.stage !== "failed" ||
        value.completionProof !== null ||
        !Array.isArray(value.completionProofs) ||
        value.completionProofs.length !== value.targets.length
      )
        fail("UPDATE_JOURNAL_INVALID");
      legacyFailedCompletionProofs = true;
    }
  } else if (value.completionProofs !== undefined) fail("UPDATE_JOURNAL_INVALID");
  if (value.stage === "completed" && value.completionProof === null) fail("UPDATE_JOURNAL_INVALID");
  if (!(value.diagnostic === null || typeof value.diagnostic === "string"))
    return fail("UPDATE_JOURNAL_INVALID");
  if (value.schema === 1 && typeof value.recoveryDirectory !== "string")
    fail("UPDATE_JOURNAL_INVALID");
  const directory =
    value.schema === 1 ? join(String(value.recoveryDirectory), "..") : value.directory;
  if (typeof directory !== "string" || !isAbsolute(directory)) fail("UPDATE_JOURNAL_INVALID");
  const operation = { ...value };
  if (legacyFailedCompletionProofs) delete operation.completionProofs;
  for (const key of [
    "baselineSha256",
    "recoveryDirectory",
    "userDataSha256",
    "installedGraphSha256",
  ])
    delete operation[key];
  return { ...operation, schema: 2, directory } as PluginUpdateOperation;
}
function operationTargets(operation: PluginUpdateOperation) {
  return operation.targets ?? [operation];
}

export function createPluginUpdateController(options: PluginUpdateControllerOptions) {
  if (
    !isAbsolute(options.profile.dir) ||
    !isAbsolute(options.runtimeDirectory) ||
    (within(options.profile.dir, options.runtimeDirectory) &&
      within(join(options.profile.dir, "node_modules"), options.runtimeDirectory))
  )
    fail("UPDATE_RUNTIME_DIRECTORY_INVALID");
  if (!options.profile.packageManager?.command) fail("UPDATE_LAUNCHER_PACKAGE_MANAGER_REQUIRED");
  const runtime = options.runtimeDirectory,
    operations = join(runtime, "operations"),
    latest = join(runtime, "latest.json"),
    cache = join(runtime, "cache");
  const lifetime = new AbortController(),
    listeners = new Set<(snapshot: PluginUpdateSnapshot) => void>();
  let state: PluginUpdateSnapshot = {
    revision: 0,
    items: companyPackageNames.map(initialRow),
    operation: null,
  };
  const pendingChecks = new Set<Promise<PluginUpdateSnapshot>>();
  let initialization: Promise<PluginUpdateSnapshot> | null = null;
  let storageMaintenance = false;
  let initialized = false,
    closed = false,
    journalBroken = false,
    isolatedInstallation = false,
    checking = 0,
    active: Promise<void> | null = null;
  let startup: RuntimePackageProof[] = [];
  let candidateActivation: Awaited<ReturnType<CompanyInstallation["activationState"]>> =
    "unavailable";
  const blocking = (operation: PluginUpdateOperation | null) =>
    operation !== null &&
    (!["completed", "restored", "failed"].includes(operation.stage) ||
      (operation.stage === "completed" &&
        operation.id === state.operation?.id &&
        candidateActivation === "rolled-back"));
  let plans = new Map<UpdatablePackageName, Plan>();
  let suiteReleases: PluginRelease[] = [];
  let currentMonitor: Pick<
    Awaited<ReturnType<typeof observeProfilePackageProcesses>>,
    "capture" | "snapshot" | "waitForQuiescence" | "cancelObserved" | "close"
  > | null = null;
  function snapshot() {
    return structuredClone({
      ...state,
      items: state.items.map((item): PluginUpdateRow =>
        (item.state === "pending-restart" && candidateActivation !== "pending") ||
        (item.state === "completed" && candidateActivation === "rolled-back")
          ? {
              ...item,
              state: candidateActivation === "active" ? "confirming" : "unknown",
            }
          : item,
      ),
    });
  }
  function restartReady() {
    return (
      !active &&
      !closed &&
      !journalBroken &&
      state.operation?.stage === "pending-restart" &&
      candidateActivation === "pending"
    );
  }
  async function readCandidateSelection(operation = state.operation) {
    const installation = await openCompanyInstallation(options.profile.dir);
    const activation =
      installation && operation ? await installation.activationState(operation.id) : "unavailable";
    if (candidateActivation !== activation) {
      candidateActivation = activation;
      publish();
    }
    return installation;
  }
  function publish() {
    state = { ...state, revision: state.revision + 1 };
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {}
    }
  }
  function row(name: UpdatablePackageName, patch: Partial<PluginUpdateRow>) {
    state = {
      ...state,
      items: state.items.map((item) => (item.packageName === name ? { ...item, ...patch } : item)),
    };
    publish();
  }
  function captureStartup(proofs: RuntimePackageProof[]) {
    for (const proof of proofs) {
      const previous = startup.find((row) => row.name === proof.name);
      if (previous?.host.kind === "active" || proof.host.kind !== "active") continue;
      startup = startup.filter((row) => row.name !== proof.name).concat([structuredClone(proof)]);
    }
  }
  function reflectProfile(
    profile: ProfileSnapshot,
    proofs: RuntimePackageProof[],
    published: readonly string[] = updatablePackageNames,
  ) {
    captureStartup(proofs);
    const names = updatablePackageNames.filter(
      (name) =>
        name !== personalMemoryPackageName ||
        (published.includes(name) &&
          profile.packages.some((pkg) => pkg.name === name) &&
          activeHost(proofs.find((proof) => proof.name === name))),
    );
    state = {
      ...state,
      items: names.map((name) => {
        const item = state.items.find((row) => row.packageName === name) ?? initialRow(name);
        const installed = profile.packages.find((pkg) => pkg.root && pkg.name === item.packageName),
          host = startup.find((proof) => proof.name === item.packageName)?.host,
          client = proofs.find((proof) => proof.name === item.packageName)?.client;
        return {
          ...item,
          installedVersion: installed?.version ?? null,
          runningHostVersion: host?.kind === "active" ? host.stamp.version : null,
          runningClientVersion: client?.kind === "observed" ? client.stamp.version : null,
        };
      }),
    };
    publish();
  }
  async function readLatest() {
    const bytes = await optionalFile(latest);
    if (!bytes) return null;
    const pointer = object(JSON.parse(bytes.toString("utf8")));
    if (typeof pointer.id !== "string" || !/^[-a-f0-9]{36}$/.test(pointer.id))
      return fail("UPDATE_JOURNAL_INVALID");
    const raw: unknown = JSON.parse(
      await readFile(join(operations, pointer.id, "receipt.json"), "utf8"),
    );
    const operation = parseOperation(raw);
    if (
      operation.id !== pointer.id ||
      operation.directory !== join(operations, pointer.id) ||
      !operationTargets(operation).every((target) => within(cache, target.archivePath))
    )
      return fail("UPDATE_JOURNAL_INVALID");
    if (
      object(raw).schema === 1 &&
      !(await optionalFile(join(operation.directory, "receipt.legacy.json")))
    )
      await durableJson(join(operation.directory, "receipt.legacy.json"), raw, options.fileCommit);
    return operation;
  }
  function reflectOperation(operation: PluginUpdateOperation) {
    state = { ...state, operation };
    for (const target of operationTargets(operation))
      row(target.packageName, {
        state: operation.stage,
        diagnostic: operation.diagnostic,
        candidateVersion: target.targetVersion,
        planId: null,
      });
  }
  async function persist(operation: PluginUpdateOperation) {
    await durableJson(
      join(operations, operation.id, "receipt.json"),
      operation,
      options.fileCommit,
    );
    if (operation.stage === "pending-restart") await readCandidateSelection(operation);
    reflectOperation(operation);
  }
  async function stage(
    stage: PluginUpdateStage,
    diagnostic: string | null = null,
    extra: Partial<PluginUpdateOperation> = {},
  ) {
    if (!state.operation) return fail("UPDATE_OPERATION_MISSING");
    await persist({
      ...state.operation,
      ...extra,
      stage,
      diagnostic,
      updatedAt: new Date().toISOString(),
    });
  }
  async function reconcileRuntime() {
    const installation = await readCandidateSelection();
    if (
      installation &&
      (candidateActivation !== "rolled-back" || !blocking(state.operation)) &&
      (await installation.confirmRuntime(
        await options.readRuntimeProofs(pluginUpdateProcessIdentity),
      )) &&
      !closed &&
      !active &&
      !journalBroken &&
      !blocking(state.operation) &&
      !storageMaintenance
    ) {
      storageMaintenance = true;
      void installation.collectGarbage().then(
        (result) => {
          if (result.skipped === "store-busy" || result.skipped === "update-in-progress")
            storageMaintenance = false;
        },
        () => {},
      );
    }
    if (!initialized || active || closed || journalBroken) return snapshot();
    const currentProofs = await options.readRuntimeProofs(pluginUpdateProcessIdentity);
    captureStartup(currentProofs);
    const refreshed = state.items.map((item) => {
      const host = startup.find((proof) => proof.name === item.packageName)?.host,
        client = currentProofs.find((proof) => proof.name === item.packageName)?.client;
      return {
        ...item,
        runningHostVersion: host?.kind === "active" ? host.stamp.version : null,
        runningClientVersion: client?.kind === "observed" ? client.stamp.version : null,
      };
    });
    if (canonical(refreshed) !== canonical(state.items)) {
      state = { ...state, items: refreshed };
      publish();
    }
    const operation = state.operation;
    if (
      !operation ||
      (!["pending-restart", "unknown"].includes(operation.stage) &&
        !(operation.stage === "completed" && candidateActivation === "rolled-back"))
    )
      return snapshot();
    return withFileLock(
      join(options.profile.dir, "package.json"),
      async () => {
        const latestOperation = await readLatest();
        if (!latestOperation || latestOperation.id !== operation.id) return snapshot();
        const selectedInstallation = await readCandidateSelection(latestOperation);
        if (
          ["failed", "restored"].includes(latestOperation.stage) ||
          (latestOperation.stage === "completed" && candidateActivation !== "rolled-back")
        ) {
          reflectOperation(latestOperation);
          return snapshot();
        }
        if (!["pending-restart", "unknown", "completed"].includes(latestOperation.stage))
          return snapshot();
        if (latestOperation.installationId && candidateActivation === "rolled-back") {
          if (
            !selectedInstallation ||
            !(latestOperation.stage === "completed"
              ? profilePackageRunStopped(options.profile.dir)
              : previousPackageProcessesStopped(options.profile.dir, latestOperation)) ||
            !(await selectedInstallation.recoverRollback(latestOperation.id))
          )
            return snapshot();
          const recovered = await readLatest();
          if (recovered?.id === latestOperation.id && recovered.stage === "failed")
            reflectOperation(recovered);
          return snapshot();
        }
        if (
          latestOperation.processIdentity === pluginUpdateProcessIdentity ||
          (latestOperation.installationId && candidateActivation !== "active")
        )
          return snapshot();
        state = { ...state, operation: latestOperation };
        const profile = await readPluginProfile(options.profile.dir),
          proofs = await options.readRuntimeProofs(pluginUpdateProcessIdentity);
        reflectProfile(profile, proofs);
        if (!previousPackageProcessesStopped(options.profile.dir, latestOperation))
          return snapshot();
        const completionProofs: NonNullable<PluginUpdateOperation["completionProof"]>[] = [];
        for (const target of operationTargets(operation)) {
          const hostOwner = startup.find((proof) => proof.name === target.packageName);
          const host = hostOwner?.host;
          const client = proofs.find((proof) => proof.name === target.packageName)?.client;
          const installed = profile.packages.find((pkg) => pkg.name === target.packageName);
          if (
            installed &&
            host?.kind === "active" &&
            client?.kind === "observed" &&
            host.stamp.version === installed.version &&
            client.stamp.version === installed.version &&
            installed.version !== target.targetVersion
          ) {
            await stage("failed", "PREVIOUS_OPERATION_INTERRUPTED");
            return snapshot();
          }
          if (
            host?.kind !== "active" ||
            client?.kind !== "observed" ||
            host.stamp.name !== target.packageName ||
            host.stamp.version !== target.targetVersion ||
            client.stamp.name !== target.packageName ||
            client.stamp.version !== target.targetVersion ||
            !host.identity ||
            !client.identity ||
            client.binding.hostProcessIdentity !== pluginUpdateProcessIdentity ||
            !client.binding.pageIdentity ||
            !client.binding.nonce
          )
            return snapshot();
          if (
            !installed ||
            installed.version !== target.targetVersion ||
            !hostOwner ||
            (await realpath(hostOwner.resolvedDir)) !== installed.dir
          ) {
            await stage("unknown", "LOADED_OWNER_MISMATCH");
            return snapshot();
          }
          completionProofs.push({ processIdentity: pluginUpdateProcessIdentity, host, client });
        }
        await stage("completed", null, {
          completionProof: completionProofs[0] ?? null,
          ...(operation.targets ? { completionProofs } : {}),
        });
        return snapshot();
      },
      { waitMs: options.lockWaitMs ?? 30_000 },
    );
  }
  async function initializeState() {
    await mkdir(operations, { recursive: true, mode: 0o700 });
    try {
      isolatedInstallation = Boolean(await openCompanyInstallation(options.profile.dir));
      await withFileLock(
        join(options.profile.dir, "package.json"),
        async () => {
          const initialProofs = await options.readRuntimeProofs(pluginUpdateProcessIdentity);
          reflectProfile(await readPluginProfile(options.profile.dir), initialProofs);
          state = { ...state, operation: await readLatest() };
          if (state.operation) {
            for (const target of operationTargets(state.operation))
              row(target.packageName, {
                state: state.operation.stage,
                diagnostic: state.operation.diagnostic,
                candidateVersion: target.targetVersion,
              });
            if (
              state.operation.stage === "accepted" &&
              state.operation.processIdentity !== pluginUpdateProcessIdentity &&
              state.operation.processes.length === 0 &&
              profilePackageRunStopped(options.profile.dir)
            )
              await stage("failed", "PREVIOUS_OPERATION_INTERRUPTED");
            else if (
              state.operation.installationId &&
              ["accepted", "installing", "verifying", "unknown"].includes(state.operation.stage) &&
              state.operation.processIdentity !== pluginUpdateProcessIdentity
            )
              await stage("failed", "PREVIOUS_PREPARATION_INTERRUPTED");
            else if (
              ["accepted", "installing", "verifying", "restoring"].includes(state.operation.stage)
            )
              await stage("unknown", "PREVIOUS_OPERATION_INTERRUPTED");
          }
        },
        { waitMs: options.lockWaitMs ?? 30_000 },
      );
    } catch {
      journalBroken = true;
      state = {
        ...state,
        items: state.items.map((item) => ({
          ...item,
          state: isolatedInstallation ? "failed" : "unknown",
          diagnostic: "UPDATE_JOURNAL_UNREADABLE",
        })),
      };
      publish();
    }
    initialized = true;
    await reconcileRuntime();
    return snapshot();
  }
  function initialize() {
    initialization ??= initializeState();
    return initialization;
  }
  async function checkState(signal?: AbortSignal) {
    if (!initialized) await initialize();
    if (closed) fail("UPDATE_HOST_CLOSED");
    if (active || journalBroken || blocking(state.operation)) return snapshot();
    const generation = ++checking;
    plans.clear();
    suiteReleases = [];
    state = {
      ...state,
      items: state.items.map((item) => ({
        ...item,
        state: "checking",
        diagnostic: null,
        planId: null,
        candidateVersion: null,
        problem: undefined,
      })),
    };
    publish();
    try {
      const profile = await withFileLock(
        join(options.profile.dir, "package.json"),
        () => readPluginProfile(options.profile.dir),
        { waitMs: options.lockWaitMs ?? 30_000 },
      );
      const published = (
        await options.source.check(
          signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
        )
      ).map(parsePluginRelease);
      if (generation !== checking || closed) return snapshot();
      const proofs = await options.readRuntimeProofs(pluginUpdateProcessIdentity);
      if (generation !== checking || closed) return snapshot();
      reflectProfile(
        profile,
        proofs,
        published.map((release) => release.name),
      );
      const releases = published.filter((release) =>
        state.items.some((item) => item.packageName === release.name),
      );
      for (const name of companyPackageNames) {
        if (!releases.some((release) => release.name === name))
          row(name, {
            state: "blocked",
            diagnostic: "RELEASE_NOT_PUBLISHED",
            problem: { kind: "policy", code: "release-not-published" },
          });
      }
      const installed = profile.packages;
      const plan = planPluginSuiteVersions({ releases, core: options.core, installed });
      if (
        plan.kind === "current" &&
        state.items.every((item) => {
          const release = releases.find((release) => release.name === item.packageName);
          return (
            release &&
            item.installedVersion === release.version &&
            item.runningHostVersion === release.version &&
            item.runningClientVersion === release.version
          );
        })
      ) {
        for (const release of releases)
          row(release.name, {
            candidateVersion: release.version,
            state: "current",
            diagnostic: null,
          });
        return snapshot();
      }
      if (generation !== checking || closed) return snapshot();
      if (!(await openCompanyInstallation(options.profile.dir))) {
        for (const release of releases)
          row(release.name, {
            candidateVersion: release.version,
            state: "blocked",
            diagnostic: "UPDATE_DESKTOP_INSTALLATION_REQUIRED",
            problem: { kind: "policy", code: "desktop-installation" },
          });
        return snapshot();
      }
      for (const rawRelease of releases) {
        const release = parsePluginRelease(rawRelease);
        row(release.name, { candidateVersion: release.version });
        const selected = profile.packages.find((pkg) => pkg.root && pkg.name === release.name);
        if (!selected) {
          row(release.name, {
            state: "blocked",
            diagnostic: "PACKAGE_NOT_INSTALLED",
          });
          continue;
        }
        const resolved = await realpath(
          resolveBundleDir("dsh", release.name, options.profile.installAnchor, options.profile.dir),
        );
        const nodeModules = await realpath(join(options.profile.dir, "node_modules"));
        if (generation !== checking || closed) return snapshot();
        if (resolved !== selected.dir || !within(nodeModules, resolved)) {
          row(release.name, {
            state: "blocked",
            diagnostic: "INSTALL_ANCHOR_SHADOWED",
          });
          continue;
        }
        if (!activeHost(proofs.find((proof) => proof.name === release.name))) {
          row(release.name, {
            state: "blocked",
            candidateVersion: release.version,
            diagnostic: "UPDATE_PACKAGE_INACTIVE",
            problem: { kind: "policy", code: "inactive" },
          });
          continue;
        }
      }
      if (state.items.some((item) => item.state === "blocked")) {
        for (const item of state.items)
          if (item.state !== "blocked")
            row(item.packageName, {
              state: "blocked",
              diagnostic: "UPDATE_SUITE_BLOCKED",
              problem: { kind: "policy", code: "conditions" },
            });
        return snapshot();
      }
      if (plan.kind === "blocked") {
        const release =
          releases.find((release) => release.name === plan.packageName) ?? releases[0];
        for (const { packageName: name } of state.items)
          row(name, {
            state: "blocked",
            diagnostic: plan.code,
            problem: release
              ? planUpdateProblem(plan, release, options.core, installed, releases)
              : { kind: "policy", code: "release-not-published" },
          });
      } else {
        suiteReleases = releases;
        for (const release of releases) {
          if (
            plan.kind === "ready" &&
            plan.releases.some((changed) => changed.name === release.name)
          ) {
            const id = randomUUID();
            plans.set(release.name, { id, release, baseline: profile });
            row(release.name, { state: "available", planId: id, diagnostic: null });
          } else row(release.name, { state: "current", diagnostic: null });
        }
      }
    } catch (error) {
      if (generation === checking && !closed) {
        plans.clear();
        state = {
          ...state,
          items: state.items.map((item) => ({
            ...item,
            state: code(error, "SOURCE_CHECK_FAILED").startsWith("SOURCE_")
              ? "check-failed"
              : "blocked",
            diagnostic: code(error, "SOURCE_CHECK_FAILED"),
            problem: code(error, "SOURCE_CHECK_FAILED").startsWith("SOURCE_")
              ? sourceUpdateProblem(code(error, "SOURCE_CHECK_FAILED"))
              : { kind: "policy", code: "conditions" },
            planId: null,
            candidateVersion: null,
          })),
        };
        publish();
      }
    }
    return snapshot();
  }
  function check(signal?: AbortSignal) {
    const pending = checkState(signal);
    pendingChecks.add(pending);
    void pending.finally(() => pendingChecks.delete(pending)).catch(() => undefined);
    return pending;
  }
  function submit(request: { packageName: UpdatablePackageName; planId: string }) {
    return submitBatch([request]);
  }
  async function submitBatch(
    requests: readonly { packageName: UpdatablePackageName; planId: string }[],
  ): Promise<PluginUpdateOperation> {
    if (!initialized) await initialize();
    const company = await readCompanyUpdate(options.profile.dir);
    if (closed) fail("UPDATE_HOST_CLOSED");
    if (active || journalBroken || blocking(state.operation) || companyUpdateActive(company))
      fail("UPDATE_OPERATION_BLOCKED");
    if (
      !requests.length ||
      requests.length > updatablePackageNames.length ||
      new Set(requests.map((request) => request.packageName)).size !== requests.length
    )
      fail("UPDATE_REQUEST_INVALID");
    for (const request of requests) {
      const plan = plans.get(request.packageName);
      if (!plan || plan.id !== request.planId) fail("UPDATE_PLAN_STALE");
    }
    const selected = [...plans.values()];
    const selectedSuite = suiteReleases;
    const plan = selected[0];
    if (!plan) fail("UPDATE_REQUEST_INVALID");
    ++checking;
    let accept: (operation: PluginUpdateOperation) => void = () => {},
      reject: (error: unknown) => void = () => {};
    const accepted = new Promise<PluginUpdateOperation>((yes, no) => {
      accept = yes;
      reject = no;
    });
    const operationTask = async () => {
      try {
        const downloads: { release: PluginRelease; archivePath: string }[] = [];
        for (const selectedPlan of selected) {
          row(selectedPlan.release.name, { state: "downloading", diagnostic: null });
          downloads.push({
            release: selectedPlan.release,
            archivePath: await options.source.download(
              selectedPlan.release,
              cache,
              lifetime.signal,
            ),
          });
        }
        const archive = downloads[0]?.archivePath;
        if (!archive) fail("UPDATE_REQUEST_INVALID");
        for (const selectedPlan of selected)
          row(selectedPlan.release.name, { state: "waiting-lock" });
        await withFileLock(
          join(options.profile.dir, "package.json"),
          async () => {
            lifetime.signal.throwIfAborted();
            const diskOperation = await readLatest();
            if (
              blocking(diskOperation) ||
              companyUpdateActive(await readCompanyUpdate(options.profile.dir))
            )
              fail("UPDATE_OPERATION_BLOCKED");
            const baseline = await readPluginProfile(options.profile.dir);
            if (selected.some((selectedPlan) => baseline.sha256 !== selectedPlan.baseline.sha256))
              fail("UPDATE_BASELINE_CHANGED");
            const direct = object(baseline.manifest.dependencies ?? {});
            const runtimeProofs = await options.readRuntimeProofs(pluginUpdateProcessIdentity);
            const manifests = baseline.packages;
            for (const release of selectedSuite) {
              if (!activeHost(runtimeProofs.find((proof) => proof.name === release.name)))
                fail("UPDATE_PACKAGE_INACTIVE");
              if (!Object.hasOwn(direct, release.name)) fail("PACKAGE_NOT_INSTALLED");
              const resolved = await realpath(
                resolveBundleDir(
                  "dsh",
                  release.name,
                  options.profile.installAnchor,
                  options.profile.dir,
                ),
              );
              if (!within(await realpath(join(options.profile.dir, "node_modules")), resolved))
                fail("INSTALL_ANCHOR_SHADOWED");
            }
            const suitePlan = planPluginSuiteVersions({
              releases: selectedSuite,
              core: options.core,
              installed: manifests,
            });
            if (
              suitePlan.kind !== "ready" ||
              suitePlan.releases.length !== selected.length ||
              suitePlan.releases.some(
                (release) => !selected.some((entry) => entry.release === release),
              )
            )
              fail("UPDATE_COMBINATION_CHANGED");
            if (!profilePackageRunStopped(options.profile.dir)) fail("PROFILE_WRITER_UNCONFIRMED");
            const store = await pluginProfileStoreDirectory(options.profile.dir);
            if (
              process.platform === "win32" &&
              !options.profile.packageManager?.command.toLowerCase().endsWith(".exe")
            )
              fail("UPDATE_WINDOWS_LAUNCHER_UNSUPPORTED");
            const id = randomUUID(),
              operationDirectory = join(operations, id);
            await mkdir(operationDirectory, { mode: 0o700 });
            const installation = await openCompanyInstallation(options.profile.dir);
            if (!installation) fail("UPDATE_DESKTOP_INSTALLATION_REQUIRED");
            lifetime.signal.throwIfAborted();
            for (const release of selectedSuite) options.source.assertCurrentRelease(release);
            const operation: PluginUpdateOperation = {
              schema: 2,
              installationId: id,
              ...(downloads.length > 1
                ? {
                    targets: downloads.map(({ release, archivePath }) => ({
                      packageName: release.name,
                      targetVersion: release.version,
                      targetSha256: release.artifact.sha256,
                      archivePath,
                    })),
                  }
                : {}),
              id,
              packageName: plan.release.name,
              targetVersion: plan.release.version,
              targetSha256: plan.release.artifact.sha256,
              processIdentity: pluginUpdateProcessIdentity,
              stage: "accepted",
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              archivePath: archive,
              directory: operationDirectory,
              diagnostic: null,
              completionProof: null,
              logs: [],
              processes: [],
            };
            await persist(operation);
            await durableJson(latest, { schema: 1, id }, options.fileCommit);
            plans.clear();
            state = {
              ...state,
              items: state.items.map((item) =>
                selected.some((selectedPlan) => selectedPlan.release.name === item.packageName)
                  ? item
                  : {
                      ...item,
                      planId: null,
                      state: "blocked",
                      diagnostic: "UPDATE_OPERATION_IN_PROGRESS",
                    },
              ),
            };
            publish();
            accept(structuredClone(operation));
            await stage("installing");
            lifetime.signal.throwIfAborted();
            for (const release of selectedSuite) options.source.assertCurrentRelease(release);
            await installation.prepare(
              id,
              async (directory, { registerProcess }) => {
                const baseline = await readPluginProfile(directory);
                const windowsRun =
                  process.platform === "win32"
                    ? await prepareWindowsPackageRun(
                        operationDirectory,
                        directory,
                        options.profile.installAnchor,
                        options.core.version,
                        options.profile.packageManager,
                        async (observation) => {
                          await registerProcess(observation.pid);
                          await stage("installing", null, { processes: [observation] });
                        },
                      )
                    : null;
                currentMonitor = windowsRun ?? (await observeProfilePackageProcesses(directory));
                let outcome: Awaited<ReturnType<typeof runProfilePnpm>> | null = null,
                  installationError: unknown = null;
                try {
                  outcome = await runProfilePnpm(
                    {
                      profile: options.profile.name,
                      dir: directory,
                      installAnchor: options.profile.installAnchor,
                      cwd: options.profile.cwd,
                      home: options.profile.home,
                    },
                    [
                      "add",
                      ...downloads.map(({ archivePath }) => "file:" + archivePath),
                      "--store-dir=" + store,
                      "--save-exact",
                      "--ignore-scripts",
                      "--ignore-pnpmfile",
                      "--config.auto-install-peers=false",
                      "--config.update-notifier=false",
                      ...companyPnpmNetworkArguments,
                    ],
                    {
                      ...(windowsRun?.packageManager ?? options.profile.packageManager),
                      execution: "service",
                      signal: lifetime.signal,
                      outputBytes: 16_000,
                      activateNewBundles: false,
                      idleTimeoutMs: options.idleTimeoutMs ?? 90_000,
                      lookupTimeoutMs: 20_000,
                      onOutput: () => currentMonitor?.capture(),
                    },
                  );
                } catch (error) {
                  installationError = error;
                }
                await currentMonitor.capture();
                const processes = currentMonitor.snapshot();
                if (outcome?.logPath) {
                  const saved = join(operationDirectory, "pnpm.log");
                  await writeFile(saved, await readFile(outcome.logPath), { mode: 0o600 });
                  operation.logs = [saved];
                }
                let stopped = await currentMonitor.waitForQuiescence(
                  options.quiescenceWaitMs ?? 2_000,
                );
                if (!stopped) {
                  currentMonitor.cancelObserved();
                  stopped = await currentMonitor.waitForQuiescence(
                    options.quiescenceWaitMs ?? 2_000,
                  );
                  throw Error(
                    stopped ? "PACKAGE_WRITERS_INTERRUPTED" : "PACKAGE_WRITERS_UNCONFIRMED",
                  );
                }
                await stage("verifying", null, { logs: operation.logs, processes });
                if (!stopped) throw Error("PACKAGE_WRITERS_UNCONFIRMED");
                else {
                  const after = await readPluginProfile(directory);
                  if (!retainsUnmanagedManifestFields(baseline, after))
                    throw Error("PROFILE_SETTINGS_OWNERSHIP_UNCONFIRMED");
                  else if (
                    installationError ||
                    !outcome ||
                    outcome.exitCode !== 0 ||
                    outcome.timedOut ||
                    lifetime.signal.aborted
                  )
                    throw Error(packageFailure(outcome, lifetime.signal.aborted));
                  else if (
                    !retainsProfileUpdates(baseline, after, downloads) ||
                    downloads.some(
                      ({ release }) =>
                        !after.packages.some(
                          (pkg) => pkg.name === release.name && pkg.version === release.version,
                        ),
                    )
                  )
                    throw Error("PACKAGE_POSTCHECK_FAILED");
                }
              },
              lifetime.signal,
            );
            await stage("pending-restart", null, { logs: operation.logs });
          },
          { waitMs: options.lockWaitMs ?? 30_000 },
        );
      } catch (error) {
        plans.clear();
        state = {
          ...state,
          items: state.items.map((item) => ({ ...item, planId: null })),
        };
        for (const selectedPlan of selected)
          row(selectedPlan.release.name, {
            state: "failed",
            diagnostic: code(
              error,
              lifetime.signal.aborted ? "HOST_CANCELLED" : "UPDATE_PREPARATION_FAILED",
            ),
            planId: null,
          });
        if (
          state.operation &&
          ["accepted", "installing", "verifying"].includes(state.operation.stage)
        )
          try {
            await stage("failed", code(error, "UPDATE_PREPARATION_FAILED"));
          } catch {
            journalBroken = true;
            state = {
              ...state,
              operation: {
                ...state.operation!,
                stage: "failed",
                diagnostic: "UPDATE_RECEIPT_WRITE_FAILED",
              },
            };
          }
        reject(error);
      } finally {
        if (state.operation?.stage !== "unknown") {
          currentMonitor?.close();
          currentMonitor = null;
        }
      }
    };
    active = operationTask().finally(() => {
      active = null;
      publish();
    });
    void active.catch(() => undefined);
    return accepted;
  }
  async function prepareDesktop(desktopVersion: string) {
    if (!initialized) await initialize();
    if (closed || active || journalBroken || blocking(state.operation))
      fail("UPDATE_OPERATION_BLOCKED");
    if (!process.env.GEA_DESKTOP_VERSION || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(desktopVersion))
      fail("UPDATE_DESKTOP_UNAVAILABLE");
    const run = async () => {
      const previous = await readCompanyUpdate(options.profile.dir);
      if (companyUpdateActive(previous)) {
        if (previous?.phase === "prepared" && previous.desktopVersion === desktopVersion) return;
        fail("UPDATE_OPERATION_BLOCKED");
      }
      const releases = (await options.source.check(lifetime.signal))
        .map(parsePluginRelease)
        .filter((release) => companyPackageNames.some((name) => name === release.name));
      if (
        releases.length !== 3 ||
        !companyPackageNames.every(
          (name) => releases.filter((row) => row.name === name).length === 1,
        ) ||
        releases.some((row) => row.dataCompatibility.kind !== "preserve")
      )
        fail("UPDATE_SUITE_UNAVAILABLE");
      for (const release of releases) {
        row(release.name, { state: "downloading" });
        await options.source.download(release, cache, lifetime.signal);
      }
      await withFileLock(
        join(options.profile.dir, "package.json"),
        async () => {
          if (
            blocking(await readLatest()) ||
            companyUpdateActive(await readCompanyUpdate(options.profile.dir)) ||
            !profilePackageRunStopped(options.profile.dir)
          )
            fail("UPDATE_OPERATION_BLOCKED");
          for (const release of releases) options.source.assertCurrentRelease(release);
          if (runtime !== join(options.profile.dir, "gea/plugin-updates"))
            fail("UPDATE_RUNTIME_DIRECTORY_INVALID");
          if (previous)
            await durableJson(
              join(runtime, "company-update-" + previous.id + ".json"),
              previous,
              options.fileCommit,
            );
          await durableJson(
            companyUpdatePath(options.profile.dir),
            {
              schema: 1,
              id: randomUUID(),
              phase: "prepared",
              desktopVersion,
              processIdentity: pluginUpdateProcessIdentity,
              expected: null,
              targets: releases.map((release) => ({
                name: release.name,
                version: release.version,
                sha256: release.artifact.sha256,
                supportedCores: release.supportedCores,
              })),
            },
            options.fileCommit,
          );
        },
        { waitMs: options.lockWaitMs ?? 30_000 },
      );
    };
    const previousItems = state.items;
    active = run();
    try {
      await active;
    } finally {
      active = null;
      state = { ...state, items: previousItems };
      publish();
    }
  }
  async function companyStatus() {
    const receipt = await readCompanyUpdate(options.profile.dir);
    if (
      receipt?.phase === "completed" &&
      !companyUpdateFinished(
        { ...receipt, phase: "verifying" },
        process.env.GEA_DESKTOP_VERSION,
        pluginUpdateProcessIdentity,
        state.items,
      )
    )
      return null;
    return receipt ? { phase: receipt.phase, desktopVersion: receipt.desktopVersion } : null;
  }
  async function cancelDesktop() {
    if (active) fail("UPDATE_OPERATION_BLOCKED");
    await withFileLock(
      join(options.profile.dir, "package.json"),
      async () => {
        if (active) fail("UPDATE_OPERATION_BLOCKED");
        const receipt = await readCompanyUpdate(options.profile.dir);
        if (!receipt || receipt.phase === "cancelled" || receipt.phase === "completed") {
          if (!profilePackageRunStopped(options.profile.dir)) fail("UPDATE_OPERATION_BLOCKED");
          const running = await readLatest().then(blocking, async (error: unknown) => {
            if (!isolatedInstallation || blocking(state.operation)) throw error;
            const installation = await openCompanyInstallation(options.profile.dir);
            return !installation || !(await installation.preparationIdle());
          });
          if (running || active) fail("UPDATE_OPERATION_BLOCKED");
          return;
        }
        if (receipt.phase !== "prepared" && receipt.phase !== "failed")
          fail("UPDATE_OPERATION_BLOCKED");
        await durableJson(
          companyUpdatePath(options.profile.dir),
          { ...receipt, phase: "cancelled" },
          options.fileCommit,
        );
      },
      { waitMs: options.lockWaitMs ?? 30_000 },
    );
    publish();
  }
  async function confirmDesktop() {
    if (
      active ||
      (await readCompanyUpdate(options.profile.dir).catch(() => null))?.phase !== "verifying"
    )
      return;
    await withFileLock(
      join(options.profile.dir, "package.json"),
      async () => {
        const receipt = await readCompanyUpdate(options.profile.dir).catch(() => null);
        if (
          companyUpdateFinished(
            receipt,
            process.env.GEA_DESKTOP_VERSION,
            pluginUpdateProcessIdentity,
            state.items,
          )
        )
          await durableJson(
            companyUpdatePath(options.profile.dir),
            { ...receipt, phase: "completed" },
            options.fileCommit,
          );
      },
      { waitMs: options.lockWaitMs ?? 30_000 },
    );
  }
  async function dispose() {
    if (closed)
      return {
        kind: state.operation?.stage === "unknown" ? "unknown" : "stopped",
      } as const;
    closed = true;
    listeners.clear();
    lifetime.abort();
    if (initialization) await initialization;
    await Promise.allSettled(pendingChecks);
    currentMonitor?.cancelObserved();
    if (active) await active;
    if (currentMonitor) {
      currentMonitor.cancelObserved();
      await currentMonitor.waitForQuiescence(options.quiescenceWaitMs ?? 2_000);
      currentMonitor.close();
      currentMonitor = null;
    }
    return {
      kind: state.operation?.stage === "unknown" ? "unknown" : "stopped",
    } as const;
  }
  return {
    initialize,
    prepareDesktop,
    cancelDesktop,
    companyStatus,
    confirmDesktop,
    check,
    submit,
    submitBatch,
    reconcileRuntime,
    snapshot,
    operationStatus(operationId?: string): {
      operationId: string | null;
      state: "idle" | "running" | "ready" | "failed" | "unknown";
    } {
      const operation = state.operation;
      if (operationId && operation?.id !== operationId) return { operationId, state: "unknown" };
      const id = operation?.id ?? null;
      if (journalBroken && isolatedInstallation) return { operationId: id, state: "failed" };
      if (
        closed ||
        journalBroken ||
        operation?.stage === "unknown" ||
        (operation?.stage === "completed" && blocking(operation))
      )
        return { operationId: id, state: "unknown" };
      if (active) return { operationId: id, state: "running" };
      if (!operation || operation.stage === "completed") return { operationId: id, state: "idle" };
      if (operation.stage === "pending-restart")
        return {
          operationId: id,
          state: restartReady()
            ? "ready"
            : candidateActivation === "active"
              ? "running"
              : "unknown",
        };
      if (operation.stage === "failed" || operation.stage === "restored")
        return { operationId: id, state: "failed" };
      return { operationId: id, state: "unknown" };
    },
    restartReady,
    subscribe(listener: (snapshot: PluginUpdateSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose,
  };
}
