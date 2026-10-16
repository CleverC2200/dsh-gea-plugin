/** Source-only scheduling controls and bounded same-attempt producer rendezvous. */
import { setTimeout } from "node:timers/promises";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  lstatSync,
  appendFileSync,
  readlinkSync,
} from "node:fs";
import { resolve, join, dirname, relative as relativePath } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as execution from "./quality-test-execution.mjs";

const reject = (detail) => {
  throw Error("QUALITY_WORKER_CONTROL_REJECTED: " + detail);
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(readFileSync(file));
const equal = isDeepStrictEqual;
const sources = (entries) =>
  entries.map(({ repo, head }) => ({ repo, head })).sort((a, b) => a.repo.localeCompare(b.repo));

/** Inventory only the supported shipped Playwright CLI closure, never unrelated modules. */
export function readBrowserDependencyClosure({ directory, version }) {
  const modules = realpathSync(join(directory, "node_modules"));
  if (modules !== join(directory, "node_modules")) reject("browser dependency modules redirected");
  let require = createRequire(join(directory, "package.json"));
  const records = [];
  for (const name of ["@playwright/test", "playwright", "playwright-core"]) {
    const manifest = require.resolve(name + "/package.json"),
      root = realpathSync(dirname(manifest));
    if (!root.startsWith(modules + "/") || realpathSync(manifest) !== join(root, "package.json"))
      reject("browser dependency escaped owned modules");
    const metadata = json(manifest);
    const dependency =
      name === "@playwright/test"
        ? { playwright: version }
        : name === "playwright"
          ? { "playwright-core": version }
          : {};
    if (metadata.name !== name || metadata.version !== version)
      reject("browser dependency identity changed");
    if (
      !equal(metadata.dependencies ?? {}, dependency) ||
      !equal(
        metadata.optionalDependencies ?? {},
        name === "playwright" ? { fsevents: "2.3.2" } : {},
      ) ||
      !equal(metadata.bin, {
        [name === "playwright-core" ? "playwright-core" : "playwright"]: "cli.js",
      })
    )
      return { status: "deferred", reason: "unsupported Playwright three-package closure" };
    records.push({
      name,
      root,
      dependency,
      require: createRequire(manifest),
      binName: Object.keys(metadata.bin)[0],
    });
    require = createRequire(manifest);
  }
  const modeOf = (info) => {
    const mode = info.mode & 0o7777;
    if (mode > 0o777) reject("browser dependency special mode");
    return mode;
  };
  const packages = [],
    localWiring = [];
  for (const record of records) {
    const { name, root, dependency } = record,
      entries = [],
      wiring = [];
    const dependencies = Object.keys(dependency).map((dep) => records.find((x) => x.name === dep));
    for (const dep of dependencies) {
      let found = false;
      for (const search of record.require.resolve.paths(dep.name)) {
        const candidate = join(search, dep.name);
        let info;
        try {
          info = lstatSync(candidate);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (
          !candidate.startsWith(modules + "/") ||
          realpathSync(candidate) !== dep.root ||
          (!info.isSymbolicLink() && (!info.isDirectory() || candidate !== dep.root))
        )
          reject("browser dependency lookup escaped resolved closure");
        wiring.push({
          path: relativePath(modules, candidate),
          type: info.isSymbolicLink() ? "dependency-link" : "dependency-root",
          mode: modeOf(info),
          target: info.isSymbolicLink() ? readlinkSync(candidate) : null,
          identity: dep.name,
        });
        found = true;
        break;
      }
      if (!found) reject("browser dependency lookup missing");
    }
    // These exact manager-created shims are never executed or added to PATH.
    // The caller uses absolute Node plus the declared CLI; retain local bytes before/after.
    const generated = (file) => {
      const info = lstatSync(file),
        mode = modeOf(info);
      if (!info.isDirectory() || info.isSymbolicLink())
        reject("browser local node_modules directory required");
      wiring.push({ path: "node_modules", type: "directory", mode });
      for (const child of readdirSync(file).sort()) {
        const path = join(file, child),
          info = lstatSync(path),
          mode = modeOf(info);
        if (child === ".bin") {
          if (!info.isDirectory() || info.isSymbolicLink())
            reject("browser local bin directory required");
          wiring.push({ path: "node_modules/.bin", type: "directory", mode });
          for (const bin of readdirSync(path).sort()) {
            const expected = dependencies.find((dep) => dep.binName === bin),
              target = join(path, bin),
              binInfo = lstatSync(target),
              binMode = modeOf(binInfo);
            if (!expected || (!binInfo.isFile() && !binInfo.isSymbolicLink()))
              reject("unexpected browser local bin");
            if (binInfo.isSymbolicLink() && realpathSync(target) !== join(expected.root, "cli.js"))
              reject("browser local bin escaped resolved closure");
            wiring.push({
              path: "node_modules/.bin/" + bin,
              type: binInfo.isSymbolicLink() ? "link" : "shim",
              mode: binMode,
              ...(binInfo.isSymbolicLink()
                ? { target: readlinkSync(target) }
                : { sha256: sha(readFileSync(target)) }),
              identity: expected.name,
            });
          }
        } else {
          const expected = dependencies.find((dep) => dep.name === child);
          if (!expected || !info.isSymbolicLink() || realpathSync(path) !== expected.root)
            reject("unexpected browser local dependency");
          wiring.push({
            path: "node_modules/" + child,
            type: "link",
            mode,
            target: readlinkSync(path),
            identity: expected.name,
          });
        }
      }
    };
    const visit = (relative) => {
      const file = join(root, relative);
      // Deeper vendored directories with this name remain shipped resources.
      if (relative === "node_modules") {
        generated(file);
        return;
      }
      const info = lstatSync(file),
        mode = modeOf(info);
      if (info.isSymbolicLink()) {
        if (!realpathSync(file).startsWith(root + "/"))
          reject("browser dependency link escaped package");
        entries.push({ path: relative, type: "link", mode, target: readlinkSync(file) });
      } else if (info.isDirectory()) {
        entries.push({ path: relative, type: "directory", mode });
        for (const child of readdirSync(file).sort())
          visit(relative ? relative + "/" + child : child);
      } else if (info.isFile())
        entries.push({ path: relative, type: "file", mode, sha256: sha(readFileSync(file)) });
      else reject("unsupported browser dependency entry");
    };
    visit("");
    const bin = join(root, "cli.js");
    if (realpathSync(bin) !== bin || !lstatSync(bin).isFile()) reject("browser CLI bin redirected");
    packages.push({
      name,
      entries,
      dependencies: dependencies.map((dep) => ({
        name: dep.name,
        version,
        bin: "cli.js",
        binName: dep.binName,
      })),
    });
    localWiring.push({ package: name, entries: wiring });
  }
  return {
    status: "passed",
    executable: join(records[0].root, "cli.js"),
    localWiring,
    inventory: { version, packages, bin: { package: "@playwright/test", path: "cli.js" } },
  };
}

export function verifyWorkerControl(control, expected) {
  if (
    !equal(
      Object.keys(control).sort(),
      [
        "schemaVersion",
        "scope",
        "repository",
        "candidateBytes",
        "groupBytes",
        "plan",
        "metadata",
        "admission",
        "runtime",
      ].sort(),
    )
  )
    reject("unexpected early control fields");
  execution.verifyExecutionPlan(control.plan);
  const binding = control.plan.binding,
    candidate = JSON.parse(control.candidateBytes),
    group = JSON.parse(control.groupBytes);
  if (
    control.schemaVersion !== 1 ||
    control.scope !== "source-plan-only" ||
    !equal(candidate, binding.manifest) ||
    sha(control.candidateBytes) !== binding.inputSha256 ||
    control.admission?.status !== "passed" ||
    control.admission.inputSha256 !== binding.inputSha256 ||
    !equal(sources(control.admission.repositories), sources(candidate.repositories)) ||
    control.metadata?.sources?.length !== 4 ||
    control.runtime !== control.plan.shards.some((shard) => shard.runtimeFiles.length > 0)
  )
    reject("early source control changed");
  if (
    expected &&
    (control.repository !== expected.repository ||
      !expected.cores.includes(candidate.core) ||
      !equal(sources(candidate.repositories), sources(expected.sources)) ||
      String(binding.runId) !== String(expected.runId) ||
      String(binding.runAttempt) !== String(expected.runAttempt) ||
      binding.node !== expected.node ||
      binding.platform !== "linux" ||
      group.groupId !== expected.groupId)
  )
    reject("early source/run/environment changed");
  return control;
}
export function readWorkerControl({ root, file, sha256 }) {
  const path = resolve(file);
  if (
    !path.startsWith(resolve(root) + "/") ||
    realpathSync(path) !== path ||
    !lstatSync(path).isFile()
  )
    reject("private original early control required");
  const bytes = readFileSync(path);
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? "") || sha(bytes) !== sha256)
    reject("early control bytes changed");
  return verifyWorkerControl(JSON.parse(bytes));
}
export function createEarlyAllocation({ controls, expected }) {
  if (
    !expected?.cores?.length ||
    new Set(expected.cores).size !== expected.cores.length ||
    controls.length !== expected.cores.length ||
    new Set(controls.map((x) => x.control.plan.binding.manifest.core)).size !== controls.length
  )
    reject("all unique required Core controls required");
  const ordered = expected.cores.map((core) =>
    controls.find((x) => x.control.plan.binding.manifest.core === core),
  );
  if (ordered.some((item) => !item)) reject("required Core control missing");
  const include = ordered.flatMap(({ control, sha256 }) => {
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? "")) reject("original control SHA required");
    verifyWorkerControl(control, expected);
    return control.plan.shards.map((shard) => ({
      core: control.plan.binding.manifest.core,
      shard: shard.id,
      shardCount: control.plan.shards.length,
      nodeVersion: expected.node,
      phase: control.plan.binding.phase,
      inputSha256: control.plan.binding.inputSha256,
      planSha256: control.plan.planSha256,
      controlSha256: sha256,
    }));
  });
  if (include.length > 14) reject("fourteen worker limit");
  return {
    schemaVersion: 1,
    scope: "source-plan-only",
    expected,
    matrix: { include },
    hasShards: include.length > 0,
  };
}
export async function verifyWorkerIndex({ control, index }) {
  const candidate = control.plan.binding.manifest;
  const expected = {
    cores: [candidate.core],
    runId: control.plan.binding.runId,
    runAttempt: control.plan.binding.runAttempt,
    node: control.plan.binding.node,
    groupId: JSON.parse(control.groupBytes).groupId,
    sources: candidate.repositories,
  };
  const { createShardCatalog } = await import("./quality-shards.mjs");
  createShardCatalog({ indexes: [index], expected });
  if (
    !equal(control.plan, index.plan) ||
    !equal(control.metadata.sources, index.binding.worker.sources.slice(0, 4)) ||
    !equal(control.metadata.tools, index.binding.worker.tools) ||
    !equal(control.metadata.sdkIdentity, index.binding.worker.sdkIdentity) ||
    control.runtime !== index.binding.worker.runtime ||
    sha(control.candidateBytes) !== index.binding.inputSha256 ||
    index.groupId !== expected.groupId
  )
    reject("producer index differs from early source plan");
  return index;
}
export async function createWorkerCatalog({ controls, indexes, allocation, expected }) {
  if (!equal(allocation, createEarlyAllocation({ controls, expected })))
    reject("early allocation changed");
  const { repository: _repository, ...catalogExpected } = expected;
  const { createShardCatalog } = await import("./quality-shards.mjs");
  const result = createShardCatalog({ indexes, expected: catalogExpected });
  for (const { control } of controls)
    await verifyWorkerIndex({
      control,
      index: indexes.find((entry) => entry.core === control.plan.binding.manifest.core),
    });
  result.requiredJobs.push(...expected.cores.map((core) => "source-plan-" + core));
  return result;
}
export async function readWorkerCatalog({ controls, indexes, allocation, expected }) {
  return createWorkerCatalog({
    controls: readControls(controls),
    indexes,
    allocation: json(allocation),
    expected,
  });
}
function readControls(directory, filename = "control.json") {
  const files = [];
  const append = (file, entry) => {
    if (!entry.isFile() || entry.name !== filename || realpathSync(file) !== resolve(file))
      reject("unexpected control/index entry");
    files.push(file);
  };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      const children = readdirSync(file, { withFileTypes: true });
      if (children.length !== 1) reject("one original control/index file required");
      for (const child of children) append(join(file, child.name), child);
    } else append(file, entry);
  }
  return files.sort().map((file) => {
    const bytes = readFileSync(file);
    return { control: JSON.parse(bytes), sha256: sha(bytes) };
  });
}

export async function workerControlCli(args) {
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(
      ["mode", "root", "output", "controls", "expected", "indexes", "allocation"].map((name) => [
        name,
        { type: "string" },
      ]),
    ),
  });
  let result;
  if (values.mode === "freeze") {
    const { createWorkerSourceControl } = await import("./quality-worker-inputs.mjs");
    result = createWorkerSourceControl({
      root: values.root,
      executionPlan: json(join(values.root, "quality-test-execution-plan.json")),
    });
  } else if (values.mode === "plan") {
    result = createEarlyAllocation({
      controls: readControls(values.controls),
      expected: json(values.expected),
    });
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify(result.matrix)}\nhas-shards=${result.hasShards}\n`,
      );
  } else if (values.mode === "catalog") {
    const allocation = json(values.allocation);
    result = await readWorkerCatalog({
      controls: values.controls,
      indexes: readControls(values.indexes, "quality-index.json").map((entry) => entry.control),
      allocation: values.allocation,
      expected: allocation.expected,
    });
  } else reject("control mode");
  writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  return result;
}
export async function waitForWorkerArtifacts({
  expected,
  core,
  token,
  apiBase = "https://api.github.com",
  timeoutMs = 300000,
  pollMs = 10000,
  signal,
}) {
  const base = new URL(apiBase);
  if (
    (base.origin !== "https://api.github.com" &&
      !(
        base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      )) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !/^[\w.-]+\/[\w.-]+$/.test(expected?.repository ?? "") ||
    expected.repository.split("/").some((part) => [".", ".."].includes(part)) ||
    !/^[1-9]\d*$/.test(String(expected.runId)) ||
    !Number.isSafeInteger(Number(expected.runId)) ||
    !/^[1-9]\d*$/.test(String(expected.runAttempt)) ||
    !Number.isSafeInteger(Number(expected.runAttempt)) ||
    !/^[a-f0-9]{40}$/.test(expected.headSha ?? "") ||
    !/^[a-f0-9]{40}$/.test(core ?? "") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600000 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 10000
  )
    reject("fixed hosted wait inputs required");
  const deadline = performance.now() + timeoutMs;
  const remaining = () => {
    signal?.throwIfAborted();
    const value = Math.ceil(deadline - performance.now());
    if (value <= 0) reject("producer wait deadline exceeded");
    return value;
  };
  const prefix = `/repos/${expected.repository}/actions/runs/${expected.runId}`;
  const attempt = prefix + `/attempts/${expected.runAttempt}`;
  const get = async (path) => {
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(Math.min(15000, remaining())),
      ...(signal ? [signal] : []),
    ]);
    let response;
    try {
      response = await fetch(new URL(path, base), {
        signal: requestSignal,
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
      });
    } catch {
      reject("hosted API read failed or wait cancelled");
    }
    if (!response.ok) reject("hosted API status " + response.status);
    try {
      return await response.json();
    } catch {
      reject("hosted API JSON required");
    }
  };
  const pages = async (path, key) => {
    const rows = [];
    let total;
    for (let page = 1; total === undefined || rows.length < total; page++) {
      const body = await get(path + `?per_page=100&page=${page}`);
      if (
        !Number.isSafeInteger(body.total_count) ||
        body.total_count < 0 ||
        !Array.isArray(body[key]) ||
        body[key].length > 100 ||
        (total !== undefined && total !== body.total_count) ||
        (page > 1 && !body[key].length)
      )
        reject("incomplete hosted " + key);
      total ??= body.total_count;
      rows.push(...body[key]);
      if (rows.length > total) reject("duplicate hosted page");
    }
    if (new Set(rows.map((row) => row.id)).size !== rows.length) reject("duplicate hosted ID");
    return rows;
  };
  while (true) {
    remaining();
    const run = await get(attempt);
    if (
      String(run.id) !== String(expected.runId) ||
      String(run.run_attempt) !== String(expected.runAttempt) ||
      run.head_sha !== expected.headSha
    )
      reject("run/attempt/head changed");
    if (
      !["queued", "in_progress", "completed", "waiting", "pending", "requested"].includes(
        run.status,
      )
    )
      reject("unknown run status");
    if (
      ["cancelled", "failure", "timed_out", "action_required", "startup_failure", "stale"].includes(
        run.conclusion,
      )
    )
      reject("producer run failed/cancelled");
    const producers = (await pages(attempt + "/jobs", "jobs")).filter(
      (job) => job.name === "prepare-" + core,
    );
    if (producers.length > 1) reject("duplicate producer");
    const producer = producers[0];
    if (
      producer &&
      (!Number.isSafeInteger(producer.id) ||
        producer.id < 1 ||
        String(producer.run_id) !== String(expected.runId) ||
        producer.head_sha !== expected.headSha)
    )
      reject("producer identity changed");
    if (
      producer &&
      !["queued", "in_progress", "completed", "waiting", "pending"].includes(producer.status)
    )
      reject("unknown producer status");
    if (producer?.status === "completed" && producer.conclusion !== "success")
      reject("producer failed/cancelled");
    if (producer?.status === "completed") {
      const artifacts = await pages(prefix + "/artifacts", "artifacts");
      const match = (kind) => {
        const name = `quality-a${expected.runAttempt}-${kind}-${core}`;
        const matches = artifacts.filter((artifact) => artifact.name === name);
        if (matches.length !== 1) reject("missing/duplicate " + kind + " artifact");
        const artifact = matches[0];
        if (
          !Number.isSafeInteger(artifact.id) ||
          artifact.id < 1 ||
          artifact.expired !== false ||
          String(artifact.workflow_run?.id) !== String(expected.runId) ||
          artifact.workflow_run.head_sha !== expected.headSha
        )
          reject("artifact run/head/expiry changed");
        return { id: artifact.id, name };
      };
      remaining();
      return {
        producer: { id: producer.id, status: "success" },
        index: match("index"),
        bundle: match("bundle"),
      };
    }
    if (run.status === "completed") reject("completed run lacks successful producer");
    await setTimeout(Math.min(pollMs, remaining()), undefined, { signal });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  workerControlCli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
