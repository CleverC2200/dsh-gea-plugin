import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk) throw Error("GEA_PLUGIN_UPDATE_SDK required for public Loader integration");
const { Context } = await import(pathToFileURL(join(sdk, "vendor/cordis/lib/index.js")));
const { default: Loader } = await import(pathToFileURL(join(sdk, "vendor/loader/lib/index.js")));
const { PluginPackages } = await import(
  pathToFileURL(join(sdk, "packages/boot/app-boot/lib/index.js"))
);
const name = "@cleverc2200/gea-dsh-prototype";
async function subject(t, entry) {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".runtime/plugin-update-wiring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "subject.mjs");
  await build({
    entryPoints: [entry],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outfile: file,
    plugins: [
      {
        name: "fixed-public-sdk",
        setup(builder) {
          const aliases = {
            "@deepseek-ai/dsh-plugin-manager/operations":
              "packages/boot/plugin-manager/lib/types/operations.js",
            "@deepseek-ai/dsh-atomic-write": "packages/util/atomic-write/lib/index.js",
            "@deepseek-ai/dsh-app-boot": "packages/boot/app-boot/lib/index.js",
          };
          builder.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
            aliases[args.path]
              ? { path: join(sdk, aliases[args.path]), external: true }
              : undefined,
          );
        },
      },
    ],
  });
  return import(pathToFileURL(file));
}
test("Host proof reads the actual active Loader namespace and keeps its compiled version", async (t) => {
  const { readHostPluginModules } = await subject(t, "src/host/plugin-update-runtime.ts");
  const root = await mkdtemp(join(tmpdir(), "loaded-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "node_modules", name);
  await mkdir(pkg, { recursive: true });
  const manifest = { name, version: "1.2.3", type: "module", exports: "./host.js" };
  await writeFile(join(pkg, "package.json"), JSON.stringify(manifest));
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(
    join(pkg, "host.js"),
    `export const pluginPackageVersion=Object.freeze({name:${JSON.stringify(name)},version:'1.2.3'});export function apply(){}`,
  );
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(root, "package.json")).href });
  await ctx.plugin(PluginPackages);
  await ctx.loader.create({ id: "gea", name });
  await ctx.loader.await();
  let proof = (await readHostPluginModules(ctx)).find((row) => row.name === name);
  assert.equal(proof.host.kind, "active");
  assert.equal(proof.host.stamp.version, "1.2.3");
  const { validateClientObservation } = await subject(t, "src/host/plugin-updates.ts");
  const binding = {
    hostProcessIdentity: "this-host",
    pageIdentity: "this-page",
    nonce: "challenge",
    expires: Date.now() + 10000,
  };
  const report = {
    hostProcessIdentity: binding.hostProcessIdentity,
    pageIdentity: binding.pageIdentity,
    nonce: binding.nonce,
    modules: [
      {
        stamp: { name, version: "1.2.3" },
        identity: "client-entry:fiber",
        desiredArtifactRevision: "desired",
      },
    ],
  };
  const graph = { entries: [{ id: name, rev: "desired" }] };
  assert.deepEqual(validateClientObservation(report, binding, [proof], graph), report);
  for (const key of ["hostProcessIdentity", "pageIdentity", "nonce"])
    assert.throws(
      () => validateClientObservation({ ...report, [key]: "stale" }, binding, [proof], graph),
      /UPDATE_CLIENT_BINDING_INVALID/,
    );
  assert.throws(
    () => validateClientObservation(report, { ...binding, expires: 0 }, [proof], graph),
    /UPDATE_CLIENT_BINDING_INVALID/,
  );
  assert.throws(
    () =>
      validateClientObservation(report, binding, [proof], {
        entries: [{ id: name, rev: "other" }],
      }),
    /UPDATE_CLIENT_STAMP_MISMATCH/,
  );
  assert.throws(
    () =>
      validateClientObservation(
        { ...report, modules: [{ ...report.modules[0], stamp: { name, version: "1.2.4" } }] },
        binding,
        [proof],
        graph,
      ),
    /UPDATE_CLIENT_STAMP_MISMATCH/,
  );
  await writeFile(join(pkg, "package.json"), JSON.stringify({ ...manifest, version: "1.2.4" }));
  proof = (await readHostPluginModules(ctx)).find((row) => row.name === name);
  assert.equal(proof.host.stamp.version, "1.2.3");
  await ctx.loader.resolve("gea").fiber.dispose();
  const inactive = (await readHostPluginModules(ctx)).find((row) => row.name === name);
  assert.equal(inactive.host.kind, "unverified");
  assert.throws(
    () => validateClientObservation(report, binding, [inactive], graph),
    /UPDATE_CLIENT_STAMP_MISMATCH/,
  );
});

test("missing signed source and Core provenance expose blocked routes without running updates", async (t) => {
  const { mountPluginUpdates } = await subject(t, "src/host/plugin-updates.ts");
  const ctx = new Context(),
    handlers = new Map();
  t.after(() => ctx.fiber.dispose());
  ctx.provide("connection", {
    fetch: {
      register(route) {
        handlers.set(route.path, route.fetch);
        return () => handlers.delete(route.path);
      },
    },
  });
  const release = mountPluginUpdates(ctx, undefined, {
    requestTimeoutMs: 1000,
    runtimeDir: "/not-written",
  });
  t.after(release);
  const response = await handlers.get("/api/gea/plugin-updates/status")(
    new Request("https://fixture.test/api/gea/plugin-updates/status", {
      method: "POST",
      body: JSON.stringify({ pageIdentity: "fixture-page" }),
    }),
  );
  const status = await response.json();
  assert.equal(status.ok, true);
  assert.ok(status.value.items.every((row) => row.state === "blocked"));
  assert.ok(
    status.value.items.every(
      (row) => row.problem?.kind === "policy" && row.problem.code === "source-not-configured",
    ),
  );
  const rejected = await handlers.get("/api/gea/plugin-updates/update")(
    new Request("https://fixture.test/api/gea/plugin-updates/update", {
      method: "POST",
      body: JSON.stringify({ packageName: name, planId: "not-a-plan" }),
    }),
  );
  assert.equal(rejected.status, 409);
  await release();
  assert.equal(handlers.size, 0);
});

test("client observations read materialized exports rather than the newer desired graph", async (t) => {
  const { readClientPluginModules } = await subject(t, "src/plugin-updates-client.ts");
  const { ClientModuleSystem } = await import(
    pathToFileURL(join(sdk, "packages/client/modules/lib/types/client/index.js"))
  );
  const row = {
    id: name,
    url: "plugins/example?rev=first",
    initialUrl: "plugins/example?rev=first",
    rev: "first",
    inject: [],
    external: [],
  };
  const modules = new ClientModuleSystem({
    manifest: {
      rev: "first",
      modules: [row],
      plugins: [{ id: name, inject: [], immediately: false }],
    },
    staticModules: {},
    registrationTarget: {
      mode: "queue",
      pendingQueue: [
        {
          id: name,
          factory: () => ({
            pluginPackageVersion: Object.freeze({ name, version: "1.2.3" }),
            apply() {},
          }),
        },
      ],
    },
    bootstrapModule: { id: "@deepseek-ai/dsh-client-modules", exports: {} },
  });
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Loader);
  ctx.loader.internal = modules;
  ctx.provide("modules", modules);
  await modules.entries.start(ctx.loader, modules.manifest);
  assert.equal(readClientPluginModules(ctx)[0].stamp.version, "1.2.3");
  modules.manifest = { ...modules.manifest, modules: [{ ...row, rev: "new-described-revision" }] };
  assert.equal(readClientPluginModules(ctx)[0].stamp.version, "1.2.3");
  assert.equal(readClientPluginModules(ctx)[0].desiredArtifactRevision, "new-described-revision");
  await [...ctx.loader.entries()].find((entry) => entry.options.name === name).fiber.dispose();
  assert.deepEqual(readClientPluginModules(ctx), []);
});

const rows = (state = "available") =>
  ["@cleverc2200/dsh-agent-workbench", "dsh-agent-manage", name].map((packageName) => ({
    packageName,
    state,
    installedVersion: "1.2.3",
    runningHostVersion: "1.2.3",
    runningClientVersion: "1.2.3",
    candidateVersion: "1.2.4",
    planId: "11111111-1111-4111-8111-111111111111",
    diagnostic: null,
  }));
const status = (items = rows()) => ({
  revision: 1,
  items,
  hostProcessIdentity: "host-fixture",
  challenge: "nonce-fixture",
  checkTimeoutMs: 1000,
  pollIntervalMs: 1000,
});
test("wire rejects asserted active proofs and duplicate observations", async (t) => {
  const { parseUpdateClientReport } = await subject(t, "src/shared/plugin-update-wire.ts");
  const report = {
    hostProcessIdentity: "host",
    pageIdentity: "page",
    nonce: "nonce",
    modules: [
      {
        stamp: { name, version: "1.2.3" },
        identity: "entry:fiber",
        desiredArtifactRevision: "desired",
      },
    ],
  };
  assert.deepEqual(parseUpdateClientReport(report), report);
  assert.throws(() => parseUpdateClientReport({ ...report, kind: "active" }));
  assert.throws(() =>
    parseUpdateClientReport({ ...report, modules: [{ ...report.modules[0], kind: "active" }] }),
  );
  assert.throws(() =>
    parseUpdateClientReport({ ...report, modules: [report.modules[0], report.modules[0]] }),
  );
});
test("detail checks deduplicate and cancel on close while an accepted submission remains alive", async (t) => {
  const { createPluginDetailUpdates } = await subject(t, "src/plugin-updates-client.ts");
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let checkSignal,
    updateSignal,
    releaseUpdate,
    checks = 0;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/status")) return Response.json({ ok: true, value: status() });
    if (url.endsWith("/check")) {
      checks++;
      checkSignal = options.signal;
      return new Promise((_, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
    }
    if (url.endsWith("/update")) {
      updateSignal = options.signal;
      return new Promise((resolve) => {
        releaseUpdate = () => resolve(Response.json({ ok: true, value: {} }));
      });
    }
    throw Error("unexpected request");
  };
  const ctx = new Context(),
    owner = createPluginDetailUpdates(ctx);
  t.after(() => ctx.fiber.dispose());
  t.after(() => owner.dispose());
  const close = owner.retain();
  while (!owner.getSnapshot().items.length) await new Promise((resolve) => setTimeout(resolve, 1));
  const checking = owner.check();
  owner.check();
  while (!checkSignal) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(checks, 1);
  close();
  await checking;
  assert.equal(checkSignal.aborted, true);
  const closeAgain = owner.retain();
  const updating = owner.update(name);
  owner.update(name);
  while (!updateSignal) await new Promise((resolve) => setTimeout(resolve, 1));
  closeAgain();
  await owner.dispose();
  assert.equal(updateSignal.aborted, false);
  releaseUpdate();
  await updating;
});

test("explicit Core deployment input is cross-checked against Git, launcher, SDK resolution and artifact bytes", async (t) => {
  const { readPluginUpdateCore } = await subject(t, "src/host/plugin-update-core.ts");
  const root = await mkdtemp(join(tmpdir(), "admitted-core-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packages = new Map(),
    artifacts = [];
  for (const [name, local] of [
    ["@deepseek-ai/dsh", "apps/cli"],
    ["@deepseek-ai/dsh-app-boot", "packages/boot/app-boot"],
    ["@deepseek-ai/cordis", "vendor/cordis"],
    ["@deepseek-ai/dsh-plugin-manager", "packages/boot/plugin-manager"],
    ["@deepseek-ai/dsh-atomic-write", "packages/util/atomic-write"],
  ]) {
    const dir = join(root, local),
      manifest = { name, version: "1.0.0-fixture", exports: "./index.js" };
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
    await writeFile(join(dir, "index.js"), "export const fixture=true;");
    if (name === "@deepseek-ai/dsh-plugin-manager") {
      manifest.exports = { ".": "./index.js", "./operations": { default: "./operations.js" } };
      await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
      await writeFile(join(dir, "operations.js"), "export const operationsFixture=true;");
      artifacts.push({
        path: local + "/operations.js",
        sha256: createHash("sha256")
          .update(await readFile(join(dir, "operations.js")))
          .digest("hex"),
      });
    }
    artifacts.push({
      path: local + "/index.js",
      sha256: createHash("sha256")
        .update(await readFile(join(dir, "index.js")))
        .digest("hex"),
    });
    packages.set(name, { dir, manifest });
  }
  await writeFile(join(root, ".gitignore"), "**/operations.js\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Only the external public package metadata resolver is supplied by this fixture; no runtime claim is made for these files.
  const ctx = {
    profileContext: { installAnchor: join(root, "apps/cli/package.json") },
    fiber: { entry: { parent: { tree: { ctx: { baseUrl: "fixture" } } } } },
    get: () => ({ packageOf: (name) => packages.get(name) }),
  };
  const proof = { root, head, version: "1.0.0-fixture", artifacts };
  assert.equal(
    (await readPluginUpdateCore(ctx, proof)).sdk["@deepseek-ai/cordis"],
    "1.0.0-fixture",
  );
  await assert.rejects(
    readPluginUpdateCore(ctx, { ...proof, head: "0".repeat(40) }),
    /UPDATE_CORE_SOURCE_MISMATCH/,
  );
  await assert.rejects(
    readPluginUpdateCore(ctx, {
      ...proof,
      artifacts: [{ ...artifacts[0], sha256: "0".repeat(64) }, ...artifacts.slice(1)],
    }),
    /UPDATE_CORE_ARTIFACT_CHANGED/,
  );
  await assert.rejects(
    readPluginUpdateCore(ctx, { ...proof, version: "2.0.0" }),
    /UPDATE_CORE_VERSION_MISMATCH/,
  );
  const operations = artifacts.find((row) => row.path.endsWith("/operations.js"));
  const operationsPath = join(root, operations.path),
    originalBytes = await readFile(operationsPath);
  await writeFile(operationsPath, "export const operationsFixture='drifted';");
  await assert.rejects(readPluginUpdateCore(ctx, proof), /UPDATE_CORE_ARTIFACT_CHANGED/);
  await writeFile(operationsPath, originalBytes);
  await assert.rejects(
    readPluginUpdateCore(ctx, {
      ...proof,
      artifacts: artifacts.filter((row) => row !== operations),
    }),
    /UPDATE_CORE_ARTIFACT_INCOMPLETE/,
  );
  await assert.rejects(
    readPluginUpdateCore(ctx, {
      ...proof,
      artifacts: artifacts.map((row) =>
        row === operations ? { ...row, sha256: "0".repeat(64) } : row,
      ),
    }),
    /UPDATE_CORE_ARTIFACT_CHANGED/,
  );
  packages.get("@deepseek-ai/cordis").dir = tmpdir();
  await assert.rejects(readPluginUpdateCore(ctx, proof), /UPDATE_CORE_RESOLUTION_MISMATCH/);
});

async function desktopCoreFixture(t) {
  const { readPluginUpdateCore } = await subject(t, "src/host/plugin-update-core.ts");
  const root = await mkdtemp(join(tmpdir(), "desktop-core-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const head = "5e9e301dd9dc8923b2762f76dacfc5751f6ca851";
  const version = "0.2.0-rc.2";
  const packages = new Map();
  const artifacts = [];
  const put = async (path, bytes) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
    artifacts.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  const app = {
    name: "@deepseek-ai/dsh-desktop",
    version,
    dshBuildCommit: head,
    dshBuildDirty: false,
    main: "lib/main.js",
  };
  await put("package.json", JSON.stringify(app));
  await put("lib/main.js", "export const desktop=true;");
  for (const name of [
    "dsh",
    "dsh-desktop-host",
    "dsh-app-boot",
    "cordis",
    "dsh-plugin-manager",
    "dsh-atomic-write",
  ]) {
    const fullName = "@deepseek-ai/" + name;
    const local = "dsh/node_modules/" + fullName;
    const manifest = {
      name: fullName,
      version: name === "cordis" ? "4.0.4" : version,
      exports: "./lib/index.js",
    };
    if (name === "dsh-plugin-manager")
      manifest.exports = {
        ".": "./lib/index.js",
        "./operations": { default: "./lib/types/operations.js" },
      };
    await put(local + "/package.json", JSON.stringify(manifest));
    await put(local + "/lib/index.js", "export const packageFixture=true;");
    if (name === "dsh-plugin-manager")
      await put(local + "/lib/types/operations.js", "export const operationFixture=true;");
    packages.set(fullName, { dir: join(root, local), manifest });
  }
  const runtime = {
    name: "@deepseek-ai/dsh-desktop-runtime",
    version,
    dependencies: Object.fromEntries(
      [...packages].map(([name, pkg]) => [name, pkg.manifest.version]),
    ),
  };
  await put("dsh/package.json", JSON.stringify(runtime));
  const ctx = {
    profileContext: {
      installAnchor: join(root, "dsh/node_modules/@deepseek-ai/dsh/package.json"),
    },
    fiber: {
      entry: {
        parent: {
          tree: {
            ctx: {
              baseUrl: pathToFileURL(join(root, "dsh/package.json")).href,
            },
          },
        },
      },
    },
    get: () => ({ packageOf: (name) => packages.get(name) }),
  };
  return {
    readPluginUpdateCore,
    root,
    app,
    runtime,
    packages,
    ctx,
    proof: { kind: "desktop", root, head, version, artifacts },
  };
}

test("explicit desktop Core proof accepts the real installation layout without Git", async (t) => {
  const f = await desktopCoreFixture(t);
  const core = await f.readPluginUpdateCore(f.ctx, f.proof);
  assert.deepEqual(core, {
    head: f.proof.head,
    version: "0.2.0-rc.2",
    sdk: Object.fromEntries([...f.packages].map(([name, pkg]) => [name, pkg.manifest.version])),
  });
});

test("desktop Core proof requires the runtime to declare its complete critical SDK", async (t) => {
  const f = await desktopCoreFixture(t);
  delete f.runtime.dependencies["@deepseek-ai/cordis"];
  const bytes = JSON.stringify(f.runtime);
  await writeFile(join(f.root, "dsh/package.json"), bytes);
  f.proof.artifacts.find((row) => row.path === "dsh/package.json").sha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  await assert.rejects(f.readPluginUpdateCore(f.ctx, f.proof), /UPDATE_CORE_SDK_MISMATCH/);
});

test("desktop Core proof rejects a same-version SDK resolved outside its runtime", async (t) => {
  const f = await desktopCoreFixture(t);
  const pkg = f.packages.get("@deepseek-ai/cordis");
  pkg.dir = join(f.root, "dsh/other/cordis");
  await mkdir(join(pkg.dir, "lib"), { recursive: true });
  for (const [file, bytes] of [
    ["package.json", JSON.stringify(pkg.manifest)],
    ["lib/index.js", "export const packageFixture=true;"],
  ]) {
    await writeFile(join(pkg.dir, file), bytes);
    f.proof.artifacts.push({
      path: "dsh/other/cordis/" + file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await assert.rejects(f.readPluginUpdateCore(f.ctx, f.proof), /UPDATE_CORE_RESOLUTION_MISMATCH/);
});

test("desktop Core proof rejects an SDK whose exports hide its required entry", async (t) => {
  const f = await desktopCoreFixture(t);
  const pkg = f.packages.get("@deepseek-ai/cordis");
  pkg.manifest.exports = { "./package.json": "./package.json" };
  pkg.manifest.main = "./lib/index.js";
  const bytes = JSON.stringify(pkg.manifest),
    path = "dsh/node_modules/@deepseek-ai/cordis/package.json";
  await writeFile(join(f.root, path), bytes);
  f.proof.artifacts.find((row) => row.path === path).sha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  await assert.rejects(f.readPluginUpdateCore(f.ctx, f.proof), /UPDATE_CORE_ARTIFACT_INCOMPLETE/);
});

test("desktop Core proof hashes the Node import target rather than an unused default", async (t) => {
  const f = await desktopCoreFixture(t);
  const pkg = f.packages.get("@deepseek-ai/cordis");
  pkg.manifest.exports = {
    ".": { import: "./lib/import.js", default: "./lib/index.js" },
  };
  await writeFile(join(pkg.dir, "lib/import.js"), "export const importEntry=true;");
  const bytes = JSON.stringify(pkg.manifest),
    path = "dsh/node_modules/@deepseek-ai/cordis/package.json";
  await writeFile(join(f.root, path), bytes);
  f.proof.artifacts.find((row) => row.path === path).sha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  await assert.rejects(f.readPluginUpdateCore(f.ctx, f.proof), /UPDATE_CORE_ARTIFACT_INCOMPLETE/);
});

test("desktop Core proof rejects mismatched identity, installation, bytes and incomplete admission", async (t) => {
  const cases = [
    [
      "commit differs from App build",
      (f) => {
        f.proof.head = "0".repeat(40);
      },
      /UPDATE_CORE_SOURCE_MISMATCH/,
    ],
    [
      "version differs from launcher",
      (f) => {
        f.proof.version = "2.0.0";
      },
      /UPDATE_CORE_VERSION_MISMATCH/,
    ],
    [
      "dirty App build",
      async (f) => {
        f.app.dshBuildDirty = true;
        await writeFile(join(f.root, "package.json"), JSON.stringify(f.app));
      },
      /UPDATE_CORE_SOURCE_MISMATCH/,
    ],
    [
      "missing clean build flag",
      async (f) => {
        delete f.app.dshBuildDirty;
        await writeFile(join(f.root, "package.json"), JSON.stringify(f.app));
      },
      /UPDATE_CORE_SOURCE_MISMATCH/,
    ],
    [
      "wrong runtime identity",
      async (f) => {
        f.runtime.name = "@deepseek-ai/dsh";
        await writeFile(join(f.root, "dsh/package.json"), JSON.stringify(f.runtime));
      },
      /UPDATE_CORE_VERSION_MISMATCH/,
    ],
    [
      "wrong runtime version",
      async (f) => {
        f.runtime.version = "2.0.0";
        await writeFile(join(f.root, "dsh/package.json"), JSON.stringify(f.runtime));
      },
      /UPDATE_CORE_VERSION_MISMATCH/,
    ],
    [
      "different installation anchor inside App",
      async (f) => {
        await writeFile(
          join(f.root, "dsh/other-anchor.json"),
          JSON.stringify({
            name: "@deepseek-ai/dsh",
            version: f.proof.version,
          }),
        );
        f.ctx.profileContext.installAnchor = join(f.root, "dsh/other-anchor.json");
      },
      /UPDATE_CORE_INSTALLATION_MISMATCH/,
    ],
    [
      "unapproved App entry bytes",
      async (f) => {
        await writeFile(join(f.root, "lib/main.js"), "export const changed=true;");
      },
      /UPDATE_CORE_ARTIFACT_CHANGED/,
    ],
    [
      "unapproved operations bytes",
      async (f) => {
        await writeFile(
          join(f.root, "dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js"),
          "export const changed=true;",
        );
      },
      /UPDATE_CORE_ARTIFACT_CHANGED/,
    ],
    [
      "absent operations hash",
      (f) => {
        f.proof.artifacts = f.proof.artifacts.filter((row) => !row.path.endsWith("/operations.js"));
      },
      /UPDATE_CORE_ARTIFACT_INCOMPLETE/,
    ],
    [
      "absent App metadata hash",
      (f) => {
        f.proof.artifacts = f.proof.artifacts.filter((row) => row.path !== "package.json");
      },
      /UPDATE_CORE_ARTIFACT_INCOMPLETE/,
    ],
    [
      "absent SDK manifest hash",
      (f) => {
        f.proof.artifacts = f.proof.artifacts.filter(
          (row) => row.path !== "dsh/node_modules/@deepseek-ai/cordis/package.json",
        );
      },
      /UPDATE_CORE_ARTIFACT_INCOMPLETE/,
    ],
    [
      "missing actual SDK resolution",
      (f) => {
        f.packages.delete("@deepseek-ai/cordis");
      },
      /UPDATE_CORE_RESOLUTION_MISMATCH/,
    ],
    [
      "cached SDK version differs from disk",
      (f) => {
        f.packages.get("@deepseek-ai/cordis").manifest.version = "4.0.5";
      },
      /UPDATE_CORE_SDK_MISMATCH/,
    ],
    [
      "cached SDK exports differ from disk",
      (f) => {
        f.packages.get("@deepseek-ai/cordis").manifest.exports = "./lib/other.js";
      },
      /UPDATE_CORE_SDK_MISMATCH/,
    ],
    [
      "empty explicit hashes",
      (f) => {
        f.proof.artifacts = [];
      },
      /UPDATE_CORE_PROVENANCE_REQUIRED/,
    ],
    [
      "unknown proof kind",
      (f) => {
        f.proof.kind = "copied-desktop";
      },
      /UPDATE_CORE_PROVENANCE_REQUIRED/,
    ],
    [
      "no explicit desktop lane",
      (f) => {
        delete f.proof.kind;
      },
      /Command failed|not a git repository/,
    ],
  ];
  for (const [label, change, expected] of cases)
    await t.test(label, async (t) => {
      const f = await desktopCoreFixture(t);
      await change(f);
      await assert.rejects(f.readPluginUpdateCore(f.ctx, f.proof), expected);
    });
});

test("desktop Core proof rejects an SDK manifest linked outside the admitted installation", async (t) => {
  const f = await desktopCoreFixture(t);
  const outside = await mkdtemp(join(tmpdir(), "outside-core-sdk-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(
    join(outside, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/extra-sdk", version: "1.0.0" }),
  );
  await symlink(outside, join(f.root, "dsh/node_modules/@deepseek-ai/extra-sdk"));
  f.runtime.dependencies["@deepseek-ai/extra-sdk"] = "1.0.0";
  const bytes = JSON.stringify(f.runtime);
  await writeFile(join(f.root, "dsh/package.json"), bytes);
  f.proof.artifacts.find((row) => row.path === "dsh/package.json").sha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  await assert.rejects(f.readPluginUpdateCore(f.ctx, f.proof), /UPDATE_CORE_SDK_MISMATCH/);
});

test("dated Desktop builds retain the actual Core runtime version and artifact proof", async (t) => {
  const f = await desktopCoreFixture(t);
  f.app.version = "0.2.0-rc.2.20261018.1";
  const bytes = JSON.stringify(f.app);
  await writeFile(join(f.root, "package.json"), bytes);
  f.proof.artifacts.find((row) => row.path === "package.json").sha256 = createHash("sha256")
    .update(bytes)
    .digest("hex");
  assert.equal((await f.readPluginUpdateCore(f.ctx, f.proof)).version, f.runtime.version);
  f.runtime.version = "0.2.1";
  await writeFile(join(f.root, "dsh/package.json"), JSON.stringify(f.runtime));
  await assert.rejects(f.readPluginUpdateCore(f.ctx, f.proof), /UPDATE_CORE_VERSION_MISMATCH/);
});
