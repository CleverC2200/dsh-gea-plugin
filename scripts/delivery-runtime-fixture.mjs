/** Explicit test setup only. Never imported by the delivery checker. */
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { checkDelivery } from "./delivery-check.mjs";
const hash = (v) => createHash("sha256").update(v).digest("hex");
// Explicit fixture preparation is outside checkDelivery and does not use an active environment.
export async function prepareRuntimeFixture(request, when) {
  const root = await realpath(request.root),
    task = request.tasks[0],
    taskId = task.id;
  const candidate = JSON.parse(await readFile(join(root, task.candidate.path), "utf8"));
  if (!candidate.checkout) {
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args) =>
      execFileSync("/usr/bin/git", args, {
        cwd: source,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
      }).trim();
    git("init", "-q");
    await writeFile(join(source, "source.js"), "fixed source");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    candidate.commit = git("rev-parse", "HEAD");
    candidate.checkout = { path: "source" };
    await writeFile(join(root, task.candidate.path), JSON.stringify(candidate));
  }
  if (!task.session) {
    task.session = { id: "session", path: "retained-state" };
    await mkdir(join(root, "retained-state"));
    await writeFile(join(root, "retained-state/entity.json"), "persistent fixture data");
  }
  task.inputs ??= [];
  async function put(id, value) {
    let ref = task.inputs.find((v) => v.id === id);
    if (!ref) {
      ref = { id, path: `${id}.json` };
      task.inputs.push(ref);
    }
    await writeFile(join(root, ref.path), JSON.stringify(value));
  }
  const envelope = {
    taskId,
    projectId: request.projectId,
    observation: "official-snapshot",
    observedAt: when.observedAt,
    provenance: {
      interface: "official-tool-result",
      threadId: "executor",
      itemId: "snapshot-item",
    },
  };
  const ownership = {
    ...envelope,
    kind: "execution-ownership",
    actualTaskId: taskId,
    threadId: "executor",
    actualProjectId: request.projectId,
    checkout: candidate.checkout.path,
    writers: [{ taskId, threadId: "executor", roundId: "round", state: "idle" }],
  };
  const runtime = {
    kind: "runtime-evidence",
    taskId,
    projectId: request.projectId,
    ownership: "ownership",
    runs: [],
    handoffs: [],
    tools: [],
    repairs: [],
  };
  await put("ownership", ownership);
  await put("runtime", runtime);
  const f = {
    root,
    task,
    request,
    candidate,
    envelope,
    ownership,
    runtime,
    put,
    run: async () => (await checkDelivery(request, when)).tasks[0],
  };
  const combinationId = "11111111-1111-1111-1111-111111111111",
    component = "@fixture/plugin";
  const directory = join(f.root, "runtime/source-combinations", combinationId),
    target = join(directory, "node_modules", component);
  await mkdir(target, { recursive: true });
  const resources = {
    "package.json": JSON.stringify({
      name: component,
      version: "1.0.0",
      main: "host.js",
      exports: { "./client": "client.js" },
    }),
    "host.js": "host artifact",
    "client.js": "client artifact",
  };
  const files = {},
    artifacts = [];
  for (const [file, bytes] of Object.entries(resources)) {
    await writeFile(join(target, file), bytes);
    await writeFile(join(f.root, file), bytes);
    files[`node_modules/${component}/${file}`] = hash(bytes);
    artifacts.push({
      id: `artifact-${file.replaceAll(".", "-")}`,
      component,
      file,
      path: file,
      sha256: hash(bytes),
    });
  }
  const plugins = JSON.stringify({
    [component]: {
      commit: f.candidate.commit,
      dirty: "",
      source: join(f.root, "source"),
      version: "1.0.0",
      digests: Object.fromEntries(
        Object.entries(resources).map(([file, bytes]) => [file, hash(bytes)]),
      ),
    },
  });
  await writeFile(join(directory, "company-plugins.json"), plugins);
  files["company-plugins.json"] = hash(plugins);
  await mkdir(join(f.root, "external"));
  await writeFile(join(f.root, "external/core.js"), "core dependency");
  await writeFile(join(f.root, "lock.yaml"), "lock bytes");
  const manifest = JSON.stringify({
    composition: { id: combinationId, dependencies: { [component]: "1.0.0" } },
    core: f.candidate.commit,
    files,
    externalRoots: [join(f.root, "external")],
    externalLockFiles: [join(f.root, "lock.yaml")],
    externalFiles: {
      [join(f.root, "external/core.js")]: hash("core dependency"),
      [join(f.root, "lock.yaml")]: hash("lock bytes"),
    },
    locks: { core: {} },
  });
  await writeFile(join(directory, "combination.json"), manifest);
  const selection = JSON.stringify({
    id: combinationId,
    manifestSha256: hash(manifest),
  });
  await writeFile(join(f.root, "runtime/source-selection.json"), selection);
  await writeFile(join(f.root, "build.mjs"), "build input");
  const current = await f.run();
  const assembly = {
    taskId,
    projectId: request.projectId,
    runtime: "runtime",
    combinationId,
    manifestSha256: hash(manifest),
    selectionSha256: hash(selection),
    candidateSha256: current.candidate.sha256,
    candidateContentSha256: current.candidate.contentSha256,
    core: { path: "source", commit: f.candidate.commit },
    component,
    buildInputs: [{ id: "build", path: "build.mjs", sha256: hash("build input") }],
    artifacts,
  };
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(assembly));
  f.task.assembly = { id: "assembly", path: "assembly.json" };
  const run = {
    ...f.envelope,
    kind: "runtime-observation",
    runId: "run22",
    combinationId,
    manifestSha256: assembly.manifestSha256,
    selectionSha256: assembly.selectionSha256,
    candidateSha256: assembly.candidateSha256,
    candidateContentSha256: assembly.candidateContentSha256,
    lifecycleOwnerId: "service-owner",
    browserOwnerId: ownership.threadId,
    persistentSourceIds: ["session"],
    mode: "fixture",
    facts: [{ fact: "service", state: "started" }],
  };
  f.runtime.runs = ["run"];
  await f.put("run", run);
  await f.put("runtime", f.runtime);
  return { ...f, assembly, runRecord: run };
}
