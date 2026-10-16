/** Prepare an independent worker's fixed inputs; quality and tests remain with the quality CLI. */
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  existsSync,
  statSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { availableParallelism, totalmem } from "node:os";
import { readSystemChrome, mountSystemChrome } from "./quality-system-chrome.mjs";
import { readRunnerEnvironment, verifyRunnerCompatibility } from "./quality-runner-environment.mjs";
import * as execution from "./quality-test-execution.mjs";
import {
  readWorkerControl,
  waitForWorkerArtifacts,
  verifyWorkerIndex,
  readBrowserDependencyClosure,
} from "./quality-worker-control.mjs";
import { executionDigest, writeExecutionReceipt } from "./quality-test-execution.mjs";
import { runPreparedTransport } from "./quality-prepared-inputs.mjs";
import { prepareWorkbenchAssets, prepareWorkbenchGeaAuthority } from "./quality-workbench.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(readFileSync(file));
const reject = (detail) => {
  throw Error("QUALITY_WORKER_REJECTED: " + detail);
};
function command(file, args, cwd, env = {}) {
  const r = spawnSync(file, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.error || r.signal || r.status !== 0)
    reject(file + ": " + (r.error?.message ?? r.signal ?? r.stderr ?? r.status));
  return r.stdout.trim();
}
/** Own only this invocation's POSIX install groups, including ordinary inherited descendants. */
function installCommands() {
  const running = new Set();
  const cancellation = new AbortController();
  let firstError;
  const alive = (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (e) {
      if (e.code === "ESRCH") return false;
      throw e;
    }
  };
  const signal = (entry, value) => {
    if (!entry.child.pid) return;
    try {
      process.kill(-entry.child.pid, value);
    } catch (e) {
      if (e.code !== "ESRCH") entry.cleanupError = e;
    }
  };
  const stop = (error) => {
    firstError ??= error;
    cancellation.abort(firstError);
    for (const entry of running) {
      if (entry.timer) continue;
      signal(entry, "SIGTERM");
      entry.timer = setTimeout(() => signal(entry, "SIGKILL"), 250);
    }
    return firstError;
  };
  const onTerm = () => stop(Error("QUALITY_WORKER_REJECTED: installation cancelled by SIGTERM"));
  const onInt = () => stop(Error("QUALITY_WORKER_REJECTED: installation cancelled by SIGINT"));
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  return {
    error: () => firstError,
    signal: cancellation.signal,
    stop,
    async close() {
      if (running.size)
        stop(firstError ?? Error("QUALITY_WORKER_REJECTED: installation did not finish"));
      await Promise.allSettled([...running].map((entry) => entry.closed));
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    },
    run(file, args, cwd) {
      if (firstError) return Promise.reject(firstError);
      const child = spawn(file, args, {
        cwd,
        env: process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const entry = { child };
      let stdout = "",
        stderr = "",
        commandError;
      const failure = (detail) => Error("QUALITY_WORKER_REJECTED: " + file + ": " + detail);
      const collect = (data, output) => {
        if (output === "stdout") stdout += data;
        else stderr += data;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) {
          commandError ??= failure("install output exceeded 1 MiB");
          stdout = stdout.slice(-65536);
          stderr = stderr.slice(-65536);
          stop(commandError);
        }
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (data) => collect(data, "stdout"));
      child.stderr?.on("data", (data) => collect(data, "stderr"));
      child.on("error", (e) => {
        commandError ??= failure(e.message);
        stop(commandError);
      });
      child.on("exit", (code, sig) => {
        if (code !== 0 || sig) {
          commandError ??= failure(sig ?? (stderr || code));
          stop(commandError);
        } else {
          // Descendants can hold stdio open after a successful leader exits,
          // so group cleanup must start without waiting for close.
          try {
            if (child.pid && alive(child.pid)) {
              commandError ??= failure("install left an owned process group");
              stop(commandError);
            }
          } catch (e) {
            commandError ??= failure(e.message);
            stop(commandError);
          }
        }
      });
      entry.closed = new Promise((resolvePromise, rejectPromise) => {
        child.on("close", async (code, sig) => {
          if (code !== 0 || sig) {
            commandError ??= failure(sig ?? (stderr || code));
            if (!sig && stderr) commandError.message = failure(stderr).message;
          }
          try {
            if (child.pid && alive(child.pid)) {
              stop(commandError ?? failure("install left an owned process group"));
              const until = Date.now() + 2000;
              while (alive(child.pid) && Date.now() < until)
                await new Promise((r) => setTimeout(r, 10));
              if (alive(child.pid)) throw failure("owned install group did not terminate");
            }
            if (entry.cleanupError) throw entry.cleanupError;
          } catch (e) {
            const cause = stop(commandError ?? e);
            if (cause !== e) cause.message += "; install cleanup: " + e.message;
            commandError ??= e;
          }
          clearTimeout(entry.timer);
          running.delete(entry);
          if (commandError || firstError) rejectPromise(commandError ?? firstError);
          else resolvePromise(stdout.trim());
        });
      });
      running.add(entry);
      return entry.closed;
    },
  };
}
function paths(root) {
  root = resolve(root);
  if (realpathSync(root) !== root) reject("real owned workspace required");
  if (process.env.GITHUB_WORKSPACE && process.env.GITHUB_WORKSPACE !== root)
    reject("original GITHUB_WORKSPACE required");
  return {
    root,
    gea: join(root, "candidate/dsh-gea-plugin"),
    manage: join(root, "candidate/dsh-agent-manage"),
    wb: join(root, "source/dsh-agent-workbench"),
    prepared: join(root, "candidate/dsh-agent-workbench"),
    coreSource: join(root, "source/official-core"),
    core: join(root, "official-latest-standard"),
    upstream: join(root, "quality-upstreams"),
  };
}
function original(p, head) {
  if (realpathSync(p) !== p || command("git", ["rev-parse", "HEAD"], p) !== head)
    reject("source layout/head changed: " + p);
  if (
    command("git", ["rev-parse", "--is-shallow-repository"], p) !== "false" ||
    command("git", ["status", "--porcelain", "--untracked-files=all"], p)
  )
    reject("clean full source required: " + p);
}
function material(name, path, head, inherited) {
  const bytes = readFileSync(join(path, "package.json")),
    definition = JSON.parse(bytes),
    packageManager = definition.packageManager ?? inherited;
  if (!/^(npm|pnpm)@\d+\.\d+\.\d+$/.test(packageManager ?? ""))
    reject("exact packageManager: " + name);
  const lock = packageManager.startsWith("npm@") ? "package-lock.json" : "pnpm-lock.yaml";
  return {
    name,
    path,
    head,
    packageSha256: hash(bytes),
    lockSha256: hash(readFileSync(join(path, lock))),
    packageManager,
  };
}
function baseMetadata(p, manifest) {
  const names = ["dsh-agent-manage", "dsh-agent-workbench", "dsh-gea-plugin"];
  if (
    !/^[a-f0-9]{40}$/.test(manifest?.core ?? "") ||
    !Array.isArray(manifest.repositories) ||
    JSON.stringify(manifest.repositories.map((x) => x.repo).sort()) !== JSON.stringify(names)
  )
    reject("fixed three repositories/Core required");
  const sources = manifest.repositories.map((e) => {
    const expected =
      e.repo === "dsh-agent-workbench" ? p.wb : e.repo === "dsh-agent-manage" ? p.manage : p.gea;
    if (e.path !== expected || !/^[a-f0-9]{40}$/.test(e.head)) reject("fixed source layout");
    original(expected, e.head);
    return material(e.repo, expected, e.head);
  });
  original(p.coreSource, manifest.core);
  sources.push(material("official-core", p.coreSource, manifest.core));
  const tools = {};
  for (const [base, files] of [
    [
      p.gea,
      [
        "quality-worker-inputs.mjs",
        "quality-worker-control.mjs",
        "quality-runner-environment.mjs",
        "quality-system-chrome.mjs",
        "quality-prepared-inputs.mjs",
        "quality-ci-stages.mjs",
        "quality-prepared-tar.py",
        "quality-upstreams.mjs",
        "quality-upstreams.json",
        "quality-workbench.mjs",
        "quality-test-execution.mjs",
        "source-combination-integrity.mjs",
        "supported-cores.json",
      ],
    ],
    [p.manage, ["prepare-official-sdk.mjs", "sdk-artifact-cache.mjs"]],
    [p.wb, ["candidate-input.mjs", "ci-test-plan.mjs", "ci-source-policy.mjs"]],
  ])
    for (const file of files) {
      const path = join(base, "scripts", file);
      if (realpathSync(path) !== path || !lstatSync(path).isFile()) reject("tool redirected");
      tools[path] = hash(readFileSync(path));
    }
  const selected = json(join(p.gea, "scripts/supported-cores.json")).find(
      (x) => x.head === manifest.core,
    ),
    core = sources.at(-1);
  if (
    !selected ||
    selected.lockSha256 !== core.lockSha256 ||
    selected.packageManager !== core.packageManager ||
    selected.nodeMajor !== Number(process.versions.node.split(".")[0])
  )
    reject("registered Core/lock/toolchain changed");
  const sdkIdentity = {
    coreCommit: selected.head,
    coreLock: selected.lockSha256,
    packageManager: selected.packageManager,
    nodeMajor: selected.nodeMajor,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    builder: tools[join(p.manage, "scripts/prepare-official-sdk.mjs")],
  };
  return { sources, tools, sdkIdentity };
}
function additionalSources(p, runtime) {
  const fixed = json(join(p.gea, "scripts/quality-upstreams.json"));
  for (const [name, e] of [
    ["dsh-genui", fixed.genui],
    ["dsh-better-sidebar", fixed.sidebar],
  ])
    original(join(p.upstream, "upstream-reference", name), e.head);
  const result = [
    material(
      "dsh-better-sidebar",
      join(p.upstream, "upstream-reference/dsh-better-sidebar"),
      fixed.sidebar.head,
    ),
  ];
  if (
    result[0].lockSha256 !== fixed.sidebar.lockSha256 ||
    result[0].packageManager !== fixed.sidebar.packageManager
  )
    reject("fixed Sidebar lock/toolchain changed");
  if (runtime)
    result.push(
      material(
        "inventory-apsplan",
        join(p.wb, "business/inventory-apsplan/source"),
        null,
        json(join(p.wb, "package.json")).packageManager,
      ),
    );
  return result;
}
function browserMetadata(p, needed) {
  if (!needed) return null;
  const chrome = "/opt/google/chrome/chrome";
  if (process.platform !== "linux") reject("Linux worker browser required");
  return {
    playwright: json(join(p.gea, "node_modules/@playwright/test/package.json")).version,
    chrome,
    chromeVersion: command(chrome, ["--version"], p.gea),
    systemChrome: readSystemChrome({ root: p.root, verifyBytes: false }),
  };
}
function frozenInputs(root, executionPlan, stages) {
  const { planSha256, ...contents } = executionPlan;
  if (
    executionDigest(contents) !== planSha256 ||
    JSON.stringify(json(join(root, "quality-test-execution-plan.json"))) !==
      JSON.stringify(executionPlan) ||
    JSON.stringify(json(join(root, "quality-test-plan.json"))) !==
      JSON.stringify(stages.binding?.plan) ||
    JSON.stringify(stages.binding?.executionPlan) !== JSON.stringify(executionPlan) ||
    stages.binding?.inputSha256 !== executionPlan.binding.inputSha256 ||
    ["prepare", "build"].some((s) => stages.stages?.[s]?.status !== "passed")
  )
    reject("original passed build/plan required");
  const binding = executionPlan.binding;
  if (
    hash(readFileSync(join(root, "candidate-input.json"))) !== binding.inputSha256 ||
    JSON.stringify(json(join(root, "candidate-input.json"))) !== JSON.stringify(binding.manifest)
  )
    reject("original candidate bytes changed");
  return binding;
}
export function createWorkerBinding({ root, executionPlan, stages }) {
  const p = paths(root),
    binding = frozenInputs(p.root, executionPlan, stages);
  if (
    binding.node !== process.versions.node ||
    binding.platform !== process.platform ||
    binding.arch !== process.arch ||
    String(binding.runId) !== process.env.GITHUB_RUN_ID ||
    String(binding.runAttempt) !== process.env.GITHUB_RUN_ATTEMPT ||
    binding.coreSource !== p.coreSource
  )
    reject("producer environment/input changed");
  const metadata = baseMetadata(p, binding.manifest),
    runtime = stages.binding.plan.runtime === true;
  return {
    ...binding,
    planSha256: executionPlan.planSha256,
    buildSha256: executionDigest(stages.artifacts),
    worker: {
      schemaVersion: 1,
      root: p.root,
      environment: readRunnerEnvironment(),
      ...metadata,
      sources: [...metadata.sources, ...additionalSources(p, runtime)],
      runtime,
      browser: browserMetadata(p, stages.binding.plan.browser === true),
    },
  };
}
/** Scheduling/source material only: no installed dependencies or build authority. */
export function createWorkerSourceControl({ root, executionPlan }) {
  const p = paths(root);
  execution.verifyExecutionPlan(executionPlan);
  const { planSha256, ...contents } = executionPlan;
  const candidateBytes = readFileSync(join(p.root, "candidate-input.json"), "utf8");
  if (
    executionDigest(contents) !== planSha256 ||
    hash(candidateBytes) !== executionPlan.binding.inputSha256 ||
    JSON.stringify(JSON.parse(candidateBytes)) !== JSON.stringify(executionPlan.binding.manifest) ||
    executionPlan.binding.node !== process.versions.node ||
    executionPlan.binding.platform !== process.platform ||
    executionPlan.binding.arch !== process.arch ||
    String(executionPlan.binding.runId) !== process.env.GITHUB_RUN_ID ||
    String(executionPlan.binding.runAttempt) !== process.env.GITHUB_RUN_ATTEMPT ||
    executionPlan.binding.coreSource !== p.coreSource
  )
    reject("source control plan/input changed");
  return {
    schemaVersion: 1,
    scope: "source-plan-only",
    repository: process.env.GITHUB_REPOSITORY,
    candidateBytes,
    groupBytes: readFileSync(join(p.root, "candidate-group.json"), "utf8"),
    plan: executionPlan,
    metadata: baseMetadata(p, executionPlan.binding.manifest),
    admission: json(join(p.root, "quality-source-admission.json")),
    runtime: executionPlan.shards.some((shard) => shard.runtimeFiles.length > 0),
  };
}
export async function prepareWorkerInputs(values) {
  const early = values["early-control"] !== undefined;
  if (
    (early &&
      ["binding", "manifest", "bundle", "manifest-sha256"].some(
        (name) => values[name] !== undefined,
      )) ||
    (!early && values["early-sha256"] !== undefined)
  )
    reject("one explicit worker input mode required");
  for (const name of early
    ? ["root", "early-control", "early-sha256"]
    : ["root", "binding", "manifest", "bundle", "manifest-sha256"])
    if (!values[name]) reject("five explicit transport parameters required");
  const p = paths(values.root),
    receipt = join(p.root, "quality-worker-inputs.json");
  if (realpathSync(process.cwd()) !== p.gea) reject("registered GEA cwd required");
  const record = {
    schemaVersion: 1,
    status: "running",
    quality: "not-observed",
    tests: "not-run",
    startedAt: new Date().toISOString(),
    resources: { availableParallelism: availableParallelism(), totalMemoryBytes: totalmem() },
    steps: [],
  };
  writeFileSync(receipt, JSON.stringify(record), { flag: "wx" });
  const step = async (name, execute) => {
    const result = { name, status: "running", startedAt: new Date().toISOString() };
    record.steps.push(result);
    writeExecutionReceipt(receipt, record);
    try {
      const value = await execute();
      result.status = "passed";
      if (value !== undefined) result.result = value;
      return value;
    } catch (e) {
      result.status = "failed";
      result.error = e.message;
      throw e;
    } finally {
      result.finishedAt = new Date().toISOString();
      result.durationMs = Date.parse(result.finishedAt) - Date.parse(result.startedAt);
      writeExecutionReceipt(receipt, record);
    }
  };
  try {
    let binding, sourceControl, originalControlBytes, admitted, earlyBrowserLibraries;
    let transportValues = values;
    const fixedInputs = () => {
      for (const file of [
        transportValues.binding,
        transportValues.manifest,
        transportValues.bundle,
      ]) {
        const path = resolve(file);
        if (
          !path.startsWith(p.root + "/") ||
          realpathSync(path) !== path ||
          !lstatSync(path).isFile()
        )
          reject("private transport file required");
      }
      const bindingBytes = readFileSync(transportValues.binding);
      binding = JSON.parse(bindingBytes);
      record.bindingSha256 = hash(bindingBytes);
      record.bundleBytes = statSync(transportValues.bundle).size;
      if (binding.worker?.browser) {
        const chrome = spawnSync("/opt/google/chrome/chrome", ["--version"], {
          cwd: p.gea,
          encoding: "utf8",
          timeout: 10000,
        });
        record.chromeObservation = {
          executable: "/opt/google/chrome/chrome",
          status:
            !chrome.error && !chrome.signal && chrome.status === 0 ? "observed" : "unavailable",
          version: chrome.stdout?.trim() ?? "",
          exitCode: chrome.status,
          error: chrome.error?.message ?? chrome.signal ?? null,
        };
      }
      let consumer;
      try {
        consumer = readRunnerEnvironment();
      } catch (error) {
        record.environment = {
          producer: binding.worker?.environment,
          consumer: error.observedEnvironment,
        };
        throw error;
      }
      record.environment = { producer: binding.worker?.environment, consumer };
      record.environment = verifyRunnerCompatibility(binding.worker?.environment, consumer);
      if (
        !/^[a-f0-9]{64}$/.test(transportValues["manifest-sha256"]) ||
        hash(readFileSync(transportValues.manifest)) !== transportValues["manifest-sha256"] ||
        JSON.stringify(json(transportValues.manifest).binding) !== JSON.stringify(binding)
      )
        reject("transport binding/manifest changed");
      if (
        binding.worker?.schemaVersion !== 1 ||
        binding.worker.root !== p.root ||
        binding.node !== process.versions.node ||
        binding.platform !== process.platform ||
        binding.arch !== process.arch ||
        String(binding.runId) !== process.env.GITHUB_RUN_ID ||
        String(binding.runAttempt) !== process.env.GITHUB_RUN_ATTEMPT ||
        binding.coreSource !== p.coreSource
      )
        reject("worker environment/input changed");
      const base = baseMetadata(p, binding.manifest);
      if (
        JSON.stringify(base.sources) !== JSON.stringify(binding.worker.sources.slice(0, 4)) ||
        JSON.stringify(base.tools) !== JSON.stringify(binding.worker.tools) ||
        JSON.stringify(base.sdkIdentity) !== JSON.stringify(binding.worker.sdkIdentity)
      )
        reject("source locks, tools or SDK builder changed");
    };
    await step("fixed-inputs", async () => {
      if (!early) return fixedInputs();
      sourceControl = readWorkerControl({
        root: p.root,
        file: values["early-control"],
        sha256: values["early-sha256"],
      });
      originalControlBytes = readFileSync(values["early-control"]);
      const plan = sourceControl.plan;
      if (
        plan.binding.node !== process.versions.node ||
        plan.binding.platform !== process.platform ||
        plan.binding.arch !== process.arch ||
        plan.binding.coreSource !== p.coreSource ||
        String(plan.binding.runId) !== process.env.GITHUB_RUN_ID ||
        String(plan.binding.runAttempt) !== process.env.GITHUB_RUN_ATTEMPT ||
        sourceControl.repository !== process.env.GITHUB_REPOSITORY
      )
        reject("early worker environment/input changed");
      const metadata = baseMetadata(p, plan.binding.manifest);
      if (JSON.stringify(metadata) !== JSON.stringify(sourceControl.metadata))
        reject("early source locks/tools changed");
      binding = {
        ...plan.binding,
        planSha256: plan.planSha256,
        worker: { ...metadata, runtime: sourceControl.runtime, browser: null },
      };
      record.earlyControlSha256 = values["early-sha256"];
      record.environment = { consumer: readRunnerEnvironment() };
      const candidate = join(p.root, "worker-early-candidate.json");
      writeFileSync(candidate, sourceControl.candidateBytes, { flag: "wx" });
      const reader = await import(pathToFileURL(join(p.wb, "scripts/candidate-input.mjs")));
      admitted = await reader.readFinalGroup({
        input: candidate,
        sha256: plan.binding.inputSha256,
        checkout: p.gea,
        repo: "dsh-gea-plugin",
        coreSource: p.coreSource,
        expectedSha: process.env.QUALITY_EXPECTED_SHA,
        ci: process.env.CI,
      });
      const planFile = join(p.root, "worker-early-plan.json");
      writeFileSync(planFile, JSON.stringify(plan), { flag: "wx" });
      command(
        process.execPath,
        [
          join(p.gea, "scripts/run-quality-ci.mjs"),
          "--phase",
          plan.binding.phase,
          "--stage",
          "plan",
          "--input",
          candidate,
          "--final-group-sha256",
          plan.binding.inputSha256,
          "--final-group-workbench",
          p.wb,
          "--core-source",
          p.coreSource,
          "--test-shards",
          String(Math.max(1, plan.shards.length)),
          "--test-file-concurrency",
          String(plan.concurrency),
          ...(plan.timingSource
            ? ["--test-timings", join(p.gea, "scripts/quality-test-timings.json")]
            : []),
          "--execution-plan",
          planFile,
        ],
        p.gea,
      );
    });
    if (early)
      await step("early-test-capacity", () =>
        execution.verifyExecutionCapacity({ concurrency: sourceControl.plan.concurrency }),
      );
    await step("sdk-source", () =>
      command(
        process.execPath,
        [
          join(p.manage, "scripts/prepare-official-sdk.mjs"),
          "--prepare-source",
          "--core",
          p.core,
          "--core-head",
          binding.manifest.core,
          "--source",
          p.coreSource,
        ],
        p.gea,
      ),
    );
    await step("workbench-source", () => {
      if (existsSync(p.prepared)) reject("fresh prepared worktree required");
      return command(
        "git",
        [
          "worktree",
          "add",
          "--detach",
          p.prepared,
          binding.manifest.repositories.find((x) => x.repo === "dsh-agent-workbench").head,
        ],
        p.wb,
      );
    });
    await step("upstream-source", () =>
      command(
        process.execPath,
        [join(p.gea, "scripts/quality-upstreams.mjs"), "--source-only", "--root", p.upstream],
        p.gea,
      ),
    );
    const additional = additionalSources(p, binding.worker.runtime);
    if (early) binding.worker.sources = [...binding.worker.sources, ...additional];
    else if (JSON.stringify(additional) !== JSON.stringify(binding.worker.sources.slice(4)))
      reject("fixed upstream or inventory sources changed");
    const earlySources = early ? JSON.stringify(binding.worker.sources) : null;
    const receivePrepared = async (owned) => {
      if (early) {
        const expected = {
          repository: sourceControl.repository,
          runId: sourceControl.plan.binding.runId,
          runAttempt: sourceControl.plan.binding.runAttempt,
          headSha: sourceControl.plan.binding.manifest.repositories.find(
            (x) => x.repo === "dsh-gea-plugin",
          ).head,
        };
        const deadline = performance.now() + 300000;
        const remaining = () => {
          owned.signal.throwIfAborted();
          const milliseconds = Math.ceil(deadline - performance.now());
          if (milliseconds <= 0) reject("producer rendezvous deadline exceeded");
          return milliseconds;
        };
        const options = {
          expected,
          core: sourceControl.plan.binding.manifest.core,
          token: process.env.GH_TOKEN,
          apiBase: process.env.GITHUB_API_URL ?? "https://api.github.com",
          signal: owned.signal,
        };
        const artifacts = await step("producer-wait", () =>
          waitForWorkerArtifacts({ ...options, timeoutMs: remaining() }),
        );
        const download = async (artifact, directory, names) => {
          if (existsSync(directory)) reject("fresh artifact inbox required");
          mkdirSync(directory);
          const timer = setTimeout(
            () => owned.stop(Error("QUALITY_WORKER_REJECTED: artifact download deadline exceeded")),
            remaining(),
          );
          try {
            await owned.run(
              "gh",
              [
                "run",
                "download",
                String(expected.runId),
                "--repo",
                expected.repository,
                "--name",
                artifact.name,
                "--dir",
                directory,
              ],
              p.gea,
            );
          } finally {
            clearTimeout(timer);
          }
          remaining();
          if (
            JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([...names].sort()) ||
            names.some((name) => {
              const file = join(directory, name);
              return realpathSync(file) !== file || !lstatSync(file).isFile();
            })
          )
            reject("artifact download keyset/path changed");
        };
        const inbox = join(p.root, "worker-inbox"),
          indexes = join(p.root, "worker-index");
        await step("download-index", () =>
          download(artifacts.index, indexes, ["quality-index.json"]),
        );
        const index = await verifyWorkerIndex({
          control: sourceControl,
          index: json(join(indexes, "quality-index.json")),
        });
        if (String(index.bundleArtifactId) !== String(artifacts.bundle.id))
          reject("producer bundle artifact identity changed");
        await step("download-bundle", () =>
          download(artifacts.bundle, inbox, ["manifest.json", "prepared.tar"]),
        );
        const after = await waitForWorkerArtifacts({ ...options, timeoutMs: remaining() });
        if (JSON.stringify(after) !== JSON.stringify(artifacts))
          reject("downloaded artifact identity changed");
        if (!originalControlBytes.equals(readFileSync(values["early-control"])))
          reject("early control changed during preparation");
        const bindingFile = join(p.root, "worker-binding.json");
        writeFileSync(bindingFile, index.bindingBytes, { flag: "wx" });
        transportValues = {
          root: p.root,
          binding: bindingFile,
          manifest: join(inbox, "manifest.json"),
          bundle: join(inbox, "prepared.tar"),
          "manifest-sha256": index.manifestSha256,
        };
        await step("prepared-inputs", fixedInputs);
        if (JSON.stringify(binding.worker.sources) !== earlySources)
          reject("sources changed across producer wait");
      }
      await step("transport", () =>
        runPreparedTransport([
          "receive",
          "--root",
          p.root,
          "--binding",
          transportValues.binding,
          "--manifest",
          transportValues.manifest,
          "--bundle",
          transportValues.bundle,
          "--manifest-sha256",
          transportValues["manifest-sha256"],
        ]),
      );
      await step("transported-input-binding", () => {
        const plan = json(join(p.root, "quality-test-execution-plan.json")),
          stages = json(join(p.root, "quality-stages.json"));
        const { planSha256, buildSha256, worker, ...originalBinding } = binding;
        if (
          JSON.stringify(frozenInputs(p.root, plan, stages)) !== JSON.stringify(originalBinding) ||
          plan.planSha256 !== planSha256 ||
          executionDigest(stages.artifacts) !== buildSha256 ||
          (stages.binding.plan.runtime === true) !== worker.runtime ||
          (stages.binding.plan.browser === true) !== Boolean(worker.browser)
        )
          reject("transported plan/build binding changed");
        if (
          early &&
          (JSON.stringify(plan) !== JSON.stringify(sourceControl.plan) ||
            readFileSync(join(p.root, "candidate-group.json"), "utf8") !== sourceControl.groupBytes)
        )
          reject("early and received plan/group bytes differ");
      });
      await step("received-test-capacity", () =>
        execution.verifyExecutionCapacity({
          concurrency: json(join(p.root, "quality-test-execution-plan.json")).concurrency,
        }),
      );
      await step("candidate-source-admission", async () => {
        const reader = await import(pathToFileURL(join(p.wb, "scripts/candidate-input.mjs")));
        admitted = await reader.readFinalGroup({
          input: join(p.root, "candidate-input.json"),
          sha256: binding.inputSha256,
          checkout: p.gea,
          repo: "dsh-gea-plugin",
          coreSource: p.coreSource,
          expectedSha: process.env.QUALITY_EXPECTED_SHA,
          ci: process.env.CI,
        });
        return admitted.receipt;
      });
    };
    if (!early) await receivePrepared();
    await step("local-links", async () => {
      await prepareWorkbenchGeaAuthority({ workbench: p.wb, gea: p.gea });
      for (const entry of binding.manifest.repositories) {
        const expected = "https://github.com/CleverC2200/" + entry.repo + ".git";
        const current = spawnSync("git", ["remote", "get-url", "source"], {
          cwd: entry.path,
          encoding: "utf8",
        });
        if (current.status !== 0) command("git", ["remote", "add", "source", expected], entry.path);
        else if (current.stdout.trim() !== expected) reject("source remote changed");
      }
      const inputs = join(p.root, "upstream-inputs");
      mkdirSync(inputs, { recursive: true });
      if (realpathSync(inputs) !== inputs) reject("upstream inputs redirected");
      for (const [name, target] of [
        ["genui", join(p.upstream, "upstream-assets/genui-0.11.3")],
        ["sidebar", join(p.upstream, "upstream-reference/dsh-better-sidebar")],
      ]) {
        const link = join(inputs, name);
        if (existsSync(link)) {
          if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== target)
            reject("upstream link changed");
        } else symlinkSync(target, link, "dir");
      }
    });
    const roots = new Set();
    const tasks = [
      "official-core",
      "dsh-better-sidebar",
      "dsh-agent-workbench",
      ...(binding.worker.runtime ? ["inventory-apsplan"] : []),
      "dsh-agent-manage",
      "dsh-gea-plugin",
    ].map((name) => {
      const source = binding.worker.sources.find((s) => s.name === name);
      const directory =
        name === "official-core"
          ? p.core
          : source.path.startsWith(p.wb)
            ? p.prepared + source.path.slice(p.wb.length)
            : source.path;
      return {
        name,
        source,
        directory,
        binary: source.packageManager.startsWith("npm@") ? "npm" : "corepack",
        prefix: source.packageManager.startsWith("npm@") ? [] : ["pnpm"],
      };
    });
    // Frozen projects have no npmrc/hooks or redirected dependency/lock stores.
    // Inspect only owned paths and named non-secret overrides; never dump user config/env.
    const configuration = new Map();
    const redirect =
      /(?:^|\n)\s*(?:modulesDir|modules-dir|virtualStoreDir|virtual-store-dir|lockfileDir|lockfile-dir|storeDir|store-dir|globalVirtualStoreDir|global-virtual-store-dir|enableGlobalVirtualStore|enable-global-virtual-store|nodeLinker|node-linker)\s*[:=]/i;
    for (const task of tasks) {
      for (
        let at = task.directory;
        at.startsWith(p.root + "/") || at === p.root;
        at = dirname(at)
      ) {
        for (const name of [".npmrc", ".pnpmfile.cjs", "pnpmfile.cjs", "pnpm-workspace.yaml"]) {
          const file = join(at, name);
          if (configuration.has(file)) continue;
          let bytes = null;
          try {
            const info = lstatSync(file);
            if (!info.isFile() || realpathSync(file) !== file)
              reject("install configuration redirected: " + file);
            if (name !== "pnpm-workspace.yaml")
              reject("unsupported install configuration: " + file);
            bytes = readFileSync(file, "utf8");
            if (redirect.test(bytes)) reject("redirected install paths: " + file);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          configuration.set(file, bytes);
        }
        if (at === p.root) break;
      }
    }
    for (const key of [
      "npm_config_userconfig",
      "NPM_CONFIG_USERCONFIG",
      "npm_config_globalconfig",
      "NPM_CONFIG_GLOBALCONFIG",
    ])
      if (process.env[key]) reject("unverified install configuration entry: " + key);
    for (const name of [
      "dir",
      "workspace_dir",
      "prefix",
      "global",
      "workspace",
      "workspaces",
      "install_links",
      "modules_dir",
      "virtual_store_dir",
      "lockfile_dir",
      "store_dir",
      "global_virtual_store_dir",
      "enable_global_virtual_store",
      "node_linker",
    ]) {
      for (const key of [
        "npm_config_" + name,
        "NPM_CONFIG_" + name.toUpperCase(),
        "pnpm_config_" + name,
        "PNPM_CONFIG_" + name.toUpperCase(),
      ])
        if (process.env[key]) reject("unsupported install path override: " + key);
    }
    const verifyConfiguration = () => {
      for (const [file, expected] of configuration) {
        let current = null;
        try {
          const info = lstatSync(file);
          if (!info.isFile() || realpathSync(file) !== file)
            reject("install configuration changed: " + file);
          current = readFileSync(file, "utf8");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (current !== expected) reject("install configuration changed: " + file);
      }
    };
    const beforeInstall = ({ name, source, directory }) => {
      if (realpathSync(directory) !== directory) reject("real install directory required: " + name);
      verifyConfiguration();
      if (
        JSON.stringify(material(name, directory, source.head, source.packageManager)) !==
        JSON.stringify({ ...source, path: directory })
      )
        reject("install source changed: " + name);
      try {
        lstatSync(join(directory, "node_modules"));
        reject("independent fresh node_modules required: " + name);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    };
    const installs = installCommands();
    try {
      await step("package-manager-readiness", async () => {
        for (const task of tasks) {
          beforeInstall(task);
          if (
            (await installs.run(task.binary, [...task.prefix, "--version"], task.directory)) !==
            task.source.packageManager.split("@")[1]
          )
            reject("actual package manager changed: " + task.name);
        }
      });
      await step("package-manager-paths", async () => {
        const facts = [];
        let queryCount = 0;
        for (const task of tasks) {
          queryCount++;
          const modules = join(task.directory, "node_modules");
          const actualRoot = await installs.run(
            task.binary,
            [...task.prefix, "root", "--silent"],
            task.directory,
          );
          if (actualRoot !== modules)
            reject("effective install path changed: " + task.name + " modulesDir");
          const current = { name: task.name, modulesDir: modules, unset: [] };
          if (task.binary !== "npm") {
            // Fixed pnpm 11 getters normalize kebab/camel names and omit unset keys.
            // Read the module root directly; the install flag enforces a local store
            // instead of treating an empty global-store getter as proof of safety.
            for (const [key, fallback] of Object.entries({
              virtualStoreDir: "node_modules/.pnpm",
              enableGlobalVirtualStore: false,
            })) {
              queryCount++;
              const raw = await installs.run(
                task.binary,
                [...task.prefix, "config", "get", "--json", key],
                task.directory,
              );
              let value;
              try {
                value = raw === "undefined" || raw === "" ? undefined : JSON.parse(raw);
              } catch {
                reject("effective install path unreadable: " + task.name + " " + key);
              }
              if (value == null) current.unset.push(key);
              const actual = value ?? fallback;
              if (key === "enableGlobalVirtualStore") {
                if (actual !== false)
                  reject("effective install path changed: " + task.name + " " + key);
                current[key] = false;
                current.globalVirtualStoreOrigin =
                  value == null ? "enforced-by-install-flag" : "observed-false-and-enforced";
              } else {
                if (
                  typeof actual !== "string" ||
                  resolve(task.directory, actual) !== join(modules, ".pnpm")
                )
                  reject("effective install path changed: " + task.name + " " + key);
                current[key] = resolve(task.directory, actual);
              }
            }
            queryCount++;
            const rawConfigPath = await installs.run(
              task.binary,
              [...task.prefix, "config", "get", "--json", "globalconfig"],
              task.directory,
            );
            let config;
            try {
              config = JSON.parse(rawConfigPath);
            } catch {
              reject("effective install configuration path unreadable: " + task.name);
            }
            if (typeof config !== "string" || !isAbsolute(config))
              reject("effective install configuration path required: " + task.name);
            current.globalConfigPath = config;
          }
          facts.push(current);
        }
        return { queryCount, facts };
      });
      for (const task of tasks) beforeInstall(task);
      for (const batch of early
        ? [
            tasks.filter((x) => x.name !== "dsh-gea-plugin"),
            tasks.filter((x) => x.name === "dsh-gea-plugin"),
          ]
        : [tasks]) {
        if (early && batch[0]?.name === "dsh-gea-plugin") {
          if (sourceControl.runtime)
            await step("early-browser-system-libraries", async () => {
              verifyConfiguration();
              const declared = (directory) => {
                const pkg = json(join(directory, "package.json"));
                return (
                  pkg.devDependencies?.["@playwright/test"] ??
                  pkg.dependencies?.["@playwright/test"]
                );
              };
              const version = declared(p.gea);
              if (
                typeof version !== "string" ||
                !/^\d+\.\d+\.\d+$/.test(version) ||
                declared(p.manage) !== version
              )
                return { status: "deferred", reason: "declared Playwright versions incompatible" };
              const before = readBrowserDependencyClosure({ directory: p.manage, version });
              if (before.status === "deferred") return before;
              await installs.run(
                process.execPath,
                [before.executable, "install-deps", "chromium"],
                p.manage,
              );
              const after = readBrowserDependencyClosure({ directory: p.manage, version });
              if (executionDigest(before) !== executionDigest(after))
                reject("early browser CLI changed its shipped packages");
              verifyConfiguration();
              earlyBrowserLibraries = before.inventory;
              return {
                status: "executed",
                inventorySha256: executionDigest(before.inventory),
                localWiring: before.localWiring,
                localWiringSha256: executionDigest(before.localWiring),
                packageEntries: before.inventory.packages.map((x) => ({
                  name: x.name,
                  entries: x.entries.length,
                })),
              };
            });
          await receivePrepared(installs);
          verifyConfiguration();
        }
        const pending = [...batch],
          active = new Map();
        let firstError;
        const overlaps = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
        while (pending.length || active.size) {
          while (!firstError && !installs.error() && active.size < 2) {
            const at = pending.findIndex(
              (task) =>
                ![...active.values()].some((other) => overlaps(task.directory, other.directory)),
            );
            if (at < 0) break;
            const task = pending.splice(at, 1)[0];
            const running = step("install:" + task.name, async () => {
              beforeInstall(task);
              await installs.run(
                task.binary,
                [
                  ...task.prefix,
                  ...(task.binary === "npm"
                    ? ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"]
                    : [
                        "install",
                        "--frozen-lockfile",
                        "--ignore-scripts",
                        "--prefer-offline",
                        "--config.enable-global-virtual-store=false",
                      ]),
                ],
                task.directory,
              );
              if (
                JSON.stringify(
                  material(task.name, task.directory, task.source.head, task.source.packageManager),
                ) !== JSON.stringify({ ...task.source, path: task.directory })
              )
                reject("installation changed package/lock: " + task.name);
              const modules = join(task.directory, "node_modules"),
                real = realpathSync(modules);
              if (real !== modules || !lstatSync(modules).isDirectory() || roots.has(real))
                reject("shared dependency directory");
              roots.add(real);
              return {
                directory: task.directory,
                packageManager: task.source.packageManager,
                dependencies: real,
              };
            })
              .catch((e) => {
                firstError = installs.stop(e);
              })
              .finally(() => active.delete(running));
            active.set(running, task);
          }
          if (active.size) await Promise.race(active.keys());
          firstError ??= installs.error();
          if (firstError) {
            await Promise.all(active.keys());
            throw firstError;
          }
        }
      }
      if (earlyBrowserLibraries)
        await step("browser-library-cli-equivalence", () => {
          const current = readBrowserDependencyClosure({
            directory: p.gea,
            version: earlyBrowserLibraries.version,
          });
          if (
            !binding.worker.browser ||
            current.status !== "passed" ||
            executionDigest(current.inventory) !== executionDigest(earlyBrowserLibraries)
          )
            reject("received GEA Playwright closure differs from executed early CLI");
          return {
            status: "passed",
            inventorySha256: executionDigest(current.inventory),
            localWiring: current.localWiring,
            localWiringSha256: executionDigest(current.localWiring),
          };
        });
    } catch (error) {
      throw installs.error() ?? error;
    } finally {
      await installs.close();
    }
    await step("sdk-cache", async () => {
      const cache = await import(pathToFileURL(join(p.manage, "scripts/sdk-artifact-cache.mjs")));
      if (cache.verifySDKArtifacts(p.core, binding.worker.sdkIdentity) !== true)
        reject("SDK cache inventory required");
      return { identity: binding.worker.sdkIdentity };
    });
    if (binding.worker.runtime)
      await step("workbench-assets", () =>
        prepareWorkbenchAssets({
          source: p.wb,
          prepared: p.prepared,
          head: binding.manifest.repositories.find((x) => x.repo === "dsh-agent-workbench").head,
          receipt: join(p.root, "prepared-workbench.json"),
          assets: join(p.root, "prepared-workbench-assets"),
        }),
      );
    if (binding.worker.browser) {
      await step("system-chrome-mount", () =>
        mountSystemChrome({ root: p.root, expected: binding.worker.browser.systemChrome }),
      );
      await step("browser-system-libraries", () => {
        if (earlyBrowserLibraries)
          return {
            command: "previous owned Node Playwright install-deps chromium",
            status: "executed-before-producer-wait",
            inventorySha256: executionDigest(earlyBrowserLibraries),
          };
        command("corepack", ["pnpm", "exec", "playwright", "install-deps", "chromium"], p.gea);
        return { command: "corepack pnpm exec playwright install-deps chromium" };
      });
      await step("browser-availability", async () => {
        const current = browserMetadata(p, true);
        if (JSON.stringify(current) !== JSON.stringify(binding.worker.browser))
          reject("local Chrome/Playwright version changed");
        process.env.PLAYWRIGHT_BROWSERS_PATH = join(p.root, ".quality-browser");
        const require = createRequire(join(p.gea, "package.json"));
        const { chromium } = require("@playwright/test");
        const executable = chromium.executablePath();
        if (
          !realpathSync(executable).startsWith(join(p.root, ".quality-browser") + "/") ||
          !(statSync(executable).mode & 0o111)
        )
          reject("received Chromium executable required");
        const probes = [];
        for (const options of [{ channel: "chrome", headless: true }, { headless: true }]) {
          const browser = await chromium.launch(options);
          try {
            probes.push({ ...options, version: browser.version() });
          } finally {
            await browser.close();
          }
        }
        return { ...current, executable, probes };
      });
    }
    await step("sources-unchanged", () => {
      admitted.verifyUnchanged();
      const actual = baseMetadata(p, binding.manifest);
      if (
        JSON.stringify(actual.sources) !== JSON.stringify(binding.worker.sources.slice(0, 4)) ||
        JSON.stringify(actual.tools) !== JSON.stringify(binding.worker.tools) ||
        JSON.stringify(additionalSources(p, binding.worker.runtime)) !==
          JSON.stringify(binding.worker.sources.slice(4))
      )
        reject("source metadata changed during preparation");
    });
    record.status = "worker-inputs-ready";
    return record;
  } catch (e) {
    record.status = "failed";
    record.error = e.message;
    throw e;
  } finally {
    record.finishedAt = new Date().toISOString();
    record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
    writeExecutionReceipt(receipt, record);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        [
          "root",
          "binding",
          "manifest",
          "bundle",
          "manifest-sha256",
          "early-control",
          "early-sha256",
        ].map((x) => [x, { type: "string" }]),
      ),
    });
    console.log(JSON.stringify(await prepareWorkerInputs(values)));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
