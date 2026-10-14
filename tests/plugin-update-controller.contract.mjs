import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk)
  throw Error("GEA_PLUGIN_UPDATE_SDK must explicitly name unchanged fixed SDK");
// The explicit generated SDK must implement the unchanged candidate public operations.
const candidateSdk =
  process.env.GEA_PLUGIN_UPDATE_CANDIDATE_CORE ??
  fileURLToPath(new URL("../../../official-latest-standard/", import.meta.url));
for (const [path, expected] of Object.entries({
  "packages/boot/plugin-manager/src/operations.ts":
    "16d141f794041d06122ce9f8ab7bae6f55b4a78feefb620f9cb6c7ba5efac547",
  "packages/util/atomic-write/src/index.ts":
    "9934692f741efdb2570ee8e108b84f2fad11c55b438d531409f1c2e16d35106a",
  "packages/boot/plugin-manager/src/run-tree.ts":
    "d3da95db5f30882ed1a7dfb499de7b35cb9fd71eb137fc2384ebc2a5d18c38cd",
  "packages/boot/app-boot/src/profile.ts":
    "30a883b090c4489b14371d947113d532ab9484d4e0f79c7a4fcddd066e24b6ab",
})) {
  for (const root of [sdk, candidateSdk])
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex"),
      expected,
      `Public SDK source changed: ${root}/${path}`,
    );
}
await mkdir(new URL("../.runtime/", import.meta.url), { recursive: true });
const work = await mkdtemp(
  fileURLToPath(
    new URL("../.runtime/plugin-update-controller-module-", import.meta.url),
  ),
);
const modulePath = join(work, "controller.mjs");
const subjectPath = join(work, "subjects.ts");
await writeFile(
  subjectPath,
  `export * from ${JSON.stringify(fileURLToPath(new URL("../src/host/plugin-update-controller.ts", import.meta.url)))};export {projectPluginUpdates} from ${JSON.stringify(fileURLToPath(new URL("../src/plugin-updates-client.ts", import.meta.url)))};export {parseUpdateClientStatus} from ${JSON.stringify(fileURLToPath(new URL("../src/shared/plugin-update-wire.ts", import.meta.url)))};export {readPluginProfile, combinationManifests, validateActualProfile} from ${JSON.stringify(fileURLToPath(new URL("../src/host/plugin-update-profile.ts", import.meta.url)))};`,
);

await build({
  entryPoints: [subjectPath],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  outfile: modulePath,
  logLevel: "silent",
  plugins: [
    {
      name: "explicit-fixed-sdk",
      setup(b) {
        const aliases = {
          "@deepseek-ai/dsh-plugin-manager/operations":
            "packages/boot/plugin-manager/lib/types/operations.js",
          "@deepseek-ai/dsh-atomic-write":
            "packages/util/atomic-write/lib/index.js",
          "@deepseek-ai/dsh-app-boot": "packages/boot/app-boot/lib/index.js",
        };
        b.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
          aliases[args.path]
            ? { path: join(sdk, aliases[args.path]), external: true }
            : undefined,
        );
      },
    },
  ],
});
const {
  createPluginUpdateController,
  readPluginProfile,
  validateActualProfile,
  projectPluginUpdates,
  parseUpdateClientStatus,
} = await import(pathToFileURL(modulePath));
test("controller starts with an empty operation and preserves existing profile data", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "plugin-update-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = {
    name: "fixture",
    dir: join(dir, "profile"),
    installAnchor: join(dir, "anchor/package.json"),
    cwd: dir,
    home: dir,
    packageManager: { command: process.execPath, args: [], env: {} },
  };
  await mkdir(profile.dir);
  await writeFile(
    join(profile.dir, "package.json"),
    JSON.stringify({
      dependencies: {},
      dsh: { profile: { bundles: [] } },
      retained: { draft: "keep" },
    }),
  );
  await writeFile(join(profile.dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  await mkdir(join(profile.dir, "node_modules"));
  const before = await readFile(join(profile.dir, "package.json"), "utf8");
  const controller = createPluginUpdateController({
    profile,
    core: { head: "a".repeat(40), version: "0.2.0-rc.2", sdk: {} },
    runtimeDirectory: join(dir, "updates"),
    source: {
      check: async () => [],
      download: async () => {
        throw Error("not requested");
      },
    },
    readRuntimeProofs: async () => [],
  });
  await controller.initialize();
  assert.equal(controller.snapshot().operation, null);
  await controller.dispose();
  assert.equal(
    await readFile(join(profile.dir, "package.json"), "utf8"),
    before,
  );
});
test("durable accepted operation installs one existing package under official lock and waits for restart", async (t) => {
  const { controllerFixture, waitForStage } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.packageName === "@cleverc2200/gea-dsh-prototype");
  assert.equal(row.state, "available", JSON.stringify(controller.snapshot()));
  const accepted = await controller.submit({
    packageName: row.packageName,
    planId: row.planId,
  });
  assert.equal(accepted.stage, "accepted");
  assert.equal(
    JSON.parse(
      await readFile(join(f.options.runtimeDirectory, "latest.json"), "utf8"),
    ).id,
    accepted.id,
  );
  const operation = await waitForStage(controller, [
    "pending-restart",
    "unknown",
    "restored",
  ]);
  assert.equal(operation.stage, "pending-restart", JSON.stringify(operation));
  const changed = JSON.parse(
    await readFile(
      join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/package.json"),
      "utf8",
    ),
  );
  assert.equal(changed.version, "3.1.0");
  assert.equal(
    controller
      .snapshot()
      .items.find((row) => row.packageName === accepted.packageName)
      .runningHostVersion,
    "3.0.0",
  );
  assert.equal(
    controller
      .snapshot()
      .items.find((row) => row.packageName === accepted.packageName)
      .installedVersion,
    "3.1.0",
  );
  const invocation = JSON.parse(
    (await readFile(join(f.dir, "invocations.ndjson"), "utf8")).trim(),
  );
  assert.equal(invocation.args[0], "--fixture-prefix");
  assert.equal(invocation.marker, "launcher-provided");
  assert.equal(invocation.cwd, await realpath(f.dir));
  await assert.rejects(
    controller.submit({ packageName: row.packageName, planId: row.planId }),
    /UPDATE_OPERATION_BLOCKED/,
  );
});
test.after(() => rm(work, { recursive: true, force: true }));
test("an observed failed package process restores the complete previous graph and preserves profile fields", async (t) => {
  const { controllerFixture, waitForStage } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t, { mode: "fail-after-write" }),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  const before = await readFile(join(f.dir, "package.json"), "utf8"),
    oldCode = await readFile(
      join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/lib/host.js"),
      "utf8",
    );
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const outcome = await waitForStage(controller, ["restored", "unknown"]);
  assert.equal(outcome.stage, "restored", JSON.stringify(outcome));
  assert.equal(await readFile(join(f.dir, "package.json"), "utf8"), before);
  assert.equal(
    await readFile(
      join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/lib/host.js"),
      "utf8",
    ),
    oldCode,
  );
  assert.equal(
    await readFile(join(f.dir, "pnpm-lock.yaml"), "utf8"),
    "lockfileVersion: 9\nold: true\n",
  );
});
test("unmanaged profile field changes produce unknown without overwriting possible user settings", async (t) => {
  const { controllerFixture, waitForStage } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t, { mode: "bad-fields" }),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const outcome = await waitForStage(controller, ["restored", "unknown"]);
  assert.equal(outcome.stage, "unknown", JSON.stringify(outcome));
  assert.equal(outcome.diagnostic, "PROFILE_SETTINGS_OWNERSHIP_UNCONFIRMED");
  assert.equal(
    JSON.parse(await readFile(join(f.dir, "package.json"), "utf8")).retained
      .draft,
    "broken",
  );
});
test("the official profile lock rechecks a changed baseline before any package-manager invocation", async (t) => {
  const { controllerFixture } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  const { withFileLock } = await import(
    pathToFileURL(join(sdk, "packages/util/atomic-write/lib/index.js"))
  );
  let unlock, started;
  const acquired = new Promise((resolve) => (started = resolve)),
    held = new Promise((resolve) => (unlock = resolve));
  const writer = withFileLock(join(f.dir, "package.json"), async () => {
    started();
    await held;
    await writeFile(
      join(f.dir, "pnpm-lock.yaml"),
      "another writer updated lock\n",
    );
  });
  await acquired;
  const submitting = controller.submit({
    packageName: row.packageName,
    planId: row.planId,
  });
  const rejected = assert.rejects(submitting, /UPDATE_BASELINE_CHANGED/);
  unlock();
  await writer;
  await rejected;
  await assert.rejects(readFile(join(f.dir, "invocations.ndjson")), /ENOENT/);
  assert.equal(controller.snapshot().operation, null);
});
test("timed-out exit zero cannot become installed success", async (t) => {
  const { controllerFixture, waitForStage } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t, { mode: "idle-exit-zero" }),
    controller = createPluginUpdateController({
      ...f.options,
      idleTimeoutMs: 300,
    });
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const result = await waitForStage(controller, [
    "restored",
    "unknown",
    "pending-restart",
  ]);
  assert.equal(result.stage, "restored", JSON.stringify(result));
});
test(
  "an orphan writer produces unknown without rollback, and Host unload kills and awaits its recorded group",
  { skip: process.platform === "win32" },
  async (t) => {
    const { controllerFixture, waitForStage } = await import(
      "./fixtures/plugin-updates/profile.mjs"
    );
    const f = await controllerFixture(t, { mode: "orphan" }),
      controller = createPluginUpdateController(f.options);
    await controller.initialize();
    await controller.check();
    const row = controller
      .snapshot()
      .items.find((row) => row.state === "available");
    await controller.submit({
      packageName: row.packageName,
      planId: row.planId,
    });
    const result = await waitForStage(controller, [
      "unknown",
      "pending-restart",
    ]);
    assert.equal(result.stage, "unknown", JSON.stringify(result));
    assert.equal(result.diagnostic, "PACKAGE_WRITERS_UNCONFIRMED");
    assert.equal(
      JSON.parse(
        await readFile(
          join(
            f.dir,
            "node_modules/@cleverc2200/gea-dsh-prototype/package.json",
          ),
          "utf8",
        ),
      ).version,
      "3.1.0",
    );
    await controller.dispose();
    const marker = await readFile(join(f.dir, "late-write"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await readFile(join(f.dir, "late-write"), "utf8"), marker);
    const reopened = createPluginUpdateController(f.options);
    await reopened.initialize();
    assert.equal(reopened.snapshot().operation.stage, "unknown");
    await assert.rejects(
      reopened.submit({ packageName: row.packageName, planId: row.planId }),
      /UPDATE_OPERATION_BLOCKED/,
    );
    await reopened.dispose();
    assert.equal(
      (await readFile(join(f.dir, "invocations.ndjson"), "utf8"))
        .trim()
        .split("\n").length,
      1,
    );
  },
);
test("Host unload cancels an accepted operation, waits for its process and restores only after quiescence", async (t) => {
  const { controllerFixture } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t, { mode: "slow" }),
    controller = createPluginUpdateController(f.options);
  const before = await readFile(join(f.dir, "package.json"), "utf8");
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await readFile(join(f.dir, "invocations.ndjson"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const disposed = await controller.dispose();
  assert.equal(disposed.kind, "stopped", JSON.stringify(controller.snapshot()));
  assert.equal(controller.snapshot().operation.stage, "restored");
  assert.equal(await readFile(join(f.dir, "package.json"), "utf8"), before);
});
test("pending receipt survives recreation in the same Node process and needs a genuinely new process plus client observation", async (t) => {
  const { controllerFixture, waitForStage } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  await waitForStage(controller, ["pending-restart"]);
  await controller.dispose();
  const targetProofs = structuredClone(f.proofs);
  const target = targetProofs.find((proof) => proof.name === row.packageName);
  target.host.stamp.version = "3.1.0";
  target.client.stamp.version = "3.1.0";
  const sameProcess = createPluginUpdateController({
    ...f.options,
    readRuntimeProofs: async () => targetProofs,
  });
  await sameProcess.initialize();
  await sameProcess.reconcileRuntime();
  assert.equal(sameProcess.snapshot().operation.stage, "pending-restart");
  await sameProcess.dispose();
  const script = join(f.root, "reconcile.mjs");
  await writeFile(
    script,
    `import {createPluginUpdateController} from ${JSON.stringify(pathToFileURL(modulePath).href)};import{readFile}from'node:fs/promises';const options=JSON.parse(await readFile(process.argv[2],'utf8'));const proofs=options.proofs;delete options.proofs;options.source={check:async()=>[],download:async()=>{throw Error('unused');},assertCurrentRelease:()=>{}};options.readRuntimeProofs=async processIdentity=>proofs.map(proof=>({...proof,client:proof.client.kind==='observed'?{...proof.client,binding:{...proof.client.binding,hostProcessIdentity:processIdentity}}:proof.client}));const controller=createPluginUpdateController(options);await controller.initialize();console.log(JSON.stringify({...controller.snapshot(),actualProcessIdentity:process.pid+':'+performance.timeOrigin}));await controller.dispose();`,
  );
  const input = join(f.root, "restart-options.json");
  await writeFile(
    input,
    JSON.stringify({
      ...f.options,
      source: undefined,
      readRuntimeProofs: undefined,
      proofs: targetProofs,
    }),
  );
  const { execFileSync } = await import("node:child_process");
  const oldBrowserProofs = structuredClone(targetProofs);
  oldBrowserProofs.find(
    (proof) => proof.name === row.packageName,
  ).client.stamp.version = "3.0.0";
  const oldBrowserInput = join(f.root, "old-browser-options.json");
  await writeFile(
    oldBrowserInput,
    JSON.stringify({
      ...f.options,
      source: undefined,
      readRuntimeProofs: undefined,
      proofs: oldBrowserProofs,
    }),
  );
  const oldBrowser = JSON.parse(
    execFileSync(process.execPath, [script, oldBrowserInput], {
      encoding: "utf8",
    }),
  );
  assert.equal(
    oldBrowser.operation.stage,
    "pending-restart",
    JSON.stringify(oldBrowser),
  );
  const fresh = JSON.parse(
    execFileSync(process.execPath, [script, input], { encoding: "utf8" }),
  );
  assert.equal(fresh.operation.stage, "completed", JSON.stringify(fresh));
  assert.notEqual(
    fresh.actualProcessIdentity,
    `${process.pid}:${performance.timeOrigin}`,
  );
});
test("concurrent user patch and default selection survive a confirmed-safe full graph restoration", async (t) => {
  const { controllerFixture, waitForStage } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t, { mode: "fail-after-write" }),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const { withFileLock } = await import(
    pathToFileURL(join(sdk, "packages/util/atomic-write/lib/index.js"))
  );
  const newPatch = "user selected a new default during installation\n";
  await withFileLock(join(f.dir, "cordis.patch.yml"), () =>
    writeFile(join(f.dir, "cordis.patch.yml"), newPatch),
  );
  const outcome = await waitForStage(controller, ["restored", "unknown"]);
  assert.equal(outcome.stage, "restored", JSON.stringify(outcome));
  assert.equal(
    await readFile(join(f.dir, "cordis.patch.yml"), "utf8"),
    newPatch,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/package.json"),
        "utf8",
      ),
    ).version,
    "3.0.0",
  );
});
test("corrupt recovery graph stays unknown rather than claiming old graph restoration", async (t) => {
  const { controllerFixture, waitForStage } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t, { mode: "fail-after-write" });
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  const accepted = await controller.submit({
    packageName: row.packageName,
    planId: row.planId,
  });
  await writeFile(
    join(
      accepted.recoveryDirectory,
      "node_modules",
      row.packageName,
      "lib/host.js",
    ),
    "corrupt recovery material\n",
  );
  const result = await waitForStage(controller, ["restored", "unknown"]);
  assert.equal(result.stage, "unknown", JSON.stringify(result));
  await assert.rejects(
    controller.submit({ packageName: row.packageName, planId: row.planId }),
    /UPDATE_OPERATION_BLOCKED/,
  );
});
test("receipt replacement failure after mutation remains unknown and unreadable durable evidence blocks reopening", async (t) => {
  const { controllerFixture, waitForStage } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  const accepted = await controller.submit({
    packageName: row.packageName,
    planId: row.planId,
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await readFile(join(f.dir, "invocations.ndjson"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const receipt = join(accepted.recoveryDirectory, "..", "receipt.json");
  const durableBefore = await readFile(receipt);
  await writeFile(
    join(accepted.recoveryDirectory, "..", "last-durable-receipt.json"),
    durableBefore,
  );
  await rm(receipt);
  await mkdir(receipt);
  const result = await waitForStage(controller, ["unknown", "pending-restart"]);
  assert.equal(result.stage, "unknown", JSON.stringify(result));
  assert.equal(result.diagnostic, "UPDATE_RECEIPT_WRITE_FAILED");
  await controller.dispose();
  const reopened = createPluginUpdateController(f.options);
  await reopened.initialize();
  assert.ok(
    reopened.snapshot().items.every((item) => item.state === "unknown"),
  );
  await assert.rejects(
    reopened.submit({ packageName: row.packageName, planId: row.planId }),
    /UPDATE_OPERATION_BLOCKED/,
  );
  await reopened.dispose();
});

test("actual pinned pnpm reachable transitive peer blocks an incompatible independent update", async (t) => {
  const { controllerFixture } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const { installPnpmConsumerLayout } = await import(
    "./fixtures/plugin-updates/pnpm-profile.mjs"
  );
  const f = await controllerFixture(t);
  await installPnpmConsumerLayout(f, "3.0.0");
  const graph = await readPluginProfile(f.dir);
  const consumer = graph.packages.find(
    (row) => row.name === "fixture-consumer-b",
  );
  assert.ok(consumer, "transitive consumer must be reachable");
  assert.equal(consumer.root, false);
  assert.match(consumer.dir, /\.pnpm/);
  await assert.rejects(
    readFile(
      join(consumer.dir, "node_modules/fixture-consumer-b/package.json"),
    ),
    { code: "ENOENT" },
  );
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((row) => row.packageName === "@cleverc2200/gea-dsh-prototype");
  assert.equal(row.state, "blocked");
  assert.equal(row.diagnostic, "COMBINATION_INCOMPATIBLE");
  assert.equal(row.planId, null);
  const projected = projectPluginUpdates([row])[row.packageName];
  assert.equal(projected.problem.kind, "dependencies");
  assert.deepEqual(projected.problem.requirements, [
    {
      consumer: "fixture-consumer-b",
      dependency: row.packageName,
      required: "3.0.0",
      installed: "3.1.0",
    },
  ]);
  const selected = graph.packages.find(
    (row) => row.root && row.name === "@cleverc2200/gea-dsh-prototype",
  );
  const manifest = JSON.parse(
    await readFile(join(selected.dir, "package.json"), "utf8"),
  );
  await writeFile(
    join(selected.dir, "package.json"),
    JSON.stringify({ ...manifest, version: "3.1.0" }),
  );
  assert.ok(
    (
      await validateActualProfile(
        await readPluginProfile(f.dir),
        f.options.core,
        f.dir,
        f.profile.installAnchor,
      )
    ).some(
      (failure) =>
        failure === "fixture-consumer-b:@cleverc2200/gea-dsh-prototype",
    ),
  );
});
test("compatible real pnpm peer permits update while unreachable obsolete contexts do not constrain the graph", async (t) => {
  const { controllerFixture } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const { installPnpmConsumerLayout } = await import(
    "./fixtures/plugin-updates/pnpm-profile.mjs"
  );
  const f = await controllerFixture(t);
  await installPnpmConsumerLayout(f, "^3.0.0");
  const stale = join(
    f.dir,
    "node_modules/.pnpm/obsolete-context/node_modules/obsolete-consumer",
  );
  await mkdir(stale, { recursive: true });
  await writeFile(
    join(stale, "package.json"),
    JSON.stringify({
      name: "obsolete-consumer",
      version: "1.0.0",
      peerDependencies: { "@cleverc2200/gea-dsh-prototype": "1.0.0" },
    }),
  );
  const graph = await readPluginProfile(f.dir);
  assert.ok(graph.packages.some((row) => row.name === "fixture-consumer-b"));
  assert.ok(!graph.packages.some((row) => row.name === "obsolete-consumer"));
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  assert.equal(
    controller
      .snapshot()
      .items.find((row) => row.packageName === "@cleverc2200/gea-dsh-prototype")
      .state,
    "available",
  );
  assert.deepEqual(
    await validateActualProfile(
      graph,
      f.options.core,
      f.dir,
      f.profile.installAnchor,
    ),
    [],
  );
});

test("Core SDK peers resolve from the explicit installation while a normal pnpm profile carries no SDK copy", async (t) => {
  const { controllerFixture } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const { installPnpmConsumerLayout } = await import(
    "./fixtures/plugin-updates/pnpm-profile.mjs"
  );
  const { symlink } = await import("node:fs/promises");
  const f = await controllerFixture(t);
  const sdkName = "@deepseek-ai/dsh-brand";
  const sdkLinks = join(f.root, "anchor/node_modules/@deepseek-ai");
  await mkdir(sdkLinks, { recursive: true });
  await symlink(join(sdk, "packages/util/brand"), join(sdkLinks, "dsh-brand"));
  const sdkVersion = JSON.parse(
    await readFile(join(sdk, "packages/util/brand/package.json"), "utf8"),
  ).version;
  f.options.core.sdk = { [sdkName]: sdkVersion };
  await installPnpmConsumerLayout(f, "^3.0.0", { [sdkName]: sdkVersion });
  await assert.rejects(
    readFile(join(f.dir, "node_modules", sdkName, "package.json")),
    { code: "ENOENT" },
  );
  const graph = await readPluginProfile(f.dir);
  assert.deepEqual(
    await validateActualProfile(
      graph,
      f.options.core,
      f.dir,
      f.profile.installAnchor,
    ),
    [],
  );
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  assert.equal(
    controller
      .snapshot()
      .items.find((row) => row.packageName === "@cleverc2200/gea-dsh-prototype")
      .state,
    "available",
  );
});
test("Windows check and submission reject before download, acceptance or any package mutation", async (t) => {
  const { controllerFixture } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const available = controller
    .snapshot()
    .items.find((row) => row.state === "available");
  const before = await readFile(join(f.dir, "package.json"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    await assert.rejects(
      controller.submit({
        packageName: available.packageName,
        planId: available.planId,
      }),
      /UPDATE_PROCESS_PLATFORM_UNSUPPORTED/,
    );
    await controller.check();
    assert.ok(
      controller
        .snapshot()
        .items.every(
          (row) =>
            row.state === "blocked" &&
            row.diagnostic === "UPDATE_PROCESS_PLATFORM_UNSUPPORTED" &&
            row.planId === null,
        ),
    );
    assert.equal(controller.snapshot().operation, null);
    assert.deepEqual(await readFile(join(f.dir, "package.json")), before);
    await assert.rejects(readFile(join(f.dir, "invocations.ndjson")), {
      code: "ENOENT",
    });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("signed/HTTP check failures retain safe distinct provider errors while Core and graph failures retain required versions", async (t) => {
  const { controllerFixture } = await import(
    "./fixtures/plugin-updates/profile.mjs"
  );
  for (const [sourceFailure, expected] of [
    ["signature", "signature"],
    ["http", "http"],
    ["network", "unavailable"],
  ]) {
    const f = await controllerFixture(t, { sourceFailure });
    const controller = createPluginUpdateController(f.options);
    t.after(() => controller.dispose());
    await controller.initialize();
    await controller.check();
    const snapshot = controller.snapshot();
    assert.ok(
      snapshot.items.every(
        (row) => row.state === "check-failed" && row.planId === null,
      ),
    );
    const status = parseUpdateClientStatus({
      revision: snapshot.revision,
      items: snapshot.items,
      hostProcessIdentity: "fixture",
      challenge: "nonce",
      checkTimeoutMs: 1000,
      pollIntervalMs: 1000,
    });
    const projected = projectPluginUpdates(status.items);
    assert.ok(
      Object.values(projected).every(
        (row) =>
          row.kind === "check-failed" &&
          row.problem.kind === "source" &&
          row.problem.code === expected,
      ),
    );
    assert.ok(!JSON.stringify(status).includes("secret-credential"));
    assert.ok(!JSON.stringify(status).includes("/private/path"));
  }
  const f = await controllerFixture(t),
    controller = createPluginUpdateController({
      ...f.options,
      core: { ...f.options.core, head: "b".repeat(40) },
    });
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const core = projectPluginUpdates(controller.snapshot().items)[
    "@cleverc2200/gea-dsh-prototype"
  ];
  assert.equal(core.kind, "blocked");
  assert.equal(core.problem.kind, "core");
  assert.equal(core.problem.current.version, "0.2.0-rc.2");
  assert.deepEqual(core.problem.required, [
    { version: "0.2.0-rc.2", revision: "a".repeat(40) },
  ]);
});
