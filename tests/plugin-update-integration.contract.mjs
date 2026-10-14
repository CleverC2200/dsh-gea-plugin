import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
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
test("pending restart never projects mixed Host and client versions as a running version", async (t) => {
  const { projectPluginUpdates } = await subject(t, "src/plugin-updates-client.ts");
  const items = rows("pending-restart");
  items[2].runningHostVersion = "1.2.4";
  assert.deepEqual(projectPluginUpdates(items)[name], {
    kind: "pending-restart",
    installedVersion: "1.2.3",
  });
});
test("provider aborts live check requests on disposal but leaves a submission request alive", async (t) => {
  const { createPluginUpdatesProvider } = await subject(t, "src/plugin-updates-client.ts");
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let checkSignal, updateSignal, releaseUpdate;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/status")) return Response.json({ ok: true, value: status() });
    if (url.endsWith("/check")) {
      checkSignal = options.signal;
      return new Promise((_, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
    }
    if (url.endsWith("/update")) {
      updateSignal = options.signal;
      return new Promise(
        (resolve) =>
          (releaseUpdate = () =>
            resolve(Response.json({ ok: true, value: { stage: "accepted" } }))),
      );
    }
    throw Error("unexpected request");
  };
  const ctx = new Context(),
    owner = createPluginUpdatesProvider(ctx);
  t.after(() => ctx.fiber.dispose());
  const checking = owner.provider.check([], new AbortController().signal);
  while (!checkSignal) await new Promise((resolve) => setTimeout(resolve, 1));
  const updating = owner.provider.update(name);
  while (!updateSignal) await new Promise((resolve) => setTimeout(resolve, 1));
  await owner.dispose();
  assert.equal(checkSignal.aborted, true);
  assert.equal(updateSignal.aborted, false);
  await assert.rejects(checking);
  releaseUpdate();
  await updating;
});
test("provider supplies an actual timeout AbortSignal to a stalled source check", async (t) => {
  const { createPluginUpdatesProvider } = await subject(t, "src/plugin-updates-client.ts");
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  let checkSignal;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/status")) return Response.json({ ok: true, value: status() });
    checkSignal = options.signal;
    return new Promise((_, reject) =>
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }),
    );
  };
  const ctx = new Context(),
    owner = createPluginUpdatesProvider(ctx);
  t.after(() => ctx.fiber.dispose());
  t.after(() => owner.dispose());
  const keepAlive = setTimeout(() => {}, 1500);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(owner.provider.check([], new AbortController().signal));
  assert.equal(checkSignal.aborted, true);
  assert.equal(checkSignal.reason.name, "TimeoutError");
});
test("missing or unsupported official capability does not register a provider", async (t) => {
  const { mountPluginUpdatesClient } = await subject(t, "src/plugin-updates-client.ts");
  let registrations = 0;
  for (const capability of [
    {
      version: 2,
      register() {
        registrations++;
        return () => {};
      },
    },
    { version: 1, register: null },
  ]) {
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    const release = mountPluginUpdatesClient(ctx);
    ctx.provide("pluginUpdates", capability);
    ctx.provide("modules", {
      entries: { state: { getSnapshot: () => ({ syncing: false, failures: [] }) } },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(registrations, 0);
    await release();
  }
});

test("version one capability registers once and releases provider ownership with its Fiber", async (t) => {
  const { mountPluginUpdatesClient } = await subject(t, "src/plugin-updates-client.ts");
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => Response.json({ ok: true, value: status(rows("blocked")) });
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  let registered,
    releases = 0;
  ctx.provide("pluginUpdates", {
    version: 1,
    register(provider) {
      assert.equal(registered, undefined);
      registered = provider;
      return () => releases++;
    },
  });
  ctx.provide("modules", {
    entries: { state: { getSnapshot: () => ({ syncing: true, failures: [] }) } },
  });
  const release = mountPluginUpdatesClient(ctx);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(registered.id, "gea-company-packages");
  assert.equal(registered.packages.length, 3);
  await release();
  assert.equal(releases, 1);
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
