import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { until } from "./profile.mjs";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk) throw Error("GEA_PLUGIN_UPDATE_SDK must explicitly name unchanged fixed SDK");

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
  `export {mountDesktopUpdateOperations} from ${JSON.stringify(fileURLToPath(new URL("../src/host/plugin-update-desktop.ts", import.meta.url)))};export * from ${JSON.stringify(fileURLToPath(new URL("../src/host/plugin-update-controller.ts", import.meta.url)))};export {parseUpdateClientStatus} from ${JSON.stringify(fileURLToPath(new URL("../src/shared/plugin-update-wire.ts", import.meta.url)))};export {retainsProfileUpdates, readPluginProfile, pluginProfileStoreDirectory} from ${JSON.stringify(fileURLToPath(new URL("../src/host/plugin-update-profile.ts", import.meta.url)))};`,
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
  mountDesktopUpdateOperations,
  readPluginProfile,
  parseUpdateClientStatus,
  pluginProfileStoreDirectory,
  retainsProfileUpdates,
} = await import(pathToFileURL(modulePath));

test("an already verified desktop runs maintenance when the actual client and Host stamps arrive", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const id = "00000000-0000-4000-8000-000000000041";
  await f.installation.store.prepare({ id, install: async () => {} });
  const version = join(f.installation.store.root, "versions", id, "version.json");
  const proof = f.proofs[0];
  const client = proof.client;
  proof.client = { kind: "unverified", reason: "fixture-awaiting-client" };
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  assert.equal(JSON.parse(await readFile(version)).id, id);
  proof.client = client;
  await controller.reconcileRuntime();
  await until(
    () =>
      readFile(version).then(
        () => true,
        (error) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        },
      ),
    (exists) => !exists,
  );
  assert.equal((await f.installation.store.status()).verified, "baseline");
});

test("legacy personal memory updates alone and requires a new stamped Host and client after restart", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { memory: true });
  const name = "@cleverc2200/dsh-personal-memory";
  const memory = f.proofs.find((proof) => proof.name === name);
  const ledger = join(f.dir, "personal-memory-sessions.json");
  await writeFile(ledger, '{"fixture":"preserved-session-binding"}\n');
  memory.host = { kind: "unversioned", identity: "legacy-memory-host" };
  memory.client = { kind: "unverified", reason: "legacy-memory-client" };
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.packageName === name);
  assert.equal(row.state, "available");
  assert.equal(row.runningHostVersion, null);
  assert.equal(row.candidateVersion, "0.1.2");
  assert.equal(controller.snapshot().items.filter((row) => row.state === "current").length, 3);
  parseUpdateClientStatus({
    revision: 1,
    items: controller.snapshot().items,
    hostProcessIdentity: "host",
    challenge: "nonce",
    checkTimeoutMs: 1000,
    pollIntervalMs: 1000,
  });
  await controller.submit({ packageName: name, planId: row.planId });
  await waitForStage(controller, ["pending-restart"]);
  assert.equal(controller.snapshot().operation.packageName, name);
  assert.equal(controller.snapshot().operation.targets, undefined);
  await controller.dispose();
  await f.installation.beginBoot();
  const script = join(f.root, "memory-restart.mjs");
  await writeFile(
    script,
    `import{createPluginUpdateController}from${JSON.stringify(pathToFileURL(modulePath).href)};import{readFile}from'node:fs/promises';const o=JSON.parse(await readFile(process.argv[2],'utf8'));const proofs=o.proofs;delete o.proofs;o.source={check:async()=>[],download:async()=>{throw Error('unused')},assertCurrentRelease:()=>{}};o.readRuntimeProofs=async id=>proofs.map(p=>({...p,client:p.client.kind==='observed'?{...p.client,binding:{...p.client.binding,hostProcessIdentity:id}}:p.client}));const c=createPluginUpdateController(o);await c.initialize();console.log(JSON.stringify(c.snapshot()));await c.dispose();`,
  );
  memory.host = { kind: "active", stamp: { name, version: "0.1.2" }, identity: "new-memory-host" };
  memory.client = {
    ...f.proofs[0].client,
    stamp: { name, version: "0.1.2" },
    identity: "new-memory-client",
  };
  const input = join(f.root, "memory-restart.json");
  await writeFile(
    input,
    JSON.stringify({
      ...f.options,
      source: undefined,
      readRuntimeProofs: undefined,
      proofs: f.proofs,
    }),
  );
  const result = JSON.parse(execFileSync(process.execPath, [script, input], { encoding: "utf8" }));
  assert.equal(result.operation.stage, "completed");
  assert.equal(await readFile(ledger, "utf8"), '{"fixture":"preserved-session-binding"}\n');
  assert.equal(result.items.find((row) => row.packageName === name).runningHostVersion, "0.1.2");
});

test("a receipt from the previous three-package updater completes after GEA first upgrades", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { memory: true, memoryBootstrap: true, managed: false });
  const oldModule = join(work, "previous-controller.mjs");
  const repository = fileURLToPath(new URL("..", import.meta.url));
  await build({
    entryPoints: [join(repository, "src/host/plugin-update-controller.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: oldModule,
    logLevel: "silent",
    plugins: [
      {
        name: "previous-shipped-updater",
        setup(b) {
          const aliases = {
            "@deepseek-ai/dsh-plugin-manager/operations":
              "packages/boot/plugin-manager/lib/types/operations.js",
            "@deepseek-ai/dsh-atomic-write": "packages/util/atomic-write/lib/index.js",
            "@deepseek-ai/dsh-app-boot": "packages/boot/app-boot/lib/index.js",
          };
          b.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
            aliases[args.path]
              ? { path: join(sdk, aliases[args.path]), external: true }
              : undefined,
          );
          b.onLoad({ filter: /\.(?:ts|mjs)$/ }, (args) => ({
            contents: execFileSync(
              "git",
              [
                "show",
                "9f3875b835a022d39bf9cf827787cad39a3dfeb9:" + relative(repository, args.path),
              ],
              { cwd: repository, encoding: "utf8" },
            ),
            loader: args.path.endsWith(".ts") ? "ts" : "js",
            resolveDir: dirname(args.path),
          }));
        },
      },
    ],
  });
  const previous = await import(pathToFileURL(oldModule));
  const controller = previous.createPluginUpdateController({
    ...f.options,
    source: {
      ...f.source,
      check: async (signal) =>
        (await f.source.check(signal)).filter((r) => r.name !== "@cleverc2200/dsh-personal-memory"),
    },
  });
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const target = controller.snapshot().items.find((row) => row.state === "available");
  assert.equal(target.packageName, "@cleverc2200/gea-dsh-prototype");
  await controller.submit({ packageName: target.packageName, planId: target.planId });
  await waitForStage(controller, ["pending-restart"]);
  await controller.dispose();
  const proof = f.proofs.find((row) => row.name === target.packageName);
  proof.host.stamp.version = proof.client.stamp.version = "3.1.0";
  const memory = f.proofs.find((row) => row.name === "@cleverc2200/dsh-personal-memory");
  memory.host = { kind: "unversioned", identity: "legacy-memory" };
  memory.client = { kind: "unverified", reason: "legacy-memory" };
  await f.initializeInstallation();
  const script = join(f.root, "gea-bootstrap-restart.mjs"),
    input = join(f.root, "gea-bootstrap.json");
  await writeFile(
    script,
    `import{createPluginUpdateController}from${JSON.stringify(pathToFileURL(modulePath).href)};import{readFile}from'node:fs/promises';const o=JSON.parse(await readFile(process.argv[2],'utf8'));const proofs=o.proofs;delete o.proofs;o.source={check:async()=>[],download:async()=>{throw Error('unused')},assertCurrentRelease:()=>{}};o.readRuntimeProofs=async id=>proofs.map(p=>({...p,client:p.client.kind==='observed'?{...p.client,binding:{...p.client.binding,hostProcessIdentity:id}}:p.client}));const c=createPluginUpdateController(o);await c.initialize();console.log(JSON.stringify(c.snapshot()));await c.dispose();`,
  );
  await writeFile(
    input,
    JSON.stringify({
      ...f.options,
      source: undefined,
      readRuntimeProofs: undefined,
      proofs: f.proofs,
    }),
  );
  const result = JSON.parse(execFileSync(process.execPath, [script, input], { encoding: "utf8" }));
  assert.equal(result.operation.stage, "completed");
  assert.equal(
    result.items.find((row) => row.packageName === memory.name).installedVersion,
    "0.1.1",
  );
});

test("an absent or disabled personal memory plugin does not block the existing suite", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  for (const mode of ["absent", "disabled"]) {
    const f = await controllerFixture(t, { memory: true });
    const memory = f.proofs.find((proof) => proof.name === "@cleverc2200/dsh-personal-memory");
    memory.host = { kind: "unverified", reason: "HOST_MODULE_NOT_ACTIVE" };
    if (mode === "absent") {
      const file = join(f.dir, "package.json"),
        manifest = JSON.parse(await readFile(file, "utf8"));
      delete manifest.dependencies[memory.name];
      await writeFile(file, JSON.stringify(manifest));
    }
    const controller = createPluginUpdateController(f.options);
    t.after(() => controller.dispose());
    await controller.initialize();
    await controller.check();
    assert.equal(controller.snapshot().items.length, 3);
    assert.ok(controller.snapshot().items.every((row) => row.state === "current"));
  }
});

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
  "unsupported candidate contents leave the running installation usable",
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
    assert.equal(operation.stage, "failed", JSON.stringify(operation));
    assert.equal((await f.installation.beginBoot()).id, "baseline");
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
  await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), {
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
  assert.equal(changed.version, "3.0.0");
  const candidate = await readPluginProfile(await f.candidateDirectory());
  assert.equal(
    candidate.packages.find((pkg) => pkg.name === accepted.packageName).version,
    "3.1.0",
  );
  assert.equal(
    controller.snapshot().items.find((row) => row.packageName === accepted.packageName)
      .runningHostVersion,
    "3.0.0",
  );
  assert.equal(
    controller.snapshot().items.find((row) => row.packageName === accepted.packageName)
      .installedVersion,
    "3.0.0",
  );
  const invocation = JSON.parse(
    (await readFile(join(f.evidence, "invocations.ndjson"), "utf8")).trim(),
  );
  assert.equal(invocation.args[0], "--fixture-prefix");
  assert.equal(invocation.marker, "launcher-provided");
  assert.notEqual(invocation.cwd, await realpath(f.dir));
  assert.match(invocation.cwd, /[/\\]staging-[^/\\]+$/);
  await assert.rejects(
    controller.submit({ packageName: row.packageName, planId: row.planId }),
    /UPDATE_OPERATION_BLOCKED/,
  );
});
test.after(() => rm(work, { recursive: true, force: true }));
test("a failed candidate package process retains its log and leaves the running version unchanged", async (t) => {
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
    "3.0.0",
  );
  await controller.check();
  assert.equal(
    controller.snapshot().items.find((item) => item.packageName === row.packageName).state,
    "available",
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
    "keep",
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
  await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), /ENOENT/);
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
  "an orphan candidate writer is stopped without blocking the verified installation",
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
    const result = await waitForStage(controller, ["failed", "pending-restart"]);
    assert.equal(result.stage, "failed", JSON.stringify(result));
    assert.equal(result.diagnostic, "PACKAGE_WRITERS_INTERRUPTED");
    assert.equal(
      JSON.parse(
        await readFile(
          join(f.dir, "node_modules/@cleverc2200/gea-dsh-prototype/package.json"),
          "utf8",
        ),
      ).version,
      "3.0.0",
    );
    await controller.dispose();
    const marker = await readFile(join(f.evidence, "late-write"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await readFile(join(f.evidence, "late-write"), "utf8"), marker);
    const reopened = createPluginUpdateController(f.options);
    await reopened.initialize();
    assert.equal(reopened.snapshot().operation.stage, "failed");
    assert.equal((await f.installation.beginBoot()).id, "baseline");
    await reopened.check();
    assert(reopened.snapshot().items.some((item) => item.planId));
    await reopened.dispose();
    assert.equal(
      (await readFile(join(f.evidence, "invocations.ndjson"), "utf8")).trim().split("\n").length,
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
      await readFile(join(f.evidence, "invocations.ndjson"));
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
  await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), { code: "ENOENT" });
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  assert.equal(controller.snapshot().operation.stage, "failed");
  assert.equal(controller.snapshot().operation.diagnostic, "PREVIOUS_OPERATION_INTERRUPTED");
  await controller.check();
  assert.equal(controller.snapshot().items[2].state, "available");
});
test("submission rejects live and malformed run records and preserves an exited writer record", async (t) => {
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
    await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), { code: "ENOENT" });
  }
  await writeFile(run, JSON.stringify({ pid: 2147483647, grouped: true }));
  await controller.check();
  const row = controller.snapshot().items.find((row) => row.planId);
  await controller.submit({ packageName: row.packageName, planId: row.planId });
  assert.equal(
    (await waitForStage(controller, ["pending-restart", "failed", "unknown"])).stage,
    "pending-restart",
  );
  assert.equal(JSON.parse(await readFile(run, "utf8")).pid, 2147483647);
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
  await f.installation.beginBoot();
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
  await mkdir(join(f.dir, ".plugin-manager"), { recursive: true });
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
  assert.equal(aliveWriter.operation.stage, "failed");
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
  assert.equal(recovered.operation.stage, "failed");
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
    "3.0.0",
  );
});
test("unreadable candidate receipts block updates while keeping the running installation usable", async (t) => {
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
      await readFile(join(f.evidence, "invocations.ndjson"));
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
  const result = await waitForStage(controller, ["failed", "pending-restart"]);
  assert.equal(result.stage, "failed", JSON.stringify(result));
  assert.equal(result.diagnostic, "UPDATE_RECEIPT_WRITE_FAILED");
  await controller.dispose();
  const reopened = createPluginUpdateController(f.options);
  await reopened.initialize();
  assert.ok(reopened.snapshot().items.every((item) => item.state === "failed"));
  await assert.rejects(
    reopened.submit({ packageName: row.packageName, planId: row.planId }),
    /UPDATE_OPERATION_BLOCKED/,
  );
  assert.equal(reopened.operationStatus().state, "failed");
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  await reopened.dispose();
});

async function bridgeControllerFixture(t, { workbenchFirst = false, managed = true } = {}) {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, {
    allUpdates: true,
    managed,
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
  const calls = (await readFile(join(f.evidence, "invocations.ndjson"), "utf8"))
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
  const f = await bridgeControllerFixture(t, { managed: false });
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
  await f.initializeInstallation();
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
  await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), {
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

test("a transient dependency registry outage retries before the installer silence limit", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const { installPnpmConsumerLayout } = await import("./fixtures/plugin-updates/pnpm-profile.mjs");
  const { downloadRegistry } = await import("./fixtures/plugin-updates/download-registry.mjs");
  const f = await controllerFixture(t, {
    managed: false,
    releaseDependencies: {
      "@cleverc2200/gea-dsh-prototype": { "fixture-network-dependency": "1.0.0" },
    },
  });
  const registry = await downloadRegistry(t, f.root, "transient");
  const { manager } = await installPnpmConsumerLayout(f, "^3.0.0");
  f.profile.packageManager.args = [manager, "--registry=" + registry.origin];
  const controller = createPluginUpdateController({ ...f.options, idleTimeoutMs: 5000 });
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  const item = controller.snapshot().items.find((item) => item.planId);
  await controller.submit({ packageName: item.packageName, planId: item.planId });
  const operation = await waitForStage(controller, ["pending-restart", "failed", "unknown"]);
  const log = await readFile(operation.logs[0], "utf8");
  assert.equal(
    operation.stage,
    "pending-restart",
    JSON.stringify({ operation, requests: registry.requests, log }),
  );
  assert(registry.requests.filter((path) => path === "/" + registry.name).length >= 3);
  assert(registry.requests.includes("/dependency.tgz"));
  assert.equal(
    (await readPluginProfile(f.dir)).packages.find((pkg) => pkg.name === item.packageName).version,
    "3.0.0",
  );
});

for (const [mode, diagnostic] of [
  ["partial", "PACKAGE_INSTALL_TIMEOUT"],
  ["unavailable", "PACKAGE_DEPENDENCY_NETWORK_FAILED"],
  ["corrupt", "PACKAGE_INSTALL_FAILED"],
]) {
  test(`dependency download ${mode} keeps the live graph and retries from a fresh candidate`, async (t) => {
    const { controllerFixture, waitForStage } =
      await import("./fixtures/plugin-updates/profile.mjs");
    const { installPnpmConsumerLayout } =
      await import("./fixtures/plugin-updates/pnpm-profile.mjs");
    const { downloadRegistry } = await import("./fixtures/plugin-updates/download-registry.mjs");
    const f = await controllerFixture(t, {
      managed: false,
      releaseDependencies: {
        "@cleverc2200/gea-dsh-prototype": { "fixture-network-dependency": "1.0.0" },
      },
    });
    const registry = await downloadRegistry(t, f.root, mode);
    const { manager } = await installPnpmConsumerLayout(f, "^3.0.0");
    f.profile.packageManager.args = [manager, "--registry=" + registry.origin];
    const files = [
      "package.json",
      "pnpm-lock.yaml",
      "cordis.patch.yml",
      "user-draft.txt",
      "credential.enc",
    ];
    await writeFile(join(f.dir, "user-draft.txt"), "keep draft\n");
    await writeFile(join(f.dir, "credential.enc"), Buffer.from([0, 255, 13, 10, 128]));
    const before = await Promise.all(files.map((name) => readFile(join(f.dir, name))));
    const controller = createPluginUpdateController({
      ...f.options,
      idleTimeoutMs: mode === "partial" ? 2000 : 5000,
    });
    t.after(() => controller.dispose());
    await controller.initialize();
    await controller.check();
    let item = controller.snapshot().items.find((item) => item.planId);
    await controller.submit({ packageName: item.packageName, planId: item.planId });
    const failed = await waitForStage(controller, ["pending-restart", "failed", "unknown"], 20000);
    const log = await readFile(failed.logs[0], "utf8");
    assert.equal(
      failed.stage,
      "failed",
      JSON.stringify({ failed, requests: registry.requests, log }),
    );
    assert.equal(failed.diagnostic, diagnostic, log);
    assert.equal(failed.logs[0], join(failed.directory, "pnpm.log"));
    assert.equal((await f.installation.store.status()).pending ?? null, null);
    assert.deepEqual(await Promise.all(files.map((name) => readFile(join(f.dir, name)))), before);
    assert(registry.requests.includes("/" + registry.name));
    if (mode !== "unavailable") assert(registry.requests.includes("/dependency.tgz"));
    registry.recover();
    await controller.check();
    item = controller.snapshot().items.find((item) => item.planId);
    assert(item, JSON.stringify(controller.snapshot()));
    await controller.submit({ packageName: item.packageName, planId: item.planId });
    const retried = await waitForStage(controller, ["pending-restart", "failed", "unknown"], 20000);
    const retryLog = await readFile(retried.logs[0], "utf8");
    assert.equal(retried.stage, "pending-restart", JSON.stringify({ retried, retryLog }));
    assert.notEqual(retried.id, failed.id);
    assert.equal(await readFile(failed.logs[0], "utf8"), log);
    const load = createRequire(
      await realpath(
        join(
          await f.candidateDirectory(),
          "node_modules/@cleverc2200/gea-dsh-prototype/package.json",
        ),
      ),
    );
    assert.equal(load(registry.name), "complete");
    assert.deepEqual(await Promise.all(files.map((name) => readFile(join(f.dir, name)))), before);
  });
}

test("plugin installation exits after Done even when the pnpm update registry never responds", async (t) => {
  const { controllerFixture, waitForStage } = await import("./fixtures/plugin-updates/profile.mjs");
  const { installPnpmConsumerLayout } = await import("./fixtures/plugin-updates/pnpm-profile.mjs");
  const { configureStalledPnpmRegistry } =
    await import("./fixtures/plugin-updates/stalled-registry.mjs");
  const f = await controllerFixture(t, { managed: false });
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
  const f = await controllerFixture(t, { managed: false });
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
    await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), {
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
    assert.ok(
      requests.every((row) => row.planId),
      JSON.stringify(controller.snapshot()),
    );
    const { Context } = await import(pathToFileURL(join(sdk, "vendor/cordis/lib/index.js")));
    const { HostConnectionService } = await import(
      pathToFileURL(join(sdk, "packages/client/connection/lib/index.js"))
    );
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    const connection = new HostConnectionService(ctx, [], {});
    const release = mountDesktopUpdateOperations(ctx, async () => controller);
    t.after(release);
    const invoke = async (payload) => {
      const response = await connection.createSharedFetchHandler("/api").fetch(
        new Request("http://localhost/api/desktop/update", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      );
      return response.json();
    };
    assert.deepEqual(
      await invoke({ action: "plugins-install", plans: requests, url: "http://evil" }),
      { ok: false, error: { code: "UPDATE_REQUEST_INVALID" } },
    );
    const started = await invoke({ action: "plugins-install", plans: requests });
    assert.equal(started.ok, true);
    const accepted = controller.snapshot().operation;
    assert.equal(started.value.operationId, accepted.id);
    assert.equal(accepted.targets.length, 3);
    assert.equal(controller.restartReady(), false);
    assert.deepEqual(controller.operationStatus(accepted.id), {
      operationId: accepted.id,
      state: "running",
    });
    const pendingDuringWrite = [];
    const stopObserving = controller.subscribe((snapshot) => {
      if (snapshot.operation?.stage === "pending-restart")
        pendingDuringWrite.push(controller.restartReady());
    });
    t.after(stopObserving);
    await assert.rejects(controller.submitBatch(requests), /UPDATE_OPERATION_BLOCKED/);
    const operation = await waitForStage(controller, ["pending-restart", "failed", "unknown"]);
    assert.equal(operation.stage, mode === "success" ? "pending-restart" : "failed");
    await until(
      () => controller.operationStatus(accepted.id),
      (status) => status.state !== "running",
    );
    assert.equal(controller.restartReady(), mode === "success");
    assert.deepEqual(await invoke({ action: "plugins-status", operationId: accepted.id }), {
      ok: true,
      value: { operationId: accepted.id, state: mode === "success" ? "ready" : "failed" },
    });

    assert.deepEqual(controller.operationStatus(operation.id), {
      operationId: operation.id,
      state: mode === "success" ? "ready" : "failed",
    });
    assert.deepEqual(controller.operationStatus("11111111-1111-4111-8111-111111111111"), {
      operationId: "11111111-1111-4111-8111-111111111111",
      state: "unknown",
    });
    if (mode === "success") {
      assert.ok(pendingDuringWrite.includes(false));
      assert.equal(pendingDuringWrite.at(-1), true);
    }
    const calls = (await readFile(join(f.evidence, "invocations.ndjson"), "utf8"))
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
        ["1.0.0", "2.0.0", "3.0.0"],
      );
      const candidate = await readPluginProfile(await f.candidateDirectory());
      assert.deepEqual(candidate.packages.map((pkg) => pkg.version).sort(), [
        "1.1.0",
        "2.1.0",
        "3.1.0",
      ]);
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
  await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), {
    code: "ENOENT",
  });
});

test("an already running current suite does not require installation readiness again", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const name = f.proofs[2].name;
  const path = join(f.dir, "node_modules", name, "package.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = "3.1.0";
  await writeFile(path, JSON.stringify(manifest));
  const profilePath = join(f.dir, "package.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  profile.dependencies[name] = "3.1.0";
  await writeFile(profilePath, JSON.stringify(profile));
  f.proofs[2].host.stamp.version = "3.1.0";
  f.proofs[2].client.stamp.version = "3.1.0";
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  f.proofs[2].host = { kind: "unverified", reason: "HOST_MODULE_PROOF_UNAVAILABLE" };
  await controller.check();
  assert.ok(
    controller
      .snapshot()
      .items.every(
        (row) => row.state === "current" && row.planId === null && row.diagnostic === null,
      ),
    JSON.stringify(controller.snapshot()),
  );
  assert.equal(controller.snapshot().operation, null);
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

test("combined updates cache the approved suite without installation, serialize against plugin updates and preserve cancellation", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { companyVersions: true, releasePeers: {} });
  const before = await readFile(join(f.dir, "package.json"));
  const original = process.env.GEA_DESKTOP_VERSION;
  process.env.GEA_DESKTOP_VERSION = "0.2.0-rc.2.20261104.1";
  t.after(() => {
    if (original === undefined) delete process.env.GEA_DESKTOP_VERSION;
    else process.env.GEA_DESKTOP_VERSION = original;
  });
  const controller = createPluginUpdateController({
    ...f.options,
    runtimeDirectory: join(f.dir, "gea/plugin-updates"),
  });
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.cancelDesktop();
  assert.equal(await controller.companyStatus(), null);
  await controller.prepareDesktop("0.2.0-rc.2.20261105.1");
  assert.deepEqual(await controller.companyStatus(), {
    phase: "prepared",
    desktopVersion: "0.2.0-rc.2.20261105.1",
  });
  assert.ok((await readFile(join(f.dir, "package.json"))).equals(before));
  await assert.rejects(controller.submitBatch([]), /UPDATE_OPERATION_BLOCKED/);
  await controller.cancelDesktop();
  await controller.cancelDesktop();
  assert.equal((await controller.companyStatus()).phase, "cancelled");
  const receiptPath = join(f.dir, "gea/plugin-updates/company-update.json");
  const receipt = JSON.parse(await readFile(receiptPath));
  const previous = JSON.stringify({ ...receipt, phase: "completed", expected: receipt.targets });
  await writeFile(receiptPath, previous);
  await controller.cancelDesktop();
  assert.equal(await readFile(receiptPath, "utf8"), previous);
});

test("a corrupt isolated update journal allows desktop unlock without accepting another update", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const runtimeDirectory = join(f.dir, "gea/plugin-updates");
  const journal = join(runtimeDirectory, "latest.json");
  await mkdir(runtimeDirectory, { recursive: true });
  await writeFile(journal, "{");
  const controller = createPluginUpdateController({ ...f.options, runtimeDirectory });
  t.after(() => controller.dispose());
  await controller.initialize();
  assert.equal(controller.operationStatus().state, "failed");
  assert.equal(await controller.companyStatus(), null);
  const run = join(f.dir, ".plugin-manager/run.json");
  await mkdir(dirname(run), { recursive: true });
  await writeFile(run, JSON.stringify({ pid: process.pid, grouped: false }));
  await assert.rejects(controller.cancelDesktop(), /UPDATE_OPERATION_BLOCKED/);
  await rm(run);
  await controller.cancelDesktop();
  await controller.cancelDesktop();
  await assert.rejects(
    controller.prepareDesktop("0.2.0-rc.2.20261124.1"),
    /UPDATE_OPERATION_BLOCKED/,
  );
  assert.equal(await readFile(journal, "utf8"), "{");
  assert.equal(await controller.companyStatus(), null);
});

async function historicalPluginReceipt(f, change = (receipt) => receipt) {
  const id = "00000000-0000-4000-8000-000000000051";
  const runtime = f.options.runtimeDirectory;
  const directory = join(runtime, "operations", id);
  const targets = f.proofs.map((proof, index) => ({
    packageName: proof.name,
    targetVersion: proof.host.stamp.version,
    targetSha256: String(index + 1).repeat(64),
    archivePath: join(runtime, "cache", index + ".tgz"),
  }));
  const completionProofs = f.proofs.map((proof) => ({
    processIdentity: "verified-previous-runtime",
    host: proof.host,
    client: {
      ...proof.client,
      binding: { ...proof.client.binding, hostProcessIdentity: "verified-previous-runtime" },
    },
  }));
  const receipt = change({
    schema: 2,
    id,
    installationId: id,
    directory,
    ...targets[0],
    targets,
    processIdentity: "previous-updater",
    stage: "completed",
    startedAt: "2026-11-24T00:00:00.000Z",
    updatedAt: "2026-11-24T00:01:00.000Z",
    logs: [],
    processes: [],
    completionProof: completionProofs[0],
    completionProofs,
    diagnostic: null,
  });
  await mkdir(directory, { recursive: true });
  await writeFile(join(runtime, "latest.json"), JSON.stringify({ id }));
  const path = join(directory, "receipt.json");
  const bytes = JSON.stringify(receipt);
  await writeFile(path, bytes);
  return { receipt, path, bytes };
}

test("the known failed managed receipt keeps its history while repeated checks read the source and live writers still block installation", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t);
  const before = await readFile(join(f.dir, "package.json"));
  const legacy = await historicalPluginReceipt(f, (receipt) => ({
    ...receipt,
    stage: "failed",
    completionProof: null,
    diagnostic: "PREVIOUS_OPERATION_INTERRUPTED",
  }));
  let sourceReads = 0;
  const controller = createPluginUpdateController({
    ...f.options,
    source: {
      ...f.source,
      check: (...args) => {
        sourceReads++;
        return f.source.check(...args);
      },
    },
  });
  t.after(() => controller.dispose());
  const initial = await controller.initialize();
  assert.equal(initial.operation?.stage, "failed");
  assert.equal(initial.operation?.completionProofs, undefined);
  assert(initial.items.every((row) => row.diagnostic === "PREVIOUS_OPERATION_INTERRUPTED"));
  for (let index = 1; index <= 2; index++) {
    const checked = await controller.check();
    assert.equal(sourceReads, index);
    assert.deepEqual(
      checked.items.map((row) => row.state),
      ["current", "current", "available"],
    );
    assert.equal(checked.operation.stage, "failed");
  }
  assert.equal(await readFile(legacy.path, "utf8"), legacy.bytes);
  assert.deepEqual(await readFile(join(f.dir, "package.json")), before);
  const run = join(f.dir, ".plugin-manager/run.json");
  await mkdir(dirname(run), { recursive: true });
  await writeFile(run, JSON.stringify({ pid: process.pid, grouped: false }));
  const row = controller.snapshot().items.find((item) => item.planId);
  await assert.rejects(
    controller.submit({ packageName: row.packageName, planId: row.planId }),
    /PROFILE_WRITER_UNCONFIRMED/,
  );
  assert.equal(controller.snapshot().operation.id, legacy.receipt.id);
  assert.equal(await readFile(legacy.path, "utf8"), legacy.bytes);
  await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), { code: "ENOENT" });
});

for (const multiple of [false, true])
  test(`a rolled back ${multiple ? "multi" : "single"} package operation remains readable by the Host`, async (t) => {
    const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
    const f = await controllerFixture(t);
    const saved = await historicalPluginReceipt(f, (receipt) => {
      if (!multiple) {
        delete receipt.targets;
        delete receipt.completionProofs;
      }
      return receipt;
    });
    await f.installation.prepare(saved.receipt.id, async () => {});
    await f.installation.beginBoot();
    assert.equal((await f.installation.rollback("GEA_TRIAL_STARTUP_TIMEOUT")).changed, true);
    await f.installation.beginBoot();
    const controller = createPluginUpdateController(f.options);
    t.after(() => controller.dispose());
    const initial = await controller.initialize();
    assert.equal(initial.operation?.stage, "failed");
    assert.equal(initial.operation?.diagnostic, "GEA_TRIAL_STARTUP_TIMEOUT");
    assert.equal(initial.operation?.completionProof, null);
    assert.equal(initial.operation?.completionProofs, undefined);
    const checked = await controller.check();
    assert.deepEqual(
      checked.items.map((row) => row.state),
      ["current", "current", "available"],
    );
  });

for (const schema of [1, 2])
  test(`valid schema ${schema} historical completions retain their proofs and allow another check`, async (t) => {
    const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
    const f = await controllerFixture(t);
    const saved = await historicalPluginReceipt(f, (receipt) => ({
      ...receipt,
      schema,
      ...(schema === 1 ? { recoveryDirectory: join(receipt.directory, "before") } : {}),
    }));
    const controller = createPluginUpdateController(f.options);
    t.after(() => controller.dispose());
    const initial = await controller.initialize();
    assert.equal(initial.operation?.stage, "completed");
    assert.deepEqual(initial.operation?.completionProofs, saved.receipt.completionProofs);
    assert.deepEqual(
      (await controller.check()).items.map((row) => row.state),
      ["current", "current", "available"],
    );
    assert.equal(await readFile(saved.path, "utf8"), saved.bytes);
  });

test("legacy failed receipt compatibility still rejects other shapes and damaged operation boundaries", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const variants = {
    "schema 1": (receipt) => ({
      ...receipt,
      schema: 1,
      recoveryDirectory: join(receipt.directory, "before"),
    }),
    unmanaged: (receipt) => ({ ...receipt, installationId: undefined }),
    "nonempty single proof": (receipt) => ({
      ...receipt,
      completionProof: receipt.completionProofs[0],
    }),
    "pending operation": (receipt) => ({ ...receipt, stage: "pending-restart" }),
    "installing operation": (receipt) => ({ ...receipt, stage: "installing" }),
    "single target": (receipt) => ({ ...receipt, targets: undefined }),
    "proof count": (receipt) => ({ ...receipt, completionProofs: [] }),
    "proof type": (receipt) => ({ ...receipt, completionProofs: {} }),
    "different id": (receipt) => ({
      ...receipt,
      id: "00000000-0000-4000-8000-000000000052",
      installationId: "00000000-0000-4000-8000-000000000052",
    }),
    "different directory": (receipt) => ({
      ...receipt,
      directory: join(dirname(receipt.directory), "other"),
    }),
    "archive outside cache": (receipt) => ({
      ...receipt,
      archivePath: "/outside/plugin.tgz",
      targets: receipt.targets.map((target, index) =>
        index ? target : { ...target, archivePath: "/outside/plugin.tgz" },
      ),
    }),
    "invalid target": (receipt) => ({
      ...receipt,
      targets: receipt.targets.map((target, index) =>
        index ? { ...target, targetSha256: "invalid" } : target,
      ),
    }),
    "invalid diagnostic": (receipt) => ({ ...receipt, diagnostic: {} }),
  };
  for (const [name, change] of Object.entries(variants))
    await t.test(name, async (t) => {
      const f = await controllerFixture(t);
      const saved = await historicalPluginReceipt(f, (receipt) =>
        change({
          ...receipt,
          stage: "failed",
          completionProof: null,
          diagnostic: "PREVIOUS_OPERATION_INTERRUPTED",
        }),
      );
      let sourceReads = 0;
      const controller = createPluginUpdateController({
        ...f.options,
        source: {
          ...f.source,
          check: async () => {
            sourceReads++;
            return [];
          },
        },
      });
      t.after(() => controller.dispose());
      const initial = await controller.initialize();
      assert.equal(initial.operation, null);
      assert(initial.items.every((row) => row.diagnostic === "UPDATE_JOURNAL_UNREADABLE"));
      await controller.check();
      assert.equal(sourceReads, 0);
      assert.equal(await readFile(saved.path, "utf8"), saved.bytes);
    });
});

test("a prepared desktop update wins the profile lock over a plugin install still downloading", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, {
    companyVersions: true,
    allUpdates: true,
    releasePeers: { "@cleverc2200/gea-dsh-prototype": {} },
  });
  const before = await readFile(join(f.dir, "package.json"));
  const original = process.env.GEA_DESKTOP_VERSION;
  process.env.GEA_DESKTOP_VERSION = "0.2.0-rc.2.20261104.1";
  t.after(() => {
    if (original === undefined) delete process.env.GEA_DESKTOP_VERSION;
    else process.env.GEA_DESKTOP_VERSION = original;
  });
  const reached = Promise.withResolvers(),
    resume = Promise.withResolvers();
  let held = false;
  const slow = createPluginUpdateController({
    ...f.options,
    runtimeDirectory: join(f.dir, "gea/plugin-updates"),
    source: {
      ...f.source,
      download: async (...args) => {
        const archive = await f.source.download(...args);
        if (!held) {
          held = true;
          reached.resolve();
          await resume.promise;
        }
        return archive;
      },
    },
  });
  const preparing = createPluginUpdateController({
    ...f.options,
    runtimeDirectory: join(f.dir, "gea/plugin-updates"),
  });
  let settled = Promise.resolve([]);
  try {
    await slow.initialize();
    await preparing.initialize();
    await slow.check();
    const plans = slow
      .snapshot()
      .items.filter((row) => row.state === "available")
      .map((row) => ({ packageName: row.packageName, planId: row.planId }));
    assert.equal(plans.length, 3);
    const pending = slow.submitBatch(plans);
    const rejected = assert.rejects(pending, /UPDATE_OPERATION_BLOCKED/);
    settled = Promise.allSettled([rejected]);
    await Promise.race([
      reached.promise,
      pending.then(() => assert.fail("plugin installation reached acceptance before the barrier")),
    ]);
    await preparing.prepareDesktop("0.2.0-rc.2.20261105.1");
    resume.resolve();
    await rejected;
    assert.equal((await preparing.companyStatus()).phase, "prepared");
    assert.ok((await readFile(join(f.dir, "package.json"))).equals(before));
    await assert.rejects(readFile(join(f.evidence, "invocations.ndjson")), { code: "ENOENT" });
  } finally {
    resume.resolve();
    await Promise.all([settled, slow.dispose(), preparing.dispose()]);
  }
});

test("a client without managed startup cannot offer an in-place company update", async (t) => {
  const { controllerFixture } = await import("./fixtures/plugin-updates/profile.mjs");
  const f = await controllerFixture(t, { managed: false });
  const controller = createPluginUpdateController(f.options);
  t.after(() => controller.dispose());
  await controller.initialize();
  await controller.check();
  assert(
    controller
      .snapshot()
      .items.every(
        (item) =>
          item.state === "blocked" &&
          item.diagnostic === "UPDATE_DESKTOP_INSTALLATION_REQUIRED" &&
          !item.planId,
      ),
  );
  assert.equal(controller.snapshot().operation, null);
});
