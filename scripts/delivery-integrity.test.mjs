import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  readdir,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { checkDelivery } from "./delivery-check.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const when = { observedAt: "2026-10-03T00:00:00.000Z" };
const stage = (task, name) => task.stages.find((s) => s.stage === name);
async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "delivery-integrity-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args) =>
    execFileSync("/usr/bin/git", args, {
      cwd: source,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git("init", "-q");
  await writeFile(join(source, "source.js"), "reviewed source\n");
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
  const candidate = {
    taskId: "15",
    projectId: "split",
    kind: "clean",
    commit: git("rev-parse", "HEAD"),
    checkout: { path: "source" },
  };
  await writeFile(join(root, "candidate.json"), JSON.stringify(candidate));
  await writeFile(
    join(root, "ticket.md"),
    "# 15: fixture\n\n**Status:** in-progress\n",
  );
  const delivery = {
    taskId: "15",
    projectId: "split",
    requiredChecks: ["review"],
    checks: [
      {
        id: "review",
        scope: "offline",
        status: "passed",
        candidateSha256: hash(JSON.stringify(candidate)),
        inputs: [],
        observedAt: when.observedAt,
      },
    ],
  };
  await writeFile(join(root, "delivery.json"), JSON.stringify(delivery));
  const request = {
    root,
    projectId: "split",
    tasks: [
      {
        id: "15",
        ticket: { id: "ticket", path: "ticket.md" },
        candidate: { id: "candidate", path: "candidate.json" },
        delivery: { id: "delivery", path: "delivery.json" },
      },
    ],
  };
  delivery.checks[0].candidateContentSha256 = (
    await checkDelivery(request, when)
  ).tasks[0].candidate.contentSha256;
  await writeFile(join(root, "delivery.json"), JSON.stringify(delivery));
  return {
    root,
    source,
    git,
    candidate,
    delivery,
    request,
    run: async () => (await checkDelivery(request, when)).tasks[0],
  };
}
test("clean complete candidate is verified from actual Git and source without promoting assembly", async (t) => {
  const f = await fixture(t);
  const task = await f.run();
  assert.equal(
    stage(task, "source-candidate").status,
    "passed",
    stage(task, "source-candidate").reason,
  );
  assert.equal(task.candidate.proof, "complete-checkout");
  assert.equal(stage(task, "frozen-assembly").status, "not-run");
  await writeFile(join(f.source, "extra.js"), "new unreviewed source");
  const changed = await f.run();
  assert.equal(stage(changed, "source-candidate").status, "failed");
  assert.equal(
    stage(changed, "source-candidate").reason,
    "CANDIDATE_INVENTORY_MISMATCH",
  );
  assert.notEqual(
    changed.candidate.contentSha256,
    task.candidate.contentSha256,
  );
  assert.equal(changed.checks[0].relation, "candidate-content-mismatch");
});
test("dirty candidate names every changed and deleted file; same HEAD drift invalidates related review only", async (t) => {
  const f = await fixture(t);
  await rm(join(f.source, "source.js"));
  await writeFile(join(f.source, "added.js"), "candidate bytes");
  await writeFile(join(f.root, "rules.txt"), "stable rules");
  f.candidate.kind = "dirty";
  f.candidate.files = [
    { id: "deleted", path: "source/source.js", deleted: true },
    { id: "added", path: "source/added.js", sha256: hash("candidate bytes") },
  ];
  const bytes = JSON.stringify(f.candidate);
  await writeFile(join(f.root, "candidate.json"), bytes);
  f.delivery.checks[0].candidateSha256 = hash(bytes);
  f.delivery.checks[0].candidateContentSha256 = (
    await f.run()
  ).candidate.contentSha256;
  f.delivery.checks.push({
    ...f.delivery.checks[0],
    id: "independent-rules",
    candidateBinding: "inputs-only",
    candidateSha256: "b".repeat(64),
    inputs: [{ id: "rules", sha256: hash("stable rules") }],
  });
  await writeFile(join(f.root, "delivery.json"), JSON.stringify(f.delivery));
  f.request.tasks[0].inputs = [{ id: "rules", path: "rules.txt" }];
  const before = await f.run();
  assert.equal(
    stage(before, "source-candidate").status,
    "passed",
    stage(before, "source-candidate").reason,
  );
  assert.equal(before.checks[1].relation, "current");
  await writeFile(join(f.source, "added.js"), "changed candidate bytes");
  const changed = await f.run();
  assert.equal(changed.candidate.commit, before.candidate.commit);
  assert.notEqual(
    changed.candidate.contentSha256,
    before.candidate.contentSha256,
  );
  assert.equal(changed.checks[0].relation, "candidate-content-mismatch");
  assert.equal(changed.checks[1].relation, "current");
  await writeFile(join(f.source, "source.js"), "reviewed source\n");
  assert.equal(
    stage(await f.run(), "source-candidate").reason,
    "CANDIDATE_INVENTORY_MISMATCH",
  );
});
async function assemblyFixture(t, { clientEntry = "client.js" } = {}) {
  const f = await fixture(t);
  const id = "11111111-1111-1111-1111-111111111111";
  const directory = join(f.root, "runtime/source-combinations", id),
    name = "@example/plugin";
  const target = join(directory, "node_modules", name);
  await mkdir(target, { recursive: true });
  const pluginManifest = JSON.stringify({
    name,
    version: "1.0.0",
    main: "host.js",
    exports: { "./client": clientEntry },
  });
  const resources = {
    "package.json": pluginManifest,
    "host.js": "host artifact",
    "client.js": "client artifact",
  };
  const files = {},
    artifacts = [];
  for (const [file, bytes] of Object.entries(resources)) {
    await writeFile(join(target, file), bytes);
    files[`node_modules/${name}/${file}`] = hash(bytes);
    await writeFile(join(f.root, file), bytes);
    artifacts.push({
      id: `artifact-${file.replaceAll(".", "-")}`,
      path: file,
      component: name,
      file: file === "client.js" ? clientEntry : file,
      sha256: hash(bytes),
    });
  }
  await mkdir(join(f.root, "external"));
  await writeFile(join(f.root, "external/core.js"), "core dependency");
  await writeFile(join(f.root, "lock.yaml"), "lock bytes");
  const plugins = {
    [name]: {
      commit: f.candidate.commit,
      dirty: "",
      source: f.source,
      version: "1.0.0",
      digests: Object.fromEntries(
        Object.entries(resources).map(([key, bytes]) => [
          key === "client.js" ? clientEntry : key,
          hash(bytes),
        ]),
      ),
    },
  };
  await writeFile(
    join(directory, "company-plugins.json"),
    JSON.stringify(plugins),
  );
  files["company-plugins.json"] = hash(JSON.stringify(plugins));
  const manifest = {
    composition: { id, dependencies: { [name]: "1.0.0" } },
    core: f.candidate.commit,
    files,
    externalRoots: [join(f.root, "external")],
    externalLockFiles: [join(f.root, "lock.yaml")],
    externalFiles: {
      [join(f.root, "external/core.js")]: hash("core dependency"),
      [join(f.root, "lock.yaml")]: hash("lock bytes"),
    },
    locks: { core: {} },
  };
  const manifestBytes = JSON.stringify(manifest);
  await writeFile(join(directory, "combination.json"), manifestBytes);
  const selection = JSON.stringify({ id, manifestSha256: hash(manifestBytes) });
  await writeFile(join(f.root, "runtime/source-selection.json"), selection);
  await writeFile(join(f.root, "build.mjs"), "build input");
  const current = await f.run();
  const assembly = {
    taskId: "15",
    projectId: "split",
    runtime: "runtime",
    combinationId: id,
    manifestSha256: hash(manifestBytes),
    selectionSha256: hash(selection),
    candidateSha256: current.candidate.sha256,
    candidateContentSha256: current.candidate.contentSha256,
    core: { path: "source", commit: f.candidate.commit },
    component: name,
    buildInputs: [
      { id: "build", path: "build.mjs", sha256: hash("build input") },
    ],
    artifacts,
  };
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(assembly));
  f.request.tasks[0].assembly = { id: "assembly", path: "assembly.json" };
  return { ...f, assembly, directory, target, manifest };
}
test("assembly binds complete candidate, real build and artifact bytes, Core, official manifest and selection", async (t) => {
  const f = await assemblyFixture(t);
  const task = await f.run();
  assert.equal(
    stage(task, "frozen-assembly").status,
    "passed",
    stage(task, "frozen-assembly").reason,
  );
  assert.equal(
    stage(task, "frozen-assembly").proof,
    "official-combination-and-inputs",
  );
  assert.equal(stage(task, "service-structure").status, "not-run");
  await writeFile(join(f.root, "client.js"), "new client");
  f.assembly.artifacts.find((ref) => ref.file === "client.js").sha256 =
    hash("new client");
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(f.assembly));
  const after = await f.run();
  assert.equal(stage(after, "frozen-assembly").status, "blocked");
  assert.equal(stage(after, "frozen-assembly").reason, "ASSEMBLY_PENDING");
  assert.equal(
    stage(after, "frozen-assembly").minimumGap,
    "ASSEMBLE_CURRENT_CANDIDATE_AND_ARTIFACTS",
  );
});
test("official artifact, dependency and lock drift identify exact safe input classes and preserve selection", async (t) => {
  const f = await assemblyFixture(t);
  const selected = await readFile(
    join(f.root, "runtime/source-selection.json"),
  );
  await writeFile(join(f.target, "client.js"), "tampered frozen client");
  let task = await f.run();
  assert.equal(
    stage(task, "frozen-assembly").reason,
    "SOURCE_COMBINATION_DIGEST_MISMATCH",
  );
  assert.ok(
    task.assembly.mismatches.some(
      (ref) => ref.sourceId === "assembly-resource-1",
    ),
  );
  await writeFile(join(f.target, "client.js"), "client artifact");
  await writeFile(join(f.root, "external/core.js"), "changed dependency");
  task = await f.run();
  assert.equal(
    stage(task, "frozen-assembly").reason,
    "SOURCE_DEPENDENCY_DIGEST_MISMATCH",
  );
  assert.ok(
    task.assembly.mismatches.some((ref) => ref.kind === "external-dependency"),
  );
  await writeFile(join(f.root, "external/core.js"), "core dependency");
  await writeFile(join(f.root, "lock.yaml"), "changed lock");
  task = await f.run();
  assert.ok(task.assembly.mismatches.some((ref) => ref.kind === "lock"));
  assert.deepEqual(
    await readFile(join(f.root, "runtime/source-selection.json")),
    selected,
  );
});
test("missing manifest, build drift, selection drift and wrong candidate retain minimum gaps", async (t) => {
  const f = await assemblyFixture(t);
  await writeFile(join(f.root, "build.mjs"), "changed build input");
  assert.equal(
    stage(await f.run(), "frozen-assembly").reason,
    "ASSEMBLY_BUILD_INPUT_MISMATCH",
  );
  await writeFile(join(f.root, "build.mjs"), "build input");
  const selection = await readFile(
    join(f.root, "runtime/source-selection.json"),
  );
  await writeFile(
    join(f.root, "runtime/source-selection.json"),
    JSON.stringify({
      id: "22222222-2222-2222-2222-222222222222",
      manifestSha256: f.assembly.manifestSha256,
    }),
  );
  assert.equal(
    stage(await f.run(), "frozen-assembly").reason,
    "ASSEMBLY_SELECTION_MISMATCH",
  );
  await writeFile(join(f.root, "runtime/source-selection.json"), selection);
  const manifest = await readFile(join(f.directory, "combination.json"));
  await rm(join(f.directory, "combination.json"));
  const missing = await f.run();
  assert.equal(
    stage(missing, "frozen-assembly").reason,
    "ASSEMBLY_INPUT_MISSING",
  );
  assert.equal(missing.assembly.inputId, "assembly-manifest");
  await writeFile(join(f.directory, "combination.json"), manifest);
  f.assembly.candidateSha256 = "a".repeat(64);
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(f.assembly));
  assert.equal(
    stage(await f.run(), "frozen-assembly").reason,
    "ASSEMBLY_PENDING",
  );
});
test("checker refuses ambiguous assembly sources and cannot hide an observed failure with applicability", async (t) => {
  const f = await assemblyFixture(t);
  f.request.tasks[0].inputs = [{ id: "assembly-manifest", path: "build.mjs" }];
  assert.equal(
    stage(await f.run(), "frozen-assembly").reason,
    "ASSEMBLY_SOURCE_CONFLICT",
  );
  f.request.tasks[0].inputs = [];
  f.delivery.notApplicable = [
    {
      stage: "frozen-assembly",
      reasonCode: "outside-task-scope",
      sourceId: "ticket",
    },
  ];
  await writeFile(join(f.root, "delivery.json"), JSON.stringify(f.delivery));
  assert.equal(
    stage(await f.run(), "frozen-assembly").reason,
    "ASSEMBLY_APPLICABILITY_CONFLICT",
  );
});
test("packed checkout can use controlled cryptographically verified commit and tree objects", async (t) => {
  const f = await fixture(t);
  const objects = join(f.root, "objects");
  await mkdir(objects);
  const ids = [
    f.candidate.commit,
    ...f
      .git("ls-tree", "-r", "-t", "HEAD")
      .split("\n")
      .filter((line) => line.includes(" tree "))
      .map((line) => line.split(/\s+/)[2]),
    f.git("rev-parse", "HEAD^{tree}"),
  ];
  for (const id of new Set(ids)) {
    const type = f.git("cat-file", "-t", id);
    const payload = execFileSync("/usr/bin/git", ["cat-file", type, id], {
      cwd: f.source,
    });
    await mkdir(join(objects, id.slice(0, 2)), { recursive: true });
    await writeFile(
      join(objects, id.slice(0, 2), id.slice(2)),
      deflateSync(
        Buffer.concat([Buffer.from(`${type} ${payload.length}\0`), payload]),
      ),
    );
  }
  f.git("gc", "--prune=now");
  assert.equal(
    stage(await f.run(), "source-candidate").reason,
    "GIT_PACKED_OBJECT_UNSUPPORTED",
  );
  f.candidate.checkout.objectRoot = "objects";
  await writeFile(join(f.root, "candidate.json"), JSON.stringify(f.candidate));
  assert.equal(stage(await f.run(), "source-candidate").status, "passed");
  const headObject = join(
    objects,
    f.candidate.commit.slice(0, 2),
    f.candidate.commit.slice(2),
  );
  await writeFile(headObject, deflateSync(Buffer.from("commit 3\0bad")));
  assert.equal(
    stage(await f.run(), "source-candidate").reason,
    "GIT_OBJECT_MISMATCH",
  );
});
test("necessary frozen modules also need independently verified source candidates", async (t) => {
  const f = await assemblyFixture(t);
  const name = "@example/addon",
    target = join(f.directory, "node_modules", name);
  await mkdir(target, { recursive: true });
  const bytes = JSON.stringify({
    name,
    version: "1.0.0",
    main: "host.js",
    exports: { "./client": "client.js" },
  });
  await writeFile(join(target, "host.js"), "addon host");
  await writeFile(join(target, "client.js"), "addon client");
  await writeFile(join(target, "package.json"), bytes);
  const plugins = JSON.parse(
    await readFile(join(f.directory, "company-plugins.json"), "utf8"),
  );
  plugins[name] = {
    source: f.source,
    commit: f.candidate.commit,
    dirty: "",
    version: "1.0.0",
    digests: {
      "package.json": hash(bytes),
      "host.js": hash("addon host"),
      "client.js": hash("addon client"),
    },
  };
  await writeFile(
    join(f.directory, "company-plugins.json"),
    JSON.stringify(plugins),
  );
  f.manifest.composition.dependencies[name] = "1.0.0";
  f.manifest.files[`node_modules/${name}/package.json`] = hash(bytes);
  f.manifest.files[`node_modules/${name}/host.js`] = hash("addon host");
  f.manifest.files[`node_modules/${name}/client.js`] = hash("addon client");
  f.manifest.files["company-plugins.json"] = hash(JSON.stringify(plugins));
  const manifest = JSON.stringify(f.manifest);
  await writeFile(join(f.directory, "combination.json"), manifest);
  const selected = JSON.stringify({
    id: f.assembly.combinationId,
    manifestSha256: hash(manifest),
  });
  await writeFile(join(f.root, "runtime/source-selection.json"), selected);
  f.assembly.manifestSha256 = hash(manifest);
  f.assembly.selectionSha256 = hash(selected);
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(f.assembly));
  assert.equal(
    stage(await f.run(), "frozen-assembly").reason,
    "ASSEMBLY_MODULE_CANDIDATES_REQUIRED",
  );
  f.assembly.modules = [
    {
      name,
      candidate: { ...f.candidate },
      contentSha256: (await f.run()).candidate.contentSha256,
    },
  ];
  f.assembly.artifacts.push({
    id: "addon-package",
    component: name,
    file: "package.json",
    path: `runtime/source-combinations/${f.assembly.combinationId}/node_modules/${name}/package.json`,
    sha256: hash(bytes),
  });
  for (const [file, bytes] of [
    ["host.js", "addon host"],
    ["client.js", "addon client"],
  ])
    f.assembly.artifacts.push({
      id: "addon-" + file.replace(".", "-"),
      component: name,
      file,
      path: `runtime/source-combinations/${f.assembly.combinationId}/node_modules/${name}/${file}`,
      sha256: hash(bytes),
    });
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(f.assembly));
  assert.equal(stage(await f.run(), "frozen-assembly").status, "passed");
});
async function tree(path) {
  const out = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    out[entry.name] = entry.isDirectory()
      ? await tree(file)
      : hash(await readFile(file));
  }
  return out;
}
test("complete assembly CLI runs without process/write permission and preserves populated Session and lock bytes", async (t) => {
  const f = await assemblyFixture(t);
  await mkdir(join(f.root, "sessions"));
  await writeFile(
    join(f.root, "sessions/native.json"),
    '{"messages":["preserved fixture"]}',
  );
  await writeFile(
    join(f.root, "runtime/source-profile.lock"),
    "existing owner",
  );
  f.request.tasks[0].session = { id: "session", path: "sessions" };
  await writeFile(join(f.root, "request.json"), JSON.stringify(f.request));
  const before = await tree(f.root);
  const first = await f.run();
  assert.deepEqual(await f.run(), first);
  const cli = spawnSync(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${f.root}`,
      `--allow-fs-read=${import.meta.dirname}`,
      join(import.meta.dirname, "delivery-check.mjs"),
      "--input",
      join(f.root, "request.json"),
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(
    stage(JSON.parse(cli.stdout).tasks[0], "frozen-assembly").status,
    "passed",
  );
  assert.equal(stage(first, "session-recovery").status, "not-run");
  assert.deepEqual(await tree(f.root), before);
});
test("unsupported or sensitive source scopes stay unknown and old content bindings do not prove new index state", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, ".env"), "DO_NOT_READ_SECRET");
  assert.equal(
    stage(await f.run(), "source-candidate").reason,
    "INTEGRITY_SOURCE_SCOPE_UNSUPPORTED",
  );
  await rm(join(f.source, ".env"));
  await writeFile(join(f.source, ".gitignore"), "*.generated\n");
  assert.equal(
    stage(await f.run(), "source-candidate").reason,
    "GIT_IGNORE_SYNTAX_UNSUPPORTED",
  );
  await rm(join(f.source, ".gitignore"));
  f.delivery.checks[0].candidateContentSha256 = "b".repeat(64);
  await writeFile(join(f.root, "delivery.json"), JSON.stringify(f.delivery));
  assert.equal(
    (await f.run()).checks[0].relation,
    "candidate-content-mismatch",
  );
});
test("a internally consistent frozen manifest cannot omit the required client artifact identity", async (t) => {
  const f = await assemblyFixture(t);
  const file = join(f.directory, "company-plugins.json");
  const plugins = JSON.parse(await readFile(file, "utf8"));
  delete plugins[f.assembly.component].digests["client.js"];
  const pluginBytes = JSON.stringify(plugins);
  await writeFile(file, pluginBytes);
  f.manifest.files["company-plugins.json"] = hash(pluginBytes);
  const manifestBytes = JSON.stringify(f.manifest);
  await writeFile(join(f.directory, "combination.json"), manifestBytes);
  const selection = JSON.stringify({
    id: f.assembly.combinationId,
    manifestSha256: hash(manifestBytes),
  });
  await writeFile(join(f.root, "runtime/source-selection.json"), selection);
  f.assembly.manifestSha256 = hash(manifestBytes);
  f.assembly.selectionSha256 = hash(selection);
  f.assembly.artifacts = f.assembly.artifacts.filter(
    (ref) => ref.file !== "client.js",
  );
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(f.assembly));
  assert.equal(
    stage(await f.run(), "frozen-assembly").reason,
    "ASSEMBLY_COMPONENT_ARTIFACTS_REQUIRED",
  );
});

test("official artifact entry identities preserve relative export paths", async (t) => {
  const f = await assemblyFixture(t, { clientEntry: "./client.js" });
  assert.equal(
    stage(await f.run(), "frozen-assembly").status,
    "passed",
    stage(await f.run(), "frozen-assembly").reason,
  );
});
test("physical sensitive aliases are refused before generic or assembly input bytes are read", async (t) => {
  const f = await assemblyFixture(t);
  await writeFile(join(f.root, ".env"), "SYNTHETIC_PRIVATE_BYTES");
  await symlink(join(f.root, ".env"), join(f.root, "ordinary-build"));
  f.assembly.buildInputs = [
    {
      id: "build",
      path: "ordinary-build",
      sha256: hash("SYNTHETIC_PRIVATE_BYTES"),
    },
  ];
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(f.assembly));
  let report = await f.run();
  assert.equal(
    stage(report, "frozen-assembly").reason,
    "INTEGRITY_SOURCE_SCOPE_UNSUPPORTED",
  );
  assert.ok(
    !report.inputs.some(
      (input) => input.sha256 === hash("SYNTHETIC_PRIVATE_BYTES"),
    ),
  );
  f.request.tasks[0].inputs = [{ id: "ordinary", path: "ordinary-build" }];
  report = await f.run();
  assert.equal(
    report.inputs.find((input) => input.id === "ordinary").error,
    "INPUT_SENSITIVE_TARGET",
  );
});
test("declared persistent roots exclude direct, ancestor and physical alias inputs without reading Session contents", async (t) => {
  const f = await assemblyFixture(t);
  await mkdir(join(f.root, "persistent-state"));
  await writeFile(
    join(f.root, "persistent-state/native.json"),
    "PRIVATE_SESSION_A",
  );
  await symlink(
    join(f.root, "persistent-state"),
    join(f.root, "ordinary-dependency"),
  );
  f.request.tasks[0].session = { id: "session", path: "persistent-state" };
  f.manifest.externalRoots = [join(f.root, "ordinary-dependency")];
  f.manifest.externalLockFiles = [];
  f.manifest.externalFiles = {
    [join(f.root, "persistent-state/native.json")]: hash("PRIVATE_SESSION_A"),
  };
  const manifestBytes = JSON.stringify(f.manifest);
  await writeFile(join(f.directory, "combination.json"), manifestBytes);
  const selection = JSON.stringify({
    id: f.assembly.combinationId,
    manifestSha256: hash(manifestBytes),
  });
  await writeFile(join(f.root, "runtime/source-selection.json"), selection);
  f.assembly.manifestSha256 = hash(manifestBytes);
  f.assembly.selectionSha256 = hash(selection);
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(f.assembly));
  const first = await f.run();
  assert.equal(
    stage(first, "frozen-assembly").reason,
    "INTEGRITY_PERSISTENT_OVERLAP",
  );
  await writeFile(
    join(f.root, "persistent-state/native.json"),
    "PRIVATE_SESSION_B",
  );
  assert.deepEqual(await f.run(), first);
  f.request.tasks[0].inputs = [
    { id: "private-file", path: "ordinary-dependency/native.json" },
  ];
  assert.equal(
    (await f.run()).inputs.find((input) => input.id === "private-file").error,
    "INPUT_PERSISTENT_OVERLAP",
  );
  f.request.tasks[0].inputs = [];
  f.request.tasks[0].session = { id: "session", path: "source" };
  assert.equal(
    stage(await f.run(), "source-candidate").reason,
    "INTEGRITY_PERSISTENT_OVERLAP",
  );
  f.request.tasks[0].session = { id: "session", path: "persistent-state" };
  f.candidate.checkout.objectRoot = "ordinary-dependency";
  await writeFile(join(f.root, "candidate.json"), JSON.stringify(f.candidate));
  assert.equal(
    stage(await f.run(), "source-candidate").reason,
    "INTEGRITY_PERSISTENT_OVERLAP",
  );
});
test("artifact byte corruption fails its declared input while a declared new client waits for assembly", async (t) => {
  const f = await assemblyFixture(t);
  await writeFile(join(f.root, "client.js"), "unrecorded artifact bytes");
  let report = await f.run();
  assert.equal(stage(report, "frozen-assembly").status, "failed");
  assert.equal(
    stage(report, "frozen-assembly").reason,
    "ASSEMBLY_ARTIFACT_DIGEST_MISMATCH",
  );
  assert.equal(report.assembly.inputId, "artifact-client-js");
  assert.equal(
    report.assembly.mismatches[0].actualSha256,
    hash("unrecorded artifact bytes"),
  );
  assert.equal(
    report.assembly.mismatches[0].expectedSha256,
    hash("client artifact"),
  );
  f.assembly.artifacts.find((ref) => ref.file === "client.js").sha256 = hash(
    "unrecorded artifact bytes",
  );
  await writeFile(join(f.root, "assembly.json"), JSON.stringify(f.assembly));
  report = await f.run();
  assert.equal(stage(report, "frozen-assembly").status, "blocked");
  assert.equal(stage(report, "frozen-assembly").reason, "ASSEMBLY_PENDING");
});
test("all101 source changes affect candidate identity while the report emits at most100 differences", async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 101; n++)
    await writeFile(
      join(f.source, `new${String(n).padStart(3, "0")}.js`),
      "new bytes",
    );
  const before = await f.run();
  assert.equal(before.candidate.integrity.changedFiles, 101);
  assert.equal(before.candidate.integrity.files.length, 100);
  await writeFile(join(f.source, "new100.js"), "changed last item");
  assert.notEqual(
    (await f.run()).candidate.contentSha256,
    before.candidate.contentSha256,
  );
});
test("an explicitly declared absent persistent descendant prevents ancestor source traversal without creating it", async (t) => {
  const f = await fixture(t);
  f.request.tasks[0].persistentRoots = [
    { id: "application-state", path: "source/runtime-state" },
  ];
  assert.equal(
    stage(await f.run(), "source-candidate").reason,
    "INTEGRITY_PERSISTENT_OVERLAP",
  );
  await assert.rejects(readFile(join(f.source, "runtime-state/native.json")), {
    code: "ENOENT",
  });
});

test("hardlink uncertainty is preserved for full source, Git, artifacts and canonical dependency reads", async (t) => {
  const f = await assemblyFixture(t);
  await mkdir(join(f.root, "sessions"));
  f.request.tasks[0].session = { id: "session", path: "sessions" };
  const object = join(
    f.source,
    ".git/objects",
    f.candidate.commit.slice(0, 2),
    f.candidate.commit.slice(2),
  );
  for (const [file, stageName] of [
    [join(f.source, "source.js"), "source-candidate"],
    [join(f.source, ".git/HEAD"), "source-candidate"],
    [object, "source-candidate"],
    [join(f.root, "client.js"), "frozen-assembly"],
    [join(f.root, "build.mjs"), "frozen-assembly"],
    [join(f.target, "client.js"), "frozen-assembly"],
    [join(f.root, "external/core.js"), "frozen-assembly"],
    [join(f.root, "lock.yaml"), "frozen-assembly"],
  ]) {
    const bytes = await readFile(file),
      alias = join(f.root, "sessions/alias");
    await link(file, alias);
    const r = await f.run();
    assert.equal(stage(r, stageName).status, "unknown", file);
    assert.equal(
      stage(r, stageName).reason,
      "INTEGRITY_MULTILINK_UNVERIFIABLE",
      file,
    );
    assert.deepEqual(await readFile(alias), bytes);
    await rm(alias);
    assert.equal(stage(await f.run(), "frozen-assembly").status, "passed");
  }
});

test("exported Git objects with a Session hardlink alias cannot prove a complete candidate", async (t) => {
  const f = await fixture(t),
    objects = join(f.root, "objects");
  const ids = [f.candidate.commit, f.git("rev-parse", "HEAD^{tree}")];
  for (const id of ids) {
    const type = f.git("cat-file", "-t", id);
    const payload = execFileSync("/usr/bin/git", ["cat-file", type, id], {
      cwd: f.source,
    });
    await mkdir(join(objects, id.slice(0, 2)), { recursive: true });
    await writeFile(
      join(objects, id.slice(0, 2), id.slice(2)),
      deflateSync(
        Buffer.concat([Buffer.from(`${type} ${payload.length}\0`), payload]),
      ),
    );
  }
  f.git("gc", "--prune=now");
  f.candidate.checkout.objectRoot = "objects";
  await writeFile(join(f.root, "candidate.json"), JSON.stringify(f.candidate));
  assert.equal(stage(await f.run(), "source-candidate").status, "passed");
  await mkdir(join(f.root, "sessions"));
  f.request.tasks[0].session = { id: "session", path: "sessions" };
  await link(
    join(objects, f.candidate.commit.slice(0, 2), f.candidate.commit.slice(2)),
    join(f.root, "sessions/alias"),
  );
  const r = await f.run();
  assert.equal(stage(r, "source-candidate").status, "unknown");
  assert.equal(
    stage(r, "source-candidate").reason,
    "INTEGRITY_MULTILINK_UNVERIFIABLE",
  );
  assert.equal(r.candidate.contentSha256, null);
});
