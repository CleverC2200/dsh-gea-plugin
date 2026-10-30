import { sourceUpdateProblem, planUpdateProblem } from "../shared/plugin-update-diagnostics.ts";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import { runProfilePnpm } from "@deepseek-ai/dsh-plugin-manager/operations";
import { resolveBundleDir } from "@deepseek-ai/dsh-app-boot";
import type { ProfileContext } from "@deepseek-ai/dsh-app-boot";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  companyPackageNames,
  parsePluginRelease,
  planPluginSuiteVersions,
  type FixedCore,
  type CompanyPackageName,
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

/** Stable for the lifetime of this Node process, including Controller recreation in the same process. */
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
  /** Trusted startup Loader namespace and materialized client proof reader supplied by 04. */
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
const blocking = (operation: PluginUpdateOperation | null) =>
  operation !== null && !["completed", "restored", "failed"].includes(operation.stage);
function fail(code: string): never {
  throw Error(code);
}
const code = (error: unknown, fallback: string) =>
  error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : fallback;

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
  if (
    (value.schema !== 1 && value.schema !== 2) ||
    !companyPackageNames.some((name) => name === value.packageName) ||
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
  if (value.targets !== undefined) {
    if (
      !Array.isArray(value.targets) ||
      value.targets.length < 2 ||
      value.targets.length > companyPackageNames.length
    )
      fail("UPDATE_JOURNAL_INVALID");
    const names = new Set();
    for (const rawTarget of value.targets) {
      const target = object(rawTarget);
      if (
        !companyPackageNames.some((name) => name === target.packageName) ||
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
    } else if (value.completionProofs !== undefined) fail("UPDATE_JOURNAL_INVALID");
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
    items: companyPackageNames.map((name) => ({
      packageName: name,
      installedVersion: null,
      runningHostVersion: null,
      runningClientVersion: null,
      candidateVersion: null,
      planId: null,
      state: "idle",
      diagnostic: null,
    })),
    operation: null,
  };
  const pendingChecks = new Set<Promise<PluginUpdateSnapshot>>();
  let initialization: Promise<PluginUpdateSnapshot> | null = null;
  let initialized = false,
    closed = false,
    journalBroken = false,
    checking = 0,
    active: Promise<void> | null = null;
  let startup: RuntimePackageProof[] = [],
    mutationInThisController = false;
  let plans = new Map<CompanyPackageName, Plan>();
  let suiteReleases: PluginRelease[] = [];
  let currentMonitor: Pick<
    Awaited<ReturnType<typeof observeProfilePackageProcesses>>,
    "capture" | "snapshot" | "waitForQuiescence" | "cancelObserved" | "close"
  > | null = null;
  function snapshot() {
    return structuredClone(state);
  }
  function publish() {
    state = { ...state, revision: state.revision + 1 };
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {
        /* A view subscriber cannot cancel accepted Host work. */
      }
    }
  }
  function row(name: CompanyPackageName, patch: Partial<PluginUpdateRow>) {
    state = {
      ...state,
      items: state.items.map((item) => (item.packageName === name ? { ...item, ...patch } : item)),
    };
    publish();
  }
  function captureStartup(proofs: RuntimePackageProof[]) {
    if (mutationInThisController) return;
    for (const proof of proofs) {
      const previous = startup.find((row) => row.name === proof.name);
      if (previous?.host.kind === "active" || proof.host.kind !== "active") continue;
      startup = startup.filter((row) => row.name !== proof.name).concat([structuredClone(proof)]);
    }
  }
  function reflectProfile(profile: ProfileSnapshot, proofs: RuntimePackageProof[]) {
    captureStartup(proofs);
    state = {
      ...state,
      items: state.items.map((item) => {
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
  async function persist(operation: PluginUpdateOperation) {
    await durableJson(
      join(operations, operation.id, "receipt.json"),
      operation,
      options.fileCommit,
    );
    state = { ...state, operation };
    for (const target of operationTargets(operation))
      row(target.packageName, {
        state: operation.stage,
        diagnostic: operation.diagnostic,
        candidateVersion: target.targetVersion,
        planId: null,
      });
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
      !["pending-restart", "unknown"].includes(operation.stage) ||
      operation.processIdentity === pluginUpdateProcessIdentity
    )
      return snapshot();
    return withFileLock(
      join(options.profile.dir, "package.json"),
      async () => {
        const latestOperation = await readLatest();
        if (
          !latestOperation ||
          latestOperation.id !== operation.id ||
          !["pending-restart", "unknown"].includes(latestOperation.stage)
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
          state: "unknown",
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
      const releases = (
        await options.source.check(
          signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
        )
      ).map(parsePluginRelease);
      if (generation !== checking || closed) return snapshot();
      const proofs = await options.readRuntimeProofs(pluginUpdateProcessIdentity);
      if (generation !== checking || closed) return snapshot();
      reflectProfile(profile, proofs);
      for (const name of companyPackageNames) {
        if (!releases.some((release) => release.name === name))
          row(name, {
            state: "blocked",
            diagnostic: "RELEASE_NOT_PUBLISHED",
            problem: { kind: "policy", code: "release-not-published" },
          });
      }
      const installed = profile.packages;
      if (generation !== checking || closed) return snapshot();
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
        if (proofs.find((proof) => proof.name === release.name)?.host.kind !== "active") {
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
      const plan = planPluginSuiteVersions({ releases, core: options.core, installed });
      if (plan.kind === "blocked") {
        const release =
          releases.find((release) => release.name === plan.packageName) ?? releases[0];
        for (const name of companyPackageNames)
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
  function submit(request: { packageName: CompanyPackageName; planId: string }) {
    return submitBatch([request]);
  }
  async function submitBatch(
    requests: readonly { packageName: CompanyPackageName; planId: string }[],
  ): Promise<PluginUpdateOperation> {
    if (!initialized) await initialize();
    if (closed) fail("UPDATE_HOST_CLOSED");
    if (active || journalBroken || blocking(state.operation)) fail("UPDATE_OPERATION_BLOCKED");
    if (
      !requests.length ||
      requests.length > companyPackageNames.length ||
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
      let mutationStarted = false;
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
            if (blocking(diskOperation)) fail("UPDATE_OPERATION_BLOCKED");
            const baseline = await readPluginProfile(options.profile.dir);
            if (selected.some((selectedPlan) => baseline.sha256 !== selectedPlan.baseline.sha256))
              fail("UPDATE_BASELINE_CHANGED");
            const direct = object(baseline.manifest.dependencies ?? {});
            const runtimeProofs = await options.readRuntimeProofs(pluginUpdateProcessIdentity);
            const manifests = baseline.packages;
            for (const release of selectedSuite) {
              if (
                runtimeProofs.find((proof) => proof.name === release.name)?.host.kind !== "active"
              )
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
            const id = randomUUID(),
              operationDirectory = join(operations, id);
            await mkdir(operationDirectory, { mode: 0o700 });
            const windowsRun =
              process.platform === "win32"
                ? await prepareWindowsPackageRun(
                    operationDirectory,
                    options.profile.dir,
                    options.profile.installAnchor,
                    options.core.version,
                    options.profile.packageManager,
                  )
                : null;
            currentMonitor = windowsRun;
            lifetime.signal.throwIfAborted();
            for (const release of selectedSuite) options.source.assertCurrentRelease(release);
            const operation: PluginUpdateOperation = {
              schema: 2,
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
            currentMonitor ??= await observeProfilePackageProcesses(options.profile.dir);
            lifetime.signal.throwIfAborted();
            for (const release of selectedSuite) options.source.assertCurrentRelease(release);
            mutationStarted = true;
            mutationInThisController = true;
            let outcome: Awaited<ReturnType<typeof runProfilePnpm>> | null = null,
              installationError: unknown = null;
            try {
              outcome = await runProfilePnpm(
                {
                  profile: options.profile.name,
                  dir: options.profile.dir,
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
                ],
                {
                  ...(windowsRun?.packageManager ?? options.profile.packageManager),
                  execution: "service",
                  signal: lifetime.signal,
                  outputBytes: 16_000,
                  activateNewBundles: false,
                  idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
                  lookupTimeoutMs: 20_000,
                  onOutput: () => currentMonitor?.capture(),
                },
              );
            } catch (error) {
              installationError = error;
            }
            currentMonitor.capture();
            const processes = currentMonitor.snapshot();
            if (outcome?.logPath) operation.logs.push(outcome.logPath);
            const stopped = await currentMonitor.waitForQuiescence(
              options.quiescenceWaitMs ?? 2_000,
            );
            await stage("verifying", null, { logs: operation.logs, processes });
            if (!stopped) await stage("unknown", "PACKAGE_WRITERS_UNCONFIRMED");
            else {
              const after = await readPluginProfile(options.profile.dir);
              reflectProfile(after, await options.readRuntimeProofs(pluginUpdateProcessIdentity));
              if (!retainsUnmanagedManifestFields(baseline, after))
                await stage("failed", "PROFILE_SETTINGS_OWNERSHIP_UNCONFIRMED");
              else if (
                installationError ||
                !outcome ||
                outcome.exitCode !== 0 ||
                outcome.timedOut ||
                lifetime.signal.aborted
              )
                await stage(
                  "failed",
                  lifetime.signal.aborted ? "HOST_CANCELLED" : "PACKAGE_INSTALL_FAILED",
                );
              else if (
                !retainsProfileUpdates(baseline, after, downloads) ||
                downloads.some(
                  ({ release }) =>
                    !after.packages.some(
                      (pkg) => pkg.name === release.name && pkg.version === release.version,
                    ),
                )
              )
                await stage("failed", "PACKAGE_POSTCHECK_FAILED");
              else await stage("pending-restart");
            }
          },
          { waitMs: options.lockWaitMs ?? 30_000 },
        );
      } catch (error) {
        if (mutationStarted) {
          try {
            await stage("unknown", code(error, "UPDATE_RESULT_UNKNOWN"));
          } catch {
            journalBroken = true;
            if (state.operation)
              state = {
                ...state,
                operation: {
                  ...state.operation,
                  stage: "unknown",
                  diagnostic: "UPDATE_RECEIPT_WRITE_FAILED",
                },
              };
            for (const selectedPlan of selected)
              row(selectedPlan.release.name, {
                state: "unknown",
                diagnostic: "UPDATE_RECEIPT_WRITE_FAILED",
              });
          }
        } else {
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
          if (state.operation && ["accepted", "installing"].includes(state.operation.stage))
            try {
              await stage("failed", code(error, "UPDATE_PREPARATION_FAILED"));
            } catch {
              journalBroken = true;
            }
          reject(error);
        }
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
    check,
    submit,
    submitBatch,
    reconcileRuntime,
    snapshot,
    subscribe(listener: (snapshot: PluginUpdateSnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose,
  };
}
