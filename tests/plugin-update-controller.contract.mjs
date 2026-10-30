import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk) throw Error("GEA_PLUGIN_UPDATE_SDK must explicitly name unchanged fixed SDK");
// Verify the unchanged public installation and locking source used by this SDK lane.
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
  for (const root of [sdk])
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
  fileURLToPath(new URL("../.runtime/plugin-update-controller-module-", import.meta.url)),
);
const modulePath = join(work, "controller.mjs");
const subjectPath = join(work, "subjects.ts");
await writeFile(
  subjectPath,
  `export * from ${JSON.stringify(fileURLToPath(new URL("../src/host/plugin-update-controller.ts", import.meta.url)))};export {parseUpdateClientStatus} from ${JSON.stringify(fileURLToPath(new URL("../src/shared/plugin-update-wire.ts", import.meta.url)))};export {retainsProfileUpdates, readPluginProfile, pluginProfileStoreDirectory} from ${JSON.stringify(fileURLToPath(new URL("../src/host/plugin-update-profile.ts", import.meta.url)))};`,
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
          "@deepseek-ai/dsh-atomic-write": "packages/util/atomic-write/lib/index.js",
          "@deepseek-ai/dsh-app-boot": "packages/boot/app-boot/lib/index.js",
        };
        b.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
          aliases[args.path] ? { path: join(sdk, aliases[args.path]), external: true } : undefined,
        );
      },
    },
  ],
});
const {
  createPluginUpdateController,
  readPluginProfile,
  parseUpdateClientStatus,
  pluginProfileStoreDirectory,
  retainsProfileUpdates,
} = await import(pathToFileURL(modulePath));

test("accepted updates preserve personal Agents, customizations and complete Skill assets without backups", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const data = join(f.profile.home, "agent-plugins/data");
  const skill = join(data, "user-agents.json.skills/personal/versions/one/tree");
  await mkdir(join(skill, "references"), { recursive: true });
  const files = {
    "user-agents.json": JSON.stringify({
      version: 1,
      agents: [
        {
          id: "personal",
          prompt: "keep my prompt",
          skills: [{ directory: { root: skill } }],
        },
      ],
    }),
    "selected-resources.json": JSON.stringify({
      version: 1,
      selected: ["gea-readonly"],
      customizations: { "gea-readonly": { prompt: "my plugin override" } },
    }),
    "user-agents.json.skills/personal/versions/one/tree/SKILL.md":
      "# My skill\nSee [reference](references/rules.md)",
    "user-agents.json.skills/personal/versions/one/tree/references/rules.md":
      "Personal rules must survive updates\n",
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(data, name), value);
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((item) => item.planId);
  await controller.submit({
    packageName: row.packageName,
    planId: row.planId,
  });
  const operation = await waitForStage(controller, ["pending-restart", "unknown", "restored"]);
  assert.equal(operation.stage, "pending-restart", JSON.stringify(operation));
  assert.equal(operation.schema, 2);
  assert.equal(operation.userDataSha256, undefined);
  await assert.rejects(readFile(join(operation.directory, "recovery/snapshot.json")), {
    code: "ENOENT",
  });
  for (const [name, value] of Object.entries(files)) {
    assert.equal(await readFile(join(data, name), "utf8"), value);
  }
});
test(
  "update never traverses dependency file trees or creates a snapshot stage",
  { skip: process.platform === "win32" },
  async (t) => {
    const { execFileSync } = await import("node:child_process");
    const { controllerFixture, waitForStage } =
      await import("./fixtures/plugin-updates/profile.mjs");
    const f = await controllerFixture(t);
    execFileSync("mkfifo", [join(f.dir, "node_modules/unrelated-pipe")]);
    const controller = createPluginUpdateController(f.options);
    t.after(() => controller.dispose());
    const stages = [];
    controller.subscribe((snapshot) => stages.push(...snapshot.items.map((row) => row.state)));
    await controller.initialize();
    await controller.check();
    const row = controller.snapshot().items.find((item) => item.planId);
    assert.ok(row, JSON.stringify(controller.snapshot()));
    await controller.submit({ packageName: row.packageName, planId: row.planId });
    const operation = await waitForStage(controller, ["pending-restart", "failed", "unknown"]);
    assert.equal(operation.stage, "pending-restart", JSON.stringify(operation));
    assert.ok(!stages.includes("snapshotting"));
    await assert.rejects(readFile(join(operation.directory, "recovery/snapshot.json")), {
      code: "ENOENT",
    });
  },
);

test("profile store metadata selects its existing directory and rejects unusable state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plugin-update-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules");
  await mkdir(modules);
  await assert.rejects(pluginProfileStoreDirectory(root), /PROFILE_STORE_UNAVAILABLE/);
  for (const metadata of ["[invalid", "{}", '{"storeDir":"relative"}']) {
    await writeFile(join(modules, ".modules.yaml"), metadata);
    await assert.rejects(pluginProfileStoreDirectory(root), /PROFILE_STORE_INVALID/);
  }
  const store = join(root, "arbitrary company cache", "v11");
  await writeFile(join(modules, ".modules.yaml"), JSON.stringify({ storeDir: store }));
  await assert.rejects(pluginProfileStoreDirectory(root), /PROFILE_STORE_UNAVAILABLE/);
  await mkdir(store, { recursive: true });
  assert.equal(await pluginProfileStoreDirectory(root), store);
});
test("missing store metadata stops an update before acceptance or profile mutation", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  await rm(join(f.dir, "node_modules/.modules.yaml"));
  const before = (await readPluginProfile(f.dir)).sha256;
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((item) => item.packageName === "@cleverc2200/gea-dsh-prototype");
  await assert.rejects(
    controller.submit({ packageName: row.packageName, planId: row.planId }),
    /PROFILE_STORE_UNAVAILABLE/,
  );
  assert.equal((await readPluginProfile(f.dir)).sha256, before);
  await assert.rejects(readFile(join(f.dir, "invocations.ndjson")), {
    code: "ENOENT",
  });
});
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
  assert.equal(await readFile(join(profile.dir, "package.json"), "utf8"), before);
});
test("durable accepted operation installs one existing package under official lock and waits for restart", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
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
  const revisionBeforeRecoveryProbe = controller.snapshot().revision;
  await Promise.all([controller.initialize(), controller.initialize()]);
  assert.equal(controller.snapshot().revision, revisionBeforeRecoveryProbe);
  assert.equal(controller.snapshot().operation.id, accepted.id);
  assert.equal(controller.snapshot().operation.stage, "accepted");
  assert.equal(controller.snapshot().operation.diagnostic, null);
  assert.equal(
    JSON.parse(await readFile(join(f.options.runtimeDirectory, "latest.json"), "utf8")).id,
    accepted.id,
  );
  const operation = await waitForStage(controller, ["pending-restart", "unknown", "restored"]);
  assert.equal(operation.stage, "pending-restart", JSON.stringify(operation));
  const changed = JSON.parse(
    await readFile(join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/package.json"), "utf8"),
  );
  assert.equal(changed.version, "3.1.0");
  assert.equal(
    controller.snapshot().items.find((row) => row.packageName === accepted.packageName)
      .runningHostVersion,
    "3.0.0",
  );
  assert.equal(
    controller.snapshot().items.find((row) => row.packageName === accepted.packageName)
      .installedVersion,
    "3.1.0",
  );
  const invocation = JSON.parse((await readFile(join(f.dir, "invocations.ndjson"), "utf8")).trim());
  assert.equal(invocation.args[0], "--fixture-prefix");
  assert.equal(invocation.marker, "launcher-provided");
  assert.equal(invocation.cwd, await realpath(f.dir));
  await assert.rejects(
    controller.submit({ packageName: row.packageName, planId: row.planId }),
    /UPDATE_OPERATION_BLOCKED/,
  );
});
test.after(() => rm(work, { recursive: true, force: true }));
test("a failed package process reports failure and retains its log without claiming rollback", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { mode: "fail-after-write" }),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const outcome = await waitForStage(controller, ["failed", "unknown"]);
  assert.equal(outcome.stage, "failed", JSON.stringify(outcome));
  assert.equal(outcome.diagnostic, "PACKAGE_INSTALL_FAILED");
  assert.ok(outcome.logs.length);
  assert.match(await readFile(outcome.logs[0], "utf8"), /fixture package run started/);
  assert.equal(
    JSON.parse(await readFile(join(f.dir, "node_modules", row.packageName, "package.json"), "utf8"))
      .version,
    "3.1.0",
  );
  await controller.check();
  assert.equal(
    controller.snapshot().items.find((item) => item.packageName === row.packageName).state,
    "current",
  );
});
test("unmanaged profile field changes report failure without overwriting user settings", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { mode: "bad-fields" }),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const outcome = await waitForStage(controller, ["failed", "unknown"]);
  assert.equal(outcome.stage, "failed", JSON.stringify(outcome));
  assert.equal(outcome.diagnostic, "PROFILE_SETTINGS_OWNERSHIP_UNCONFIRMED");
  assert.equal(
    JSON.parse(await readFile(join(f.dir, "package.json"), "utf8")).retained.draft,
    "broken",
  );
});
test("the official profile lock rechecks a changed baseline before any package-manager invocation", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.state === "available");
  const { withFileLock } = await import(
    pathToFileURL(join(sdk, "packages/util/atomic-write/lib/index.js"))
  );
  let unlock, started;
  const acquired = new Promise((resolve) => (started = resolve)),
    held = new Promise((resolve) => (unlock = resolve));
  const writer = withFileLock(join(f.dir, "package.json"), async () => {
    started();
    await held;
    await writeFile(join(f.dir, "pnpm-lock.yaml"), "another writer updated lock\n");
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
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { mode: "idle-exit-zero" }),
    controller = createPluginUpdateController({
      ...f.options,
      idleTimeoutMs: 300,
    });
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const result = await waitForStage(controller, ["failed", "unknown", "pending-restart"]);
  assert.equal(result.stage, "failed", JSON.stringify(result));
});
test(
  "an orphan writer produces unknown without rollback, and Host unload kills and awaits its recorded group",
  { skip: process.platform === "win32" },
  async (t) => {
    const { controllerFixture, waitForStage } =
      await import("./fixtures/plugin-updates/profile.mjs");
    const f = await controllerFixture(t, { mode: "orphan" }),
      controller = createPluginUpdateController(f.options);
    await controller.initialize();
    await controller.check();
    const row = controller.snapshot().items.find((row) => row.state === "available");
    await controller.submit({
      packageName: row.packageName,
      planId: row.planId,
    });
    const result = await waitForStage(controller, ["unknown", "pending-restart"]);
    assert.equal(result.stage, "unknown", JSON.stringify(result));
    assert.equal(result.diagnostic, "PACKAGE_WRITERS_UNCONFIRMED");
    assert.equal(
      JSON.parse(
        await readFile(
          join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/package.json"),
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
      (await readFile(join(f.dir, "invocations.ndjson"), "utf8")).trim().split("\n").length,
      1,
    );
  },
);
test("Host unload cancels an accepted operation and reports failure after quiescence", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { mode: "slow" }),
    controller = createPluginUpdateController(f.options);
  const before = await readFile(join(f.dir, "package.json"), "utf8");
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.state === "available");
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
  assert.equal(controller.snapshot().operation.stage, "failed");
  assert.equal(await readFile(join(f.dir, "package.json"), "utf8"), before);
});
test("a new Host can retry an accepted operation whose process exited before installation", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const releases = await f.source.check();
  const archives = {};
  for (const release of releases)
    archives[release.name] = await f.source.download(
      release,
      join(f.options.runtimeDirectory, "cache"),
    );
  const input = join(f.root, "accepted-options.json");
  await writeFile(
    input,
    JSON.stringify({
      ...f.options,
      proofs: f.proofs,
      releases,
      archives,
      source: undefined,
      readRuntimeProofs: undefined,
    }),
  );
  const script = join(f.root, "accept-and-exit.mjs");
  await writeFile(
    script,
    `import {createPluginUpdateController} from ${JSON.stringify(pathToFileURL(modulePath).href)};import{readFile}from'node:fs/promises';const input=JSON.parse(await readFile(process.argv[2],'utf8'));const controller=createPluginUpdateController({...input,source:{check:async()=>input.releases,download:async release=>input.archives[release.name],assertCurrentRelease(){}},readRuntimeProofs:async()=>input.proofs});await controller.initialize();await controller.check();const row=controller.snapshot().items.find(row=>row.planId);const accepted=await controller.submit({packageName:row.packageName,planId:row.planId});console.log(JSON.stringify(accepted));process.exit(0);`,
  );
  const accepted = JSON.parse(
    execFileSync(process.execPath, [script, input], { encoding: "utf8" }),
  );
  const receipt = JSON.parse(await readFile(join(accepted.directory, "receipt.json"), "utf8"));
  assert.equal(receipt.stage, "accepted");
  assert.deepEqual(receipt.processes, []);
  await assert.rejects(readFile(join(f.dir, "invocations.ndjson")), { code: "ENOENT" });
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  assert.equal(controller.snapshot().operation.stage, "failed");
  assert.equal(controller.snapshot().operation.diagnostic, "PREVIOUS_OPERATION_INTERRUPTED");
  await controller.check();
  assert.equal(controller.snapshot().items[2].state, "available");
});
test("submission rejects live and malformed run records but lets the official runner clear an exited writer", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  await mkdir(join(f.dir, ".plugin-manager"), { recursive: true });
  const run = join(f.dir, ".plugin-manager/run.json");
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  for (const record of [JSON.stringify({ pid: process.pid, grouped: false }), "invalid"]) {
    await writeFile(run, record);
    await controller.check();
    const row = controller.snapshot().items.find((row) => row.planId);
    await assert.rejects(
      controller.submit({ packageName: row.packageName, planId: row.planId }),
      /PROFILE_WRITER_UNCONFIRMED/,
    );
    assert.equal(controller.snapshot().operation, null);
    await assert.rejects(readFile(join(f.dir, "invocations.ndjson")), { code: "ENOENT" });
  }
  await writeFile(run, JSON.stringify({ pid: 2147483647, grouped: true }));
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.planId);
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  assert.equal(
    (await waitForStage(controller, ["pending-restart", "failed", "unknown"])).stage,
    "pending-restart",
  );
  await assert.rejects(readFile(run), { code: "ENOENT" });
});
test("pending receipt survives recreation in the same Node process and needs a genuinely new process plus client observation", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  const skillFile = join(
    f.profile.home,
    "agent-plugins/data/user-agents.json.skills/one/tree/references/rules.md",
  );
  await mkdir(join(skillFile, ".."), { recursive: true });
  await writeFile(skillFile, "Keep my referenced Skill resource\n");
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.state === "available");
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
  oldBrowserProofs.find((proof) => proof.name === row.packageName).client.stamp.version = "3.0.0";
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
  assert.equal(oldBrowser.operation.stage, "pending-restart", JSON.stringify(oldBrowser));
  const receiptFile = join(
    f.options.runtimeDirectory,
    "operations",
    oldBrowser.operation.id,
    "receipt.json",
  );
  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  await writeFile(
    join(f.dir, ".plugin-manager/run.json"),
    JSON.stringify({ pid: process.pid, grouped: false }),
  );
  const writing = JSON.parse(execFileSync(process.execPath, [script, input], { encoding: "utf8" }));
  assert.equal(writing.operation.stage, "pending-restart");
  await rm(join(f.dir, ".plugin-manager/run.json"));
  await writeFile(
    join(f.dir, ".plugin-manager/run.json"),
    JSON.stringify({ pid: 2147483647, grouped: true }),
  );
  const staleWriter = JSON.parse(
    execFileSync(process.execPath, [script, input], { encoding: "utf8" }),
  );
  assert.equal(staleWriter.operation.stage, "completed");
  await rm(join(f.dir, ".plugin-manager/run.json"));
  await writeFile(receiptFile, JSON.stringify(receipt));

  const legacy = {
    ...receipt,
    schema: 1,
    recoveryDirectory: join(receipt.directory, "recovery"),
    baselineSha256: "a".repeat(64),
    installedGraphSha256: "b".repeat(64),
    userDataSha256: "c".repeat(64),
  };
  delete legacy.directory;
  await writeFile(receiptFile, JSON.stringify(legacy));
  await writeFile(skillFile, "User edited their Skill after installing\n");
  await writeFile(join(f.dir, "node_modules", "unrelated-cache"), "changed since installation");
  const fresh = JSON.parse(execFileSync(process.execPath, [script, input], { encoding: "utf8" }));
  assert.equal(fresh.operation.stage, "completed", JSON.stringify(fresh));
  assert.equal(fresh.operation.schema, 2);
  assert.deepEqual(
    JSON.parse(await readFile(join(receipt.directory, "receipt.legacy.json"), "utf8")),
    legacy,
  );
  assert.notEqual(fresh.actualProcessIdentity, `${process.pid}:${performance.timeOrigin}`);
  await writeFile(
    receiptFile,
    JSON.stringify({
      ...receipt,
      stage: "unknown",
      processes: [{ pid: process.pid, grouped: true, startIdentity: "parent", sawAlive: true }],
    }),
  );
  const aliveWriter = JSON.parse(
    execFileSync(process.execPath, [script, input], { encoding: "utf8" }),
  );
  assert.equal(aliveWriter.operation.stage, "unknown");
  await writeFile(
    receiptFile,
    JSON.stringify({
      ...receipt,
      stage: "unknown",
      processes: [{ pid: 2147483647, grouped: true, startIdentity: "gone", sawAlive: true }],
    }),
  );
  const recovered = JSON.parse(
    execFileSync(process.execPath, [script, input], { encoding: "utf8" }),
  );
  assert.equal(recovered.operation.stage, "completed");
  await writeFile(receiptFile, JSON.stringify(receipt));
  const oldHost = JSON.parse(
    execFileSync(process.execPath, [script, oldBrowserInput], { encoding: "utf8" }),
  );
  assert.equal(oldHost.operation.stage, "pending-restart");
});
test("concurrent user patch and default selection survive a failed installation", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { mode: "fail-after-write" }),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.state === "available");
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const { withFileLock } = await import(
    pathToFileURL(join(sdk, "packages/util/atomic-write/lib/index.js"))
  );
  const newPatch = "user selected a new default during installation\n";
  await withFileLock(join(f.dir, "cordis.patch.yml"), () =>
    writeFile(join(f.dir, "cordis.patch.yml"), newPatch),
  );
  const outcome = await waitForStage(controller, ["failed", "unknown"]);
  assert.equal(outcome.stage, "failed", JSON.stringify(outcome));
  assert.equal(await readFile(join(f.dir, "cordis.patch.yml"), "utf8"), newPatch);
  assert.equal(
    JSON.parse(
      await readFile(
        join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/package.json"),
        "utf8",
      ),
    ).version,
    "3.1.0",
  );
});
test("receipt replacement failure after mutation remains unknown and unreadable durable evidence blocks reopening", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.state === "available");
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
  const receipt = join(accepted.directory, "receipt.json");
  const durableBefore = await readFile(receipt);
  await writeFile(join(accepted.directory, "last-durable-receipt.json"), durableBefore);
  await rm(receipt);
  await mkdir(receipt);
  const result = await waitForStage(controller, ["unknown", "pending-restart"]);
  assert.equal(result.stage, "unknown", JSON.stringify(result));
  assert.equal(result.diagnostic, "UPDATE_RECEIPT_WRITE_FAILED");
  await controller.dispose();
  const reopened = createPluginUpdateController(f.options);
  await reopened.initialize();
  assert.ok(reopened.snapshot().items.every((item) => item.state === "unknown"));
  await assert.rejects(
    reopened.submit({ packageName: row.packageName, planId: row.planId }),
    /UPDATE_OPERATION_BLOCKED/,
  );
  await reopened.dispose();
});

async function bridgeControllerFixture(t, { workbenchFirst = false } = {}) {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, {
    allUpdates: true,
    releasePeers: workbenchFirst
      ? {
          "@cleverc2200/gea-dsh-prototype": {
            "@cleverc2200/dsh-agent-workbench": "1.1.0",
            "dsh-agent-manage": "^2.0.0",
          },
        }
      : {},
  });
  const file = join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...manifest,
      peerDependencies: {
        "@cleverc2200/dsh-agent-workbench": workbenchFirst ? "^1.0.0" : "1.0.0",
        "dsh-agent-manage": "2.0.0",
      },
    }),
  );
  return f;
}

for (const workbenchFirst of [false, true])
  test(`suite plans the full target without making the user choose an update order (${workbenchFirst})`, async (t) => {
    const f = await bridgeControllerFixture(t, { workbenchFirst });
    const controller = createPluginUpdateController(f.options);
    t.after(() => controller.dispose());
    await controller.initialize();
    await controller.check();
    assert.ok(controller.snapshot().items.every((row) => row.state === "available" && row.planId));
  });

test("legacy bridge companions form one suite and a legacy single request installs every changed package", async (t) => {
  const { waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await bridgeControllerFixture(t);
  const G = "@cleverc2200/gea-dsh-prototype";
  const channel = "https://fixture.invalid/channels/test.json";
  const envelope = JSON.parse(f.files.get(channel));
  const payload = JSON.parse(Buffer.from(envelope.payloadBase64, "base64"));
  payload.companionReleases = payload.releases.filter((row) => row.name !== G);
  payload.releases = payload.releases.filter((row) => row.name === G);
  const bytes = Buffer.from(JSON.stringify(payload));
  f.files.set(
    channel,
    Buffer.from(
      JSON.stringify({
        ...envelope,
        payloadBase64: bytes.toString("base64"),
      }),
    ),
  );
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.packageName === G);
  const accepted = await controller.submit({
    packageName: G,
    planId: row.planId,
  });
  assert.equal(accepted.targets.length, 3);
  assert.equal(
    (await waitForStage(controller, ["pending-restart", "failed", "unknown"])).stage,
    "pending-restart",
  );
  const calls = (await readFile(join(f.dir, "invocations.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.filter((arg) => arg.startsWith("file:")).length, 3);
});

test("company version planning leaves installed consumer compatibility to the official runner", async (t) => {
  const f = await bridgeControllerFixture(t);
  const consumerDir = join(f.dir, "node_modules/fixed-consumer");
  await mkdir(consumerDir);
  await writeFile(
    join(consumerDir, "package.json"),
    JSON.stringify({
      name: "fixed-consumer",
      version: "1.0.0",
      peerDependencies: { "@cleverc2200/dsh-agent-workbench": "1.0.0" },
    }),
  );
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  assert.ok(controller.snapshot().items.every((row) => row.state === "available" && row.planId));
});

test("a legacy updater can install the compatible GEA bridge before the suite updater finishes the companions", async (t) => {
  const { waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const { planPluginUpdate } = await import("../src/shared/plugin-release.mjs");
  const { preservedSession } = await import("./fixtures/plugin-updates/preserved-session.mjs");
  const { runProfilePnpm } = await import(
    pathToFileURL(join(sdk, "packages/boot/plugin-manager/lib/types/operations.js"))
  );
  const { withFileLock } = await import(
    pathToFileURL(join(sdk, "packages/util/atomic-write/lib/index.js"))
  );
  const f = await bridgeControllerFixture(t);
  const verifySession = await preservedSession(sdk, f.root);
  const releases = await f.source.check();
  const bridge = releases.find((row) => row.name === "@cleverc2200/gea-dsh-prototype");
  const before = await readPluginProfile(f.dir);
  assert.equal(
    planPluginUpdate({
      release: bridge,
      core: f.options.core,
      installed: before.packages,
    }).kind,
    "ready",
  );
  const archivePath = await f.source.download(bridge, join(f.root, "bridge-cache"));
  const result = await withFileLock(join(f.dir, "package.json"), () =>
    runProfilePnpm(f.profile, ["add", "file:" + archivePath, "--save-exact", "--ignore-scripts"], {
      ...f.profile.packageManager,
      execution: "service",
      activateNewBundles: false,
      outputBytes: 16000,
    }),
  );
  assert.equal(result.exitCode, 0);
  f.proofs[2].host.stamp.version = bridge.version;
  f.proofs[2].client.stamp.version = bridge.version;
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  assert.equal(controller.snapshot().items[2].state, "current");
  const selected = controller.snapshot().items.filter((row) => row.state === "available");
  assert.equal(selected.length, 2);
  const operation = await controller.submit({
    packageName: selected[0].packageName,
    planId: selected[0].planId,
  });
  assert.equal(operation.targets.length, 2);
  assert.equal(
    (await waitForStage(controller, ["pending-restart", "failed", "unknown"])).stage,
    "pending-restart",
  );
  await verifySession();
});

test("a missing suite download or a stale whole-suite plan never starts a package writer", async (t) => {
  const f = await bridgeControllerFixture(t);
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const stale = controller.snapshot().items[0];
  await controller.check();
  await assert.rejects(
    controller.submit({ packageName: stale.packageName, planId: stale.planId }),
    /UPDATE_PLAN_STALE/,
  );
  const before = await readPluginProfile(f.dir);
  const releases = await f.source.check();
  f.files.delete(releases[1].artifact.url);
  const selected = controller.snapshot().items[0];
  await assert.rejects(
    controller.submit({
      packageName: selected.packageName,
      planId: selected.planId,
    }),
    /SOURCE_/,
  );
  assert.equal((await readPluginProfile(f.dir)).sha256, before.sha256);
  assert.equal(controller.snapshot().operation, null);
  await assert.rejects(readFile(join(f.dir, "invocations.ndjson")), {
    code: "ENOENT",
  });
});

test("same-version replacement reports a content conflict without disclosing source details", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const channelUrl = "https://fixture.invalid/channels/test.json";
  const channel = JSON.parse(f.files.get(channelUrl));
  const payload = JSON.parse(Buffer.from(channel.payloadBase64, "base64"));
  const reference = payload.releases[2];
  const release = JSON.parse(f.files.get(reference.url));
  release.artifact.sha256 = "d".repeat(64);
  release.artifact.url = `https://fixture.invalid/packages/${"d".repeat(64)}/plugin.tgz`;
  const bytes = Buffer.from(JSON.stringify(release));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const url = `https://fixture.invalid/releases/${sha256}/release.json`;
  f.files.set(url, bytes);
  payload.releases[2] = { ...reference, url, sha256 };
  payload.revision = 2;
  const signed = Buffer.from(JSON.stringify(payload));
  f.files.set(
    channelUrl,
    Buffer.from(
      JSON.stringify({
        ...channel,
        payloadBase64: signed.toString("base64"),
      }),
    ),
  );
  await controller.check();
  const row = controller.snapshot().items.find((item) => item.packageName === release.name);
  assert.equal(row.diagnostic, "SOURCE_SAME_VERSION_CONTENT_MISMATCH");
  assert.deepEqual(row.problem, { kind: "policy", code: "content-mismatch" });
  assert.equal(row.planId, null);
  assert.equal(controller.snapshot().operation, null);
  assert.doesNotMatch(JSON.stringify(row.problem), /fixture.invalid|signatureBase64|source-trust/);
});

test("older channel keeps its candidate and reports a downgrade without accepting an update", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const name = "@cleverc2200/gea-dsh-prototype";
  const file = join(f.dir, "node_modules", name, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...manifest, version: "3.2.0" }));
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((item) => item.packageName === name);
  assert.equal(row.state, "blocked");
  assert.equal(row.diagnostic, "DOWNGRADE_FORBIDDEN");
  assert.equal(row.installedVersion, "3.2.0");
  assert.equal(row.candidateVersion, "3.1.0");
  assert.deepEqual(row.problem, { kind: "policy", code: "channel-older" });
  assert.equal(row.planId, null);
  await assert.rejects(
    controller.submit({ packageName: name, planId: "not-a-plan" }),
    /UPDATE_PLAN/,
  );
  assert.equal(controller.snapshot().operation, null);
});

test("plugin installation exits after Done even when the pnpm update registry never responds", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const { installPnpmConsumerLayout } = await import("./fixtures/plugin-updates/pnpm-profile.mjs");
  const { configureStalledPnpmRegistry } =
    await import("./fixtures/plugin-updates/stalled-registry.mjs");
  const f = await controllerFixture(t);
  const { manager } = await installPnpmConsumerLayout(f, "^3.0.0");
  f.profile.packageManager.args = [manager];
  const registry = await configureStalledPnpmRegistry(t, f.profile);
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const item = controller.snapshot().items.find((item) => item.planId);
  await controller.submit({ packageName: item.packageName, planId: item.planId });
  const operation = await waitForStage(controller, ["pending-restart", "failed", "unknown"]);
  const log = await readFile(operation.logs[0], "utf8");
  assert.match(log, /Done in .*using pnpm v11\.7\.0/);
  assert.equal(
    operation.stage,
    "pending-restart",
    JSON.stringify({ operation, requests: registry.requests, log }),
  );
  assert.deepEqual(registry.requests, []);
});

test("company profile reading uses real pnpm roots without traversing obsolete or transitive contents", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const { installPnpmConsumerLayout } = await import("./fixtures/plugin-updates/pnpm-profile.mjs");
  const f = await controllerFixture(t);
  await installPnpmConsumerLayout(f, "^3.0.0");
  const stale = join(f.dir, "node_modules/.pnpm/obsolete-context/node_modules/obsolete-consumer");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "package.json"), "invalid obsolete manifest");
  const graph = await readPluginProfile(f.dir);
  assert.equal(graph.packages.length, 3);
  assert.ok(graph.packages.every((pkg) => pkg.root));
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  assert.equal(controller.snapshot().items[2].state, "available");
});

test("Windows checks the signed channel even before package installation capability is available", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t),
    controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const available = controller.snapshot().items.find((row) => row.state === "available");
  const before = await readFile(join(f.dir, "package.json"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    await assert.rejects(
      controller.submit({
        packageName: available.packageName,
        planId: available.planId,
      }),
      /UPDATE_WINDOWS_LAUNCHER_UNSUPPORTED/,
    );
    await controller.check();
    assert.ok(
      controller
        .snapshot()
        .items.every(
          (row) => ["available", "current"].includes(row.state) && row.diagnostic === null,
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

test("signed/HTTP check failures retain safe distinct status errors while Core and graph failures retain required versions", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  for (const [sourceFailure, expected] of [
    ["schema", "unavailable"],
    ["http", "http"],
    ["network", "unavailable"],
  ]) {
    const f = await controllerFixture(t, { sourceFailure });
    const controller = createPluginUpdateController(f.options);
    t.after(() => controller.dispose());
    await controller.initialize();
    await controller.check();
    const snapshot = controller.snapshot();
    assert.ok(snapshot.items.every((row) => row.state === "check-failed" && row.planId === null));
    const status = parseUpdateClientStatus({
      revision: snapshot.revision,
      items: snapshot.items,
      hostProcessIdentity: "fixture",
      challenge: "nonce",
      checkTimeoutMs: 1000,
      pollIntervalMs: 1000,
    });
    assert.ok(
      status.items.every(
        (row) =>
          row.state === "check-failed" &&
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
  const core = controller
    .snapshot()
    .items.find((row) => row.packageName === "@cleverc2200/gea-dsh-prototype");
  assert.equal(core.state, "blocked");
  assert.equal(core.problem.kind, "core");
  assert.equal(core.problem.current.version, "0.2.0-rc.2");
  assert.deepEqual(core.problem.required, [{ version: "0.2.0-rc.2", revision: "a".repeat(40) }]);
});

test("an incomplete channel blocks the entire suite without leaving checking rows", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const originalCheck = f.options.source.check;
  f.options.source = {
    ...f.options.source,
    check: async (signal) =>
      (await originalCheck(signal)).filter((r) => r.name === "@cleverc2200/gea-dsh-prototype"),
  };
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const items = controller.snapshot().items;
  assert.equal(
    items.find((r) => r.packageName === "@cleverc2200/gea-dsh-prototype").state,
    "blocked",
  );
  assert.ok(items.every((row) => row.planId === null));
  for (const row of items.filter((r) => r.packageName !== "@cleverc2200/gea-dsh-prototype")) {
    assert.equal(row.state, "blocked");
    assert.deepEqual(row.problem, {
      kind: "policy",
      code: "release-not-published",
    });
  }
});

test("an absent optional executable target does not block update or change its saved link", async (t) => {
  const { symlink, readlink } = await import("node:fs/promises");
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const bin = join(f.dir, "node_modules/.bin");
  await mkdir(bin, { recursive: true });
  const target = "../optional-tunnel/bin/cloudflared";
  await symlink(target, join(bin, "cloudflared"));
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller
    .snapshot()
    .items.find((item) => item.packageName === "@cleverc2200/gea-dsh-prototype");
  assert.equal(row.state, "available", JSON.stringify(controller.snapshot()));
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  const operation = await waitForStage(controller, ["pending-restart", "unknown", "restored"]);
  assert.equal(operation.stage, "pending-restart", JSON.stringify(operation));
  assert.equal(await readlink(join(bin, "cloudflared")), target);
});

test("Windows accepts pnpm file separators only for the selected exact archive", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    const release = { name: "selected-plugin" },
      archive = String.raw`C:\GEA\cache\signed.tgz`;
    const before = {
      manifest: {
        dependencies: { other: "1.0.0", "selected-plugin": "1.0.0" },
        retained: "keep",
      },
    };
    const after = structuredClone(before);
    after.manifest.dependencies[release.name] = "file:" + archive.replaceAll("\\", "/");
    assert.equal(retainsProfileUpdates(before, after, [{ release, archivePath: archive }]), true);
    after.manifest.retained = "changed";
    assert.equal(retainsProfileUpdates(before, after, [{ release, archivePath: archive }]), false);
    after.manifest.retained = "keep";
    after.manifest.dependencies[release.name] += ".different";
    assert.equal(retainsProfileUpdates(before, after, [{ release, archivePath: archive }]), false);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

for (const mode of ["success", "fail-after-first", "wrong-installed-version"]) {
  test(`batch update uses one owner and ${mode === "success" ? "installs all packages" : "reports failure after a partial or wrong-version install"}`, async (t) => {
    const { controllerFixture, waitForStage } =
      await import("./fixtures/plugin-updates/profile.mjs");
    const f = await controllerFixture(t, { mode, allUpdates: true });
    const { preservedSession } = await import("./fixtures/plugin-updates/preserved-session.mjs");
    const verifySession = await preservedSession(sdk, f.root);
    const before = await readPluginProfile(f.dir);
    const controller = createPluginUpdateController(f.options);
    t.after(() => controller.dispose());
    await controller.initialize();
    await controller.check();
    const requests = controller
      .snapshot()
      .items.map(({ packageName, planId }) => ({ packageName, planId }));
    assert.equal(requests.length, 3);
    assert.ok(requests.every((row) => row.planId));
    const accepted = await controller.submitBatch(requests);
    assert.equal(accepted.targets.length, 3);
    await assert.rejects(controller.submitBatch(requests), /UPDATE_OPERATION_BLOCKED/);
    const operation = await waitForStage(controller, ["pending-restart", "failed", "unknown"]);
    assert.equal(operation.stage, mode === "success" ? "pending-restart" : "failed");
    const calls = (await readFile(join(f.dir, "invocations.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.filter((arg) => arg.startsWith("file:")).length, 3);
    const after = await readPluginProfile(f.dir);
    if (mode === "success") {
      assert.deepEqual(
        controller.snapshot().items.map((row) => row.state),
        Array(3).fill("pending-restart"),
      );
      assert.deepEqual(
        controller.snapshot().items.map((row) => row.installedVersion),
        ["1.1.0", "2.1.0", "3.1.0"],
      );
      assert.deepEqual(after.manifest.retained, before.manifest.retained);
      await controller.dispose();
      const reopened = createPluginUpdateController(f.options);
      t.after(() => reopened.dispose());
      await reopened.initialize();
      assert.deepEqual(
        reopened.snapshot().items.map((row) => row.state),
        Array(3).fill("pending-restart"),
      );
    } else {
      assert.equal(
        operation.diagnostic,
        mode === "fail-after-first" ? "PACKAGE_INSTALL_FAILED" : "PACKAGE_POSTCHECK_FAILED",
      );
      assert.deepEqual(after.manifest.retained, before.manifest.retained);
    }
    await verifySession();
  });
}

test("an inactive companion blocks all plans and disabling a companion after check rejects the whole operation", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { allUpdates: true });
  const saved = f.proofs[1].host;
  f.proofs[1].host = { kind: "unverified", reason: "HOST_MODULE_NOT_ACTIVE" };
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  assert.ok(
    controller.snapshot().items.every((row) => row.state === "blocked" && row.planId === null),
  );
  f.proofs[1].host = saved;
  await controller.check();
  const selected = controller.snapshot().items.filter((row) => row.state === "available");
  assert.equal(selected.length, 3);
  const before = (await readPluginProfile(f.dir)).sha256;
  f.proofs[1].host = { kind: "unverified", reason: "HOST_MODULE_NOT_ACTIVE" };
  await assert.rejects(
    controller.submit({
      packageName: selected[0].packageName,
      planId: selected[0].planId,
    }),
    /UPDATE_PACKAGE_INACTIVE/,
  );
  assert.equal((await readPluginProfile(f.dir)).sha256, before);
  assert.equal(controller.snapshot().operation, null);
  await assert.rejects(readFile(join(f.dir, "invocations.ndjson")), {
    code: "ENOENT",
  });
});

test("same-version inactive package reports its load diagnosis before current status", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const inactive = f.proofs[1];
  inactive.host = { kind: "unverified", reason: "HOST_MODULE_NOT_ACTIVE" };
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((item) => item.packageName === inactive.name);
  assert.equal(row.installedVersion, "2.0.0");
  assert.equal(row.state, "blocked");
  assert.equal(row.candidateVersion, "2.0.0");
  assert.equal(row.planId, null);
  assert.equal(row.diagnostic, "UPDATE_PACKAGE_INACTIVE");
  assert.deepEqual(row.problem, { kind: "policy", code: "inactive" });
});
