import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { parse as parseYaml } from "yaml";
import { projectPluginRelease, companyPackageNames } from "../../../src/shared/plugin-release.mjs";
import { preservedSession } from "./preserved-session.mjs";
import { refreshCompanyStartup } from "../../../desktop/company-bootstrap.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const ownFile = fileURLToPath(import.meta.url);
export async function makeArchive(
  root,
  name,
  version,
  peerDependencies = {},
  suiteUpdates = false,
) {
  const directory = join(root, name.replaceAll("/", "-"), version, "package");
  await mkdir(join(directory, "lib"), { recursive: true });
  const manifest = {
    name,
    version,
    ...(suiteUpdates ? { geaPluginUpdateStrategy: "suite" } : {}),
    type: "module",
    exports: { ".": "./lib/host.js", "./client": "./lib/client.js" },
    dsh: {
      bundle: { patch: "./cordis.patch.yml" },
      client: { platform: "web", inject: [], external: [] },
    },
    dependencies: {},
    peerDependencies,
  };
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "cordis.patch.yml"), "[]\n");
  await writeFile(
    join(directory, "lib/host.js"),
    `export const pluginPackageVersion=Object.freeze(${JSON.stringify({ name, version })});export function apply(){};\n`,
  );
  await writeFile(
    join(directory, "lib/client.js"),
    `window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:()=>({pluginPackageVersion:Object.freeze(${JSON.stringify({ name, version })}),apply(){}})});\n`,
  );
  const path = join(directory, "..", "plugin.tgz");
  execFileSync("tar", ["-czf", path, "-C", dirname(directory), "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return { path, manifest, bytes: await readFile(path) };
}
function runtimeLocation(proof, sdk) {
  const desktop = proof.kind === "desktop";
  return (name, source) =>
    desktop
      ? join(
          proof.root,
          "dsh/node_modules",
          name,
          source === "client" ? "lib/client.js" : "lib/index.js",
        )
      : join(sdk, source);
}
async function createHost(input) {
  const location = runtimeLocation(input.proof, input.sdk),
    { Context } = await import(
      pathToFileURL(location("@deepseek-ai/cordis", "vendor/cordis/lib/index.js"))
    ),
    { default: Loader } = await import(
      pathToFileURL(location("@deepseek-ai/cordis-plugin-loader", "vendor/loader/lib/index.js"))
    ),
    { PluginPackages } = await import(
      pathToFileURL(location("@deepseek-ai/dsh-app-boot", "packages/boot/app-boot/lib/index.js"))
    ),
    { default: ClientModules } = await import(
      pathToFileURL(
        location("@deepseek-ai/dsh-client-modules", "packages/client/modules/lib/index.js"),
      )
    );
  const ctx = new Context(),
    handlers = new Map();
  ctx.provide("profileContext", input.profile);
  ctx.provide("connection", {
    fetch: {
      register(route) {
        handlers.set(route.path, route.fetch);
        return () => handlers.delete(route.path);
      },
    },
  });
  await ctx.plugin(Loader, {
    baseUrl: pathToFileURL(join(input.profile.dir, "package.json")).href,
  });
  await ctx.plugin(PluginPackages);
  for (const [index, name] of companyPackageNames.entries())
    await ctx.loader.create({ id: `company-${index}`, name });
  await ctx.loader.await();
  await ctx.plugin(ClientModules);
  await writeFile(
    input.mountFile,
    `import {mountPluginUpdates} from ${JSON.stringify(pathToFileURL(input.subject).href)};export function apply(ctx){ctx.effect(()=>mountPluginUpdates(ctx,${JSON.stringify(input.config)},${JSON.stringify(input.deployment)}));}`,
  );
  await ctx.loader.create({
    id: "updates",
    name: pathToFileURL(input.mountFile).href,
  });
  await ctx.loader.await();
  async function route(action, body) {
    const handler = handlers.get(`/api/gea/plugin-updates/${action}`);
    assert.ok(handler, "actual Host route mounted: " + action);
    const response = await handler(
      new Request(`https://fixture.invalid/api/gea/plugin-updates/${action}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    const result = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  }
  return { ctx, route, Context, Loader, location };
}
async function clientObservations(input, host) {
  const registrations = [];
  const browser = vm.createContext({
    window: {
      __ModuleLoader__: { load: (entry) => registrations.push(entry) },
    },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
  });
  let ModuleSystem, parseBootManifest;
  if (input.proof.kind === "desktop") {
    vm.runInContext(
      await readFile(host.location("@deepseek-ai/dsh-client-modules", "client"), "utf8"),
      browser,
    );
    ({ ClientModuleSystem: ModuleSystem, parseBootManifest } = registrations.pop().factory(() => {
      throw Error("unexpected static dependency");
    }));
  } else {
    ({ ClientModuleSystem: ModuleSystem, parseBootManifest } = await import(
      pathToFileURL(join(input.sdk, "packages/client/modules/lib/types/client/index.js"))
    ));
  }
  for (const name of companyPackageNames)
    vm.runInContext(
      await readFile(join(input.profile.dir, "node_modules", name, "lib/client.js"), "utf8"),
      browser,
    );
  const graph = host.ctx.clientModules.graph(),
    modules = new ModuleSystem({
      manifest: parseBootManifest(graph),
      staticModules: {},
      registrationTarget: { mode: "queue", pendingQueue: registrations },
      bootstrapModule: { id: "@deepseek-ai/dsh-client-modules", exports: {} },
    });
  const client = new host.Context();
  await client.plugin(host.Loader);
  client.loader.internal = modules;
  client.provide("modules", modules);
  await modules.entries.start(client.loader, modules.manifest);
  const { readClientPluginModules } = await import(pathToFileURL(input.subject));
  const observed = readClientPluginModules(client);
  assert.equal(
    observed.length,
    3,
    JSON.stringify({
      graph,
      loadCache: [...modules.loadCache.keys()],
      entries: [...client.loader.entries()].map((entry) => ({
        name: entry.options.name,
        state: entry.fiber?.state,
      })),
      state: modules.entries.state.getSnapshot(),
      observed,
    }),
  );
  return { client, modules: observed, graph };
}
function controlledSource(input) {
  const fetchBefore = globalThis.fetch,
    objects = new Map(input.objects.map(([url, bytes]) => [url, Buffer.from(bytes, "base64")]));
  globalThis.fetch = async (url) => {
    assert.ok(objects.has(String(url)), "No unapproved network request: " + url);
    return new Response(objects.get(String(url)));
  };
  return () => {
    globalThis.fetch = fetchBefore;
  };
}
async function observeFresh(input) {
  const restoreFetch = controlledSource(input),
    host = await createHost(input);
  let client;
  try {
    const before = await host.route("status", { pageIdentity: "fresh-page" });
    if (input.startupRecovery)
      assert.deepEqual(
        before.items.map((row) => row.state),
        Array(3).fill("pending-restart"),
      );
    const observed = await clientObservations(input, host);
    client = observed.client;
    await host.route("observed", {
      hostProcessIdentity: before.hostProcessIdentity,
      pageIdentity: "fresh-page",
      nonce: before.challenge,
      modules: observed.modules,
    });
    const after = await host.route("status", { pageIdentity: "fresh-page" });
    const row = after.items.find((item) => item.packageName === companyPackageNames[2]);
    assert.equal(row.state, "completed", JSON.stringify(after));
    assert.equal(row.runningHostVersion, input.expectedVersions[2]);
    assert.equal(row.runningClientVersion, input.expectedVersions[2]);
    if (input.allUpdates) {
      assert.deepEqual(
        after.items.map((item) => item.state),
        Array(3).fill("completed"),
      );
      assert.deepEqual(
        after.items.map((item) => item.runningHostVersion),
        input.expectedVersions,
      );
      assert.deepEqual(
        after.items.map((item) => item.runningClientVersion),
        input.expectedVersions,
      );
    }
    return {
      processIdentity: after.hostProcessIdentity,
      row,
      items: after.items,
      clientModules: observed.modules,
      graph: observed.graph,
    };
  } finally {
    await client?.fiber.dispose();
    await host.ctx.fiber.dispose();
    restoreFetch();
  }
}
export async function installedScenario(
  t,
  proof,
  sdk,
  {
    customStore = false,
    allUpdates = false,
    strictSuitePeers = false,
    startupRecovery = false,
  } = {},
) {
  await mkdir(join(repository, ".runtime"), { recursive: true });
  const root = await mkdtemp(join(repository, ".runtime/actual-install-"));
  const verifySession = await preservedSession(sdk, root);
  const personalData = join(root, "agent-plugins/data");
  await mkdir(join(personalData, "user-agents.json.skills/personal/tree/references"), {
    recursive: true,
  });
  const personalFiles = {
    "user-agents.json": JSON.stringify({
      version: 1,
      agents: [
        {
          id: "personal",
          name: "My Agent",
          prompt: "Keep my custom prompt",
          enabled: true,
          skills: [
            {
              name: "personal",
              directory: {
                root: join(personalData, "user-agents.json.skills/personal/tree"),
              },
            },
          ],
        },
      ],
    }),
    "selected-resources.json": JSON.stringify({
      version: 1,
      selected: ["gea-readonly"],
      customizations: {
        "gea-readonly": { prompt: "Keep my plugin customization" },
      },
    }),
    "user-agents.json.skills/personal/tree/SKILL.md":
      "# Personal skill\nRead [rules](references/rules.md).\n",
    "user-agents.json.skills/personal/tree/references/rules.md":
      "Keep this complete reference file.\n",
  };
  for (const [name, value] of Object.entries(personalFiles))
    await writeFile(join(personalData, name), value);
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = startupRecovery ? join(root, "profiles/desktop") : join(root, "profile"),
    pnpm = join(repository, "node_modules/pnpm/bin/pnpm.cjs");
  await mkdir(dir, { recursive: true });
  const oldVersions = startupRecovery
      ? ["0.1.50", "0.6.3-company.46", "0.0.216"]
      : ["1.0.0", "2.0.0", "3.0.0"],
    old = await Promise.all(
      companyPackageNames.map((name, index) => makeArchive(root, name, oldVersions[index])),
    );
  const peers = strictSuitePeers
    ? Object.fromEntries(
        companyPackageNames.map((name, index) => [name, ["1.1.0", "2.1.0", "3.1.0"][index]]),
      )
    : {};
  const expectedVersions = startupRecovery
    ? ["0.1.53", "0.6.3-company.48", "0.0.221"]
    : ["1.1.0", "2.1.0", "3.1.0"];
  const updateVersions = startupRecovery
    ? ["0.1.51", "0.6.3-company.47", "0.0.216"]
    : expectedVersions;
  if (startupRecovery) {
    const archive = join(
      root,
      "old/company-seed/archives/cleverc2200-gea-dsh-prototype-0.0.216.tgz",
    );
    await mkdir(dirname(archive), { recursive: true });
    await writeFile(archive, old[2].bytes);
    old[2].path = archive;
  }
  const target = startupRecovery
      ? old[2]
      : await makeArchive(root, companyPackageNames[2], "3.1.0", peers, true),
    location = runtimeLocation(proof, sdk);
  const targets = allUpdates
    ? [
        await makeArchive(root, companyPackageNames[0], updateVersions[0], peers),
        await makeArchive(root, companyPackageNames[1], updateVersions[1], peers),
        target,
      ]
    : [old[0], old[1], target];
  const sdkDependencies = Object.fromEntries(
    [
      "@deepseek-ai/dsh-app-boot",
      "@deepseek-ai/cordis",
      "@deepseek-ai/dsh-plugin-manager",
      "@deepseek-ai/dsh-atomic-write",
    ].map((name) => [
      name,
      "link:" +
        dirname(
          dirname(
            location(
              name,
              {
                "@deepseek-ai/dsh-app-boot": "packages/boot/app-boot/lib/index.js",
                "@deepseek-ai/cordis": "vendor/cordis/lib/index.js",
                "@deepseek-ai/dsh-plugin-manager": "packages/boot/plugin-manager/lib/index.js",
                "@deepseek-ai/dsh-atomic-write": "packages/util/atomic-write/lib/index.js",
              }[name],
            ),
          ),
        ),
    ]),
  );
  await mkdir(join(root, "node_modules/@deepseek-ai"), { recursive: true });
  for (const [name, target] of Object.entries(sdkDependencies))
    await symlink(target.slice("link:".length), join(root, "node_modules", name), "dir");
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      private: true,
      packageManager: "pnpm@11.7.0",
      dependencies: Object.fromEntries(
        old.map((artifact) => [artifact.manifest.name, "file:" + artifact.path]),
      ),
      dsh: { profile: { bundles: [...companyPackageNames] } },
      retained: { draft: "keep", selection: "sales" },
    }),
  );
  await writeFile(
    join(dir, "pnpm-workspace.yaml"),
    "packages: []\nautoInstallPeers: false\n" + (startupRecovery ? "nodeLinker: hoisted\n" : ""),
  );
  if (startupRecovery) await writeFile(join(dir, "cordis.patch.yml"), "# User configuration\n[]\n");
  await writeFile(
    join(dir, ".npmrc"),
    "auto-install-peers=false\nstrict-peer-dependencies=false\noffline=true\n",
  );
  const initialStore = customStore ? join(root, "company offline cache", "store") : null;
  execFileSync(
    process.execPath,
    [
      pnpm,
      "install",
      "--offline",
      "--ignore-scripts",
      ...(initialStore ? ["--store-dir=" + initialStore] : []),
    ],
    {
      cwd: dir,
      stdio: "pipe",
      env: { PATH: process.env.PATH, HOME: root },
    },
  );
  const initializedStore = parseYaml(
    await readFile(join(dir, "node_modules/.modules.yaml"), "utf8"),
  ).storeDir;
  const objects = [],
    refs = [];
  for (const artifact of targets) {
    const url = `https://fixture.invalid/packages/${sha(artifact.bytes)}/plugin.tgz`;
    objects.push([url, artifact.bytes.toString("base64")]);
    const release = projectPluginRelease({
      manifest: artifact.manifest,
      artifact: {
        url,
        size: artifact.bytes.length,
        sha256: sha(artifact.bytes),
      },
      supportedCores: [{ head: proof.head, version: proof.version }],
      dataCompatibility: { kind: "preserve" },
      notes: "actual pnpm fixture",
    });
    const bytes = Buffer.from(JSON.stringify(release)),
      hash = sha(bytes),
      releaseUrl = `https://fixture.invalid/releases/${hash}/release.json`;
    objects.push([releaseUrl, bytes.toString("base64")]);
    refs.push({ name: artifact.manifest.name, url: releaseUrl, sha256: hash });
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"),
    channelUrl = "https://fixture.invalid/channels/test.json",
    payload = Buffer.from(
      JSON.stringify({
        schema: 1,
        channel: "test",
        revision: 1,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        releases: refs,
      }),
    );
  objects.push([
    channelUrl,
    Buffer.from(
      JSON.stringify({
        keyId: "fixture",
        payloadBase64: payload.toString("base64"),
        signatureBase64: sign(null, payload, privateKey).toString("base64"),
      }),
    ).toString("base64"),
  ]);
  const subject = join(root, "subject.mjs"),
    entries = join(root, "entry.ts");
  await writeFile(
    entries,
    `export { mountPluginUpdates } from ${JSON.stringify(join(repository, "src/host/plugin-updates.ts"))};export { readClientPluginModules } from ${JSON.stringify(join(repository, "src/plugin-updates-client.ts"))};`,
  );
  await build({
    entryPoints: [entries],
    outfile: subject,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "explicit-runtime",
        setup(builder) {
          const aliases = {
            "@deepseek-ai/dsh-plugin-manager/operations":
              proof.kind === "desktop"
                ? join(
                    proof.root,
                    "dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js",
                  )
                : join(sdk, "packages/boot/plugin-manager/lib/types/operations.js"),
            "@deepseek-ai/dsh-atomic-write": location(
              "@deepseek-ai/dsh-atomic-write",
              "packages/util/atomic-write/lib/index.js",
            ),
            "@deepseek-ai/dsh-app-boot": location(
              "@deepseek-ai/dsh-app-boot",
              "packages/boot/app-boot/lib/index.js",
            ),
          };
          builder.onResolve({ filter: /^@deepseek-ai\// }, (args) =>
            aliases[args.path] ? { path: aliases[args.path], external: true } : undefined,
          );
        },
      },
    ],
  });
  const input = {
    proof,
    sdk,
    subject,
    mountFile: join(root, "mount.mjs"),
    profile: {
      name: "isolated",
      dir,
      installAnchor:
        proof.kind === "desktop"
          ? join(proof.root, "dsh/node_modules/@deepseek-ai/dsh/package.json")
          : join(sdk, "apps/cli/package.json"),
      cwd: root,
      home: root,
      packageManager: {
        command: process.execPath,
        args: [pnpm],
        env: { PATH: process.env.PATH, HOME: root, npm_config_offline: "true" },
      },
    },
    config: {
      source: {
        channel: "test",
        channelUrl,
        authenticationRef: "anonymous",
        allowed: [{ origin: "https://fixture.invalid", pathPrefix: "/" }],
        trustedKeys: [
          {
            keyId: "fixture",
            publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
          },
        ],
      },
      core: proof,
      checkTimeoutMs: 120000,
      pollIntervalMs: 1000,
    },
    deployment: { runtimeDir: join(root, "runtime"), requestTimeoutMs: 120000 },
    objects,
    allUpdates,
    expectedVersions,
    startupRecovery,
  };
  if (startupRecovery) input.deployment.runtimeDir = join(dir, "gea");
  const restoreFetch = controlledSource(input),
    host = await createHost(input);
  let oldProcess, pending;
  try {
    await host.route("check", {});
    const checked = await host.route("status", { pageIdentity: "old-page" }),
      row = checked.items.find(
        (item) => item.packageName === companyPackageNames[startupRecovery ? 0 : 2],
      );
    assert.equal(row.state, "available", JSON.stringify(checked));
    oldProcess = checked.hostProcessIdentity;
    if (allUpdates) {
      assert.ok(
        checked.items.filter((item) => item.state === "available").length ===
          (startupRecovery ? 2 : 3),
        JSON.stringify(checked),
      );
      await host.route("update-all", {
        plans: checked.items
          .filter((item) => item.state === "available")
          .map(({ packageName, planId }) => ({ packageName, planId })),
      });
    } else
      await host.route("update", {
        packageName: row.packageName,
        planId: row.planId,
      });
    const deadline = Date.now() + 60000;
    do {
      pending = await host.route("status", { pageIdentity: "old-page" });
      if (
        pending.items.find((item) => item.packageName === row.packageName).state ===
          "pending-restart" ||
        ["restored", "failed", "unknown"].includes(pending.operation?.stage)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const installed = pending.items.find((item) => item.packageName === row.packageName);
    assert.equal(installed.state, "pending-restart", JSON.stringify(pending));
    assert.equal(installed.installedVersion, startupRecovery ? "0.1.51" : "3.1.0");
    assert.equal(
      parseYaml(await readFile(join(dir, "node_modules/.modules.yaml"), "utf8")).storeDir,
      initializedStore,
    );
    assert.equal(installed.runningHostVersion, startupRecovery ? "0.1.50" : "3.0.0");
  } finally {
    await host.ctx.fiber.dispose();
    restoreFetch();
  }
  let startup;
  if (startupRecovery) {
    const pointer = JSON.parse(
      await readFile(join(input.deployment.runtimeDir, "plugin-updates/latest.json")),
    );
    const operationDirectory = join(
      input.deployment.runtimeDir,
      "plugin-updates/operations",
      pointer.id,
    );
    const original = await readFile(join(operationDirectory, "receipt.json"));
    assert.equal(JSON.parse(original).targets.length, 2);
    const seed = join(root, "replacement/company-seed");
    await mkdir(join(seed, "archives"), { recursive: true });
    const gea = await makeArchive(
      root,
      companyPackageNames[2],
      expectedVersions[2],
      Object.fromEntries(
        companyPackageNames.slice(0, 2).map((name, index) => [name, expectedVersions[index]]),
      ),
      true,
    );
    const replacements = await Promise.all(
      companyPackageNames
        .slice(0, 2)
        .map((name, index) => makeArchive(root, name, expectedVersions[index])),
    );
    const packages = [];
    for (const artifact of [...replacements, gea]) {
      const file =
        artifact.manifest.name.replace(/^@/, "").replace("/", "-") +
        "-" +
        artifact.manifest.version +
        ".tgz";
      await writeFile(join(seed, "archives", file), artifact.bytes);
      packages.push({
        name: artifact.manifest.name,
        version: artifact.manifest.version,
        sha256: sha(artifact.bytes),
        file,
      });
    }
    await writeFile(join(seed, "manifest.json"), JSON.stringify({ schema: 1, packages }));
    await mkdir(join(root, "dsh"));
    await symlink(join(root, "node_modules"), join(root, "dsh/node_modules"), "dir");
    await symlink(join(repository, "node_modules/yaml"), join(root, "node_modules/yaml"), "dir");
    const support = join(root, "support");
    await mkdir(join(support, "pnpm/bin"), { recursive: true });
    await writeFile(
      join(support, "pnpm/bin/pnpm.mjs"),
      `import ${JSON.stringify(pathToFileURL(pnpm).href)};`,
    );
    startup = await refreshCompanyStartup({
      root,
      support,
      seed,
      home: root,
      manifest: { packages },
    });
    assert.equal(startup.refresh.changed, true, JSON.stringify(startup));
    assert.equal(startup.refresh.status, "pending-restart-preserved");
    const recovered = JSON.parse(await readFile(join(operationDirectory, "receipt.json")));
    assert.equal(recovered.stage, "pending-restart");
    assert.equal(recovered.completionProof, null);
    assert.equal(recovered.targets.length, 3);
    const refreshDirectory = join(root, "profiles/desktop/gea/bootstrap/gea-refresh");
    const refreshReceipt = JSON.parse(await readFile(join(refreshDirectory, "receipt.json")));
    assert.equal(dirname(refreshReceipt.backup), refreshDirectory);
    assert.equal(refreshReceipt.status, "completed");
    assert.deepEqual(
      await readFile(join(refreshReceipt.backup, "pending-update-receipt.json")),
      original,
    );
  }
  const inputFile = join(root, "input.json");
  await writeFile(inputFile, JSON.stringify(input));
  const fresh = JSON.parse(
    execFileSync(process.execPath, ["--expose-internals", ownFile, "observe", inputFile], {
      encoding: "utf8",
      timeout: 60000,
    }),
  );
  assert.notEqual(fresh.processIdentity, oldProcess);
  assert.equal(fresh.row.state, "completed");
  const pointer = JSON.parse(
    await readFile(join(input.deployment.runtimeDir, "plugin-updates/latest.json"), "utf8"),
  );
  const operation = JSON.parse(
    await readFile(
      join(input.deployment.runtimeDir, "plugin-updates/operations", pointer.id, "receipt.json"),
      "utf8",
    ),
  );
  assert.equal(operation.stage, "completed");
  await verifySession();
  assert.equal(operation.schema, 2);
  assert.equal(operation.userDataSha256, undefined);
  for (const [name, value] of Object.entries(personalFiles))
    assert.equal(await readFile(join(personalData, name), "utf8"), value);
  if (allUpdates) {
    assert.equal(operation.targets.length, 3);
    assert.equal(operation.completionProofs.length, 3);
  }
  return {
    core: { kind: proof.kind, head: proof.head, version: proof.version },
    officialRunner: {
      path:
        proof.kind === "desktop"
          ? join(
              proof.root,
              "dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js",
            )
          : join(sdk, "packages/boot/plugin-manager/lib/types/operations.js"),
      sha256: sha(
        await readFile(
          proof.kind === "desktop"
            ? join(
                proof.root,
                "dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js",
              )
            : join(sdk, "packages/boot/plugin-manager/lib/types/operations.js"),
        ),
      ),
    },
    operation,
    profileLockSha256: sha(await readFile(join(dir, "pnpm-lock.yaml"))),
    pending: pending.items.find((row) => row.packageName === companyPackageNames[2]),
    fresh,
    packageManager: {
      file: pnpm,
      version: JSON.parse(
        await readFile(join(repository, "node_modules/pnpm/package.json"), "utf8"),
      ).version,
    },
    profileRetained: JSON.parse(await readFile(join(dir, "package.json"), "utf8")).retained,
    personalAgentPreserved: true,
    pluginCustomizationPreserved: true,
    completeSkillAssetsPreserved: true,
    sessionPreserved: true,
    ...(startup ? { startup } : {}),
  };
}
if (process.argv[1] === ownFile && process.argv[2] === "observe") {
  console.log(
    JSON.stringify(await observeFresh(JSON.parse(await readFile(process.argv[3], "utf8")))),
  );
}
