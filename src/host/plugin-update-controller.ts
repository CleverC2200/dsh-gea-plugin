import { sourceUpdateProblem, planUpdateProblem } from "../shared/plugin-update-diagnostics.ts";
import { withFileLock } from "@deepseek-ai/dsh-atomic-write";
import { runProfilePnpm } from "@deepseek-ai/dsh-plugin-manager/operations";
import { resolveBundleDir } from "@deepseek-ai/dsh-app-boot";
import type { ProfileContext } from "@deepseek-ai/dsh-app-boot";
import { mkdir, open, readFile, realpath, rename, rm, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  companyPackageNames,
  parsePluginRelease,
  planPluginUpdate,
  validatePluginCombination,
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
  combinationManifests,
  freezePluginProfile,
  restorePluginProfile,
  retainsProfileUpdates,
  retainsUnmanagedManifestFields,
  validateActualProfile,
  within,
  sha256,
  type ProfileSnapshot,
} from "./plugin-update-profile.ts";
import { writePluginRecoveryNotes } from "./plugin-update-recovery-notes.ts";
import { observeProfilePackageProcesses } from "./plugin-update-processes.ts";
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
const run = promisify(execFile);

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
    value.schema !== 1 ||
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
    "baselineSha256",
    "archivePath",
    "recoveryDirectory",
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
  if (
    !(value.diagnostic === null || typeof value.diagnostic === "string") ||
    !(value.installedGraphSha256 === null || typeof value.installedGraphSha256 === "string")
  )
    return fail("UPDATE_JOURNAL_INVALID");
  return value as PluginUpdateOperation;
}
function operationTargets(operation: PluginUpdateOperation) {
  return operation.targets ?? [operation];
}
async function archiveMatches(archive: string, packageDirectory: string, signal?: AbortSignal) {
  const options = {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
    signal,
    encoding: "utf8" as const,
  };
  const files = (await run("tar", ["-tzf", archive], options)).stdout.trim().split(/\r?\n/);
  for (const name of files) {
    if (name.endsWith("/")) continue;
    signal?.throwIfAborted();
    const relative = name.slice("package/".length),
      path = join(packageDirectory, relative);
    if (!within(packageDirectory, path) || (await lstat(path)).isSymbolicLink()) return false;
    const bytes = (
      await run("tar", ["-xOf", archive, name], {
        ...options,
        encoding: "buffer",
      })
    ).stdout;
    const installed = await readFile(path);
    if (sha256(bytes) !== sha256(installed)) return false;
  }
  return true;
}

/** One Host owner holds the official lock through verification, receipt commit and confirmed-safe recovery. */
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
    const operation = parseOperation(
      JSON.parse(await readFile(join(operations, pointer.id, "receipt.json"), "utf8")),
    );
    if (
      operation.id !== pointer.id ||
      !within(operations, operation.recoveryDirectory) ||
      !operationTargets(operation).every((target) => within(cache, target.archivePath))
    )
      return fail("UPDATE_JOURNAL_INVALID");
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
      operation?.stage !== "pending-restart" ||
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
          latestOperation.stage !== "pending-restart"
        )
          return snapshot();
        state = { ...state, operation: latestOperation };
        const profile = await readPluginProfile(options.profile.dir),
          proofs = await options.readRuntimeProofs(pluginUpdateProcessIdentity);
        reflectProfile(profile, proofs);
        if (profile.ownedSha256 !== latestOperation.installedGraphSha256) return snapshot();
        const completionProofs: NonNullable<PluginUpdateOperation["completionProof"]>[] = [];
        for (const target of operationTargets(operation)) {
          const hostOwner = startup.find((proof) => proof.name === target.packageName);
          const host = hostOwner?.host;
          const client = proofs.find((proof) => proof.name === target.packageName)?.client;
          if (host?.kind === "active" && host.stamp.version !== target.targetVersion) {
            await stage("unknown", "LOADED_VERSION_MISMATCH");
            return snapshot();
          }
          if (
            host?.kind !== "active" ||
            client?.kind !== "observed" ||
            host.stamp.name !== target.packageName ||
            client.stamp.name !== target.packageName ||
            client.stamp.version !== target.targetVersion ||
            !host.identity ||
            !client.identity ||
            client.binding.hostProcessIdentity !== pluginUpdateProcessIdentity ||
            !client.binding.pageIdentity ||
            !client.binding.nonce
          )
            return snapshot();
          const installed = profile.packages.find(
            (pkg) => pkg.root && pkg.name === target.packageName,
          );
          if (
            !installed ||
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
        },
        { waitMs: options.lockWaitMs ?? 30_000 },
      );
      if (state.operation) {
        for (const target of operationTargets(state.operation))
          row(target.packageName, {
            state: state.operation.stage,
            diagnostic: state.operation.diagnostic,
            candidateVersion: target.targetVersion,
          });
        if (["accepted", "installing", "verifying", "restoring"].includes(state.operation.stage))
          await stage("unknown", "PREVIOUS_OPERATION_INTERRUPTED");
      }
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
      const releases = await options.source.check(
        signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
      );
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
      for (const rawRelease of releases) {
        const release = parsePluginRelease(rawRelease);
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
        const plan = planPluginUpdate({
          release,
          core: options.core,
          installed: await combinationManifests(profile, options.core, options.profile.dir),
        });
        if (generation !== checking || closed) return snapshot();
        if (plan.kind === "ready") {
          const id = randomUUID();
          plans.set(release.name, { id, release, baseline: profile });
          row(release.name, {
            state: "available",
            candidateVersion: release.version,
            planId: id,
            diagnostic: null,
          });
        } else
          row(release.name, {
            state: plan.kind === "current" ? "current" : "blocked",
            diagnostic: plan.kind === "blocked" ? plan.code : null,
            problem:
              plan.kind === "blocked" ? planUpdateProblem(plan, release, options.core) : undefined,
          });
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
    const selected = requests.map((request) => {
      const plan = plans.get(request.packageName);
      if (!plan || plan.id !== request.planId) fail("UPDATE_PLAN_STALE");
      return plan;
    });
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
      let mutationStarted = false,
        baseline: ProfileSnapshot | null = null,
        recovery: string | null = null;
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
            baseline = await readPluginProfile(options.profile.dir);
            if (selected.some((selectedPlan) => baseline?.sha256 !== selectedPlan.baseline.sha256))
              fail("UPDATE_BASELINE_CHANGED");
            const direct = object(baseline.manifest.dependencies ?? {});
            const manifests = await combinationManifests(
              baseline,
              options.core,
              options.profile.dir,
            );
            for (const selectedPlan of selected) {
              const release = selectedPlan.release;
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
              if (
                planPluginUpdate({ release, core: options.core, installed: manifests }).kind !==
                "ready"
              )
                fail("UPDATE_COMBINATION_CHANGED");
            }
            const combined = manifests.map((manifest) => {
              const release = selected.find(
                (selectedPlan) => selectedPlan.release.name === manifest.name,
              )?.release;
              return release ?? manifest;
            });
            if (validatePluginCombination({ core: options.core, manifests: combined }).length)
              fail("UPDATE_COMBINATION_CHANGED");
            if (await optionalFile(join(options.profile.dir, ".plugin-manager/run.json")))
              fail("PROFILE_WRITER_UNCONFIRMED");
            const store = await pluginProfileStoreDirectory(options.profile.dir);
            for (const selectedPlan of selected)
              row(selectedPlan.release.name, { state: "snapshotting" });
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
            recovery = join(operationDirectory, "recovery");
            await freezePluginProfile(options.profile.dir, baseline, recovery, options.fileCommit);
            await writePluginRecoveryNotes(operationDirectory, options.profile.dir);
            lifetime.signal.throwIfAborted();
            for (const selectedPlan of selected)
              options.source.assertCurrentRelease(selectedPlan.release);
            if ((await readPluginProfile(options.profile.dir)).sha256 !== baseline.sha256)
              fail("UPDATE_BASELINE_CHANGED");
            const operation: PluginUpdateOperation = {
              schema: 1,
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
              baselineSha256: baseline.sha256,
              archivePath: archive,
              recoveryDirectory: recovery,
              diagnostic: null,
              installedGraphSha256: null,
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
            for (const selectedPlan of selected)
              options.source.assertCurrentRelease(selectedPlan.release);
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
            if (!stopped || outcome?.incompatible?.length)
              await stage("unknown", "PACKAGE_WRITERS_UNCONFIRMED");
            else if (
              !retainsUnmanagedManifestFields(
                baseline,
                await readPluginProfile(options.profile.dir),
              )
            ) {
              await stage("unknown", "PROFILE_SETTINGS_OWNERSHIP_UNCONFIRMED");
            } else if (
              installationError ||
              !outcome ||
              outcome.exitCode !== 0 ||
              outcome.timedOut ||
              lifetime.signal.aborted
            ) {
              await stage(
                "restoring",
                lifetime.signal.aborted ? "HOST_CANCELLED" : "PACKAGE_INSTALL_FAILED",
              );
              await restorePluginProfile(options.profile.dir, baseline, recovery);
              reflectProfile(
                await readPluginProfile(options.profile.dir),
                await options.readRuntimeProofs(pluginUpdateProcessIdentity),
              );
              await stage(
                "restored",
                lifetime.signal.aborted ? "HOST_CANCELLED" : "PACKAGE_INSTALL_FAILED",
              );
            } else {
              const after = await readPluginProfile(options.profile.dir);
              let verified = retainsProfileUpdates(baseline, after, downloads);
              for (const { release, archivePath } of downloads) {
                const installed = after.packages.find(
                  (pkg) => pkg.root && pkg.name === release.name,
                );
                if (
                  !installed ||
                  installed.version !== release.version ||
                  !(await archiveMatches(archivePath, installed.dir, lifetime.signal))
                )
                  verified = false;
              }
              if (
                !verified ||
                validatePluginCombination({
                  core: options.core,
                  manifests: await combinationManifests(after, options.core, options.profile.dir),
                }).length ||
                (
                  await validateActualProfile(
                    after,
                    options.core,
                    options.profile.dir,
                    options.profile.installAnchor,
                  )
                ).length
              ) {
                await stage("restoring", "PACKAGE_POSTCHECK_FAILED");
                await restorePluginProfile(options.profile.dir, baseline, recovery);
                reflectProfile(
                  await readPluginProfile(options.profile.dir),
                  await options.readRuntimeProofs(pluginUpdateProcessIdentity),
                );
                await stage("restored", "PACKAGE_POSTCHECK_FAILED");
              } else {
                reflectProfile(after, await options.readRuntimeProofs(pluginUpdateProcessIdentity));
                await stage("pending-restart", null, {
                  installedGraphSha256: after.ownedSha256,
                });
              }
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
