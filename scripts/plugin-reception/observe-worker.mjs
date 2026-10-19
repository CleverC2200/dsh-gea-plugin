import {
  artifactSetSha256,
  businessIds,
  documentIds,
  retainStandard,
  projectOrchestrationStandard,
} from "./contract.mjs";
/** In-process ordinary Web profile boot. Real Loader/resolver/services, with all outgoing transports denied. */
import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { FIBER_ACTIVE, waitForMainPlugins } from "./readiness.mjs";

const v = JSON.parse(await readFile(process.argv[2], "utf8"));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const projected = {
  at: new Date().toISOString(),
  checkpoint: "init-profile",
  success: false,
  nativeRun: false,
  outgoingAttempts: { fetch: 0, http: 0, https: 0, socket: 0 },
  modelTasks: 0,
  businessQueries: 0,
  credentialsReadOrCopied: false,
};
const checkpoint = (phase) => {
  projected.checkpoint = phase;
};
const deny = (kind) => {
  projected.outgoingAttempts[kind]++;
  throw Error("OUTGOING_TRANSPORT_DENIED");
};
globalThis.fetch = async () => deny("fetch");
http.request = http.get = () => deny("http");
https.request = https.get = () => deny("https");
net.Socket.prototype.connect = function () {
  return deny("socket");
};
syncBuiltinESMExports();
const observationDeadline = Date.now() + 100000;
const watchdog = setTimeout(() => {
  projected.failure = "RUNTIME_OBSERVATION_TIMEOUT";
  void save().then(() => process.exit(1));
}, 100000);
let ctx;
try {
  assert.equal(process.env.DSH_HOME, v.home, "EXPLICIT_HOME_NOT_EFFECTIVE");
  const owner = await readJson(join(v.home, ".three-plugin-reception.json"));
  assert.equal(owner.profile, v.profile, "PROFILE_NOT_RECEPTION_OWNED");
  projected.artifactSetSha256 = artifactSetSha256(owner.artifacts);
  const anchor = join(v.core, "apps/cli/package.json"),
    coreRequire = createRequire(anchor);
  // Installation-anchor require is only for importing the fixed Core. Profile SDK lookup is below through PluginPackages.
  const official = (name) => import(pathToFileURL(coreRequire.resolve(name)));
  const boot = await official("@deepseek-ai/dsh-app-boot");
  const { provideCmdline } = await official("@deepseek-ai/dsh-cmdline");
  const { createLaunchEnvironmentSnapshot } = await official(
    "@deepseek-ai/dsh-launch-environment",
  );
  const { load } = await official("js-yaml");
  const { entryListSchema } = await official(
    "@deepseek-ai/cordis-plugin-include",
  );
  const semver = createRequire(
    coreRequire.resolve("@deepseek-ai/dsh-app-boot"),
  )("semver");
  const profile = boot.loadProfileDirectory("reception", v.profile, anchor);
  assert.equal(profile.skippedBundles.length, 0, "PROFILE_BUNDLE_SKIPPED");
  assert.deepEqual(
    load(await readFile(join(v.profile, "cordis.patch.yml"), "utf8"), {
      schema: entryListSchema,
    }),
    [],
    "EMPTY_PROFILE_PATCH_REQUIRED",
  );
  await writeFile(join(v.profile, "cordis.yml"), "[]\n");
  const facts = {
    name: basename(v.profile),
    dir: v.profile,
    patchPath: join(v.profile, "cordis.patch.yml"),
    installAnchor: anchor,
    home: v.home,
    cwd: v.home,
    startedBundles: profile.layers.map((layer) => layer.packageName),
    overlays: [],
    telemetryDisabledEnv: "1",
  };
  checkpoint("resolution");
  const resolution = await boot.createRuntimeResolution({
    installAnchor: anchor,
    profile,
    home: v.home,
  });
  const readyListeners = [];
  checkpoint("boot");
  ctx = await boot.boot(
    "reception",
    join(v.profile, "cordis.yml"),
    boot.readProfilePatches("reception", facts, profile),
    async (host) => {
      checkpoint("boot-prepare");
      host.provide("profileContext", facts);
      host.provide(
        "launchEnvironment",
        createLaunchEnvironmentSnapshot([
          { source: "process", values: { ...process.env } },
        ]),
      );
      await host.plugin(boot.PluginPackages, { resolution });
      provideCmdline(host, {
        args: ["--no-open", "--host", "127.0.0.1", "--port", "0"],
        exit: () => {
          throw Error("UNEXPECTED_PROFILE_EXIT");
        },
        ready: {
          onReady: (listener) => {
            readyListeners.push(listener);
            return () => {};
          },
        },
      });
      checkpoint("boot-mount");
    },
  );
  checkpoint("boot-ready");
  assert.equal(ctx.fiber.state, FIBER_ACTIVE, "HOST_NOT_ACTIVE");
  assert(ctx.get("loader") !== undefined, "HOST_LOADER_MISSING");
  for (const listener of readyListeners) listener();
  await ctx.loader.await();
  await waitForMainPlugins(
    ctx.loader,
    owner.artifacts.map((row) => row.name),
    observationDeadline,
  );
  checkpoint("main-active");
  const names = owner.artifacts.map((row) => row.name);
  const entries = [...ctx.loader.entries()];
  projected.plugins = [];
  for (const name of names) {
    const found = entries.filter((entry) => entry.options.name === name);
    const state = found[0]?.fiber?.state;
    projected.plugins.push({
      name,
      mounts: found.length,
      entryId: found[0]?.options.id,
      fiberState: state,
      active: state === FIBER_ACTIVE,
    });
    assert.equal(found.length, 1, "MAIN_PLUGIN_NOT_SINGLE_MOUNT");
    assert.equal(found[0].disabled, false, "MAIN_PLUGIN_DISABLED");
    assert.equal(state, FIBER_ACTIVE, "MAIN_PLUGIN_NOT_ACTIVE");
  }
  checkpoint("public-services");
  const services = [
    "pluginPackages",
    "pluginManager",
    "clientModules",
    "agentPresets",
    "agentResources",
    "workbenchPages",
    "settings",
    "connection",
    "tools",
    "skills",
    "sessionController",
    "storageDomain",
  ];
  projected.services = services.map((name) => {
    assert(ctx.get(name) !== undefined, `PUBLIC_SERVICE_MISSING:${name}`);
    return { name, available: true };
  });
  // Public Host graph proves client entry registration and advertised artifacts, not browser execution.
  checkpoint("client-graph");
  const graph = ctx.clientModules.graph();
  projected.clients = names.map((name) => {
    const found = graph.entries.filter((entry) => entry.id === name);
    assert.equal(found.length, 1, "MAIN_CLIENT_ENTRY_NOT_SINGLE");
    const batches = graph.batches.filter((batch) =>
      batch.entries.includes(name),
    );
    assert.equal(batches.length, 1, "MAIN_CLIENT_BATCH_NOT_SINGLE");
    assert.equal(
      typeof found[0].url,
      "string",
      "MAIN_CLIENT_SCRIPT_PATH_MISSING",
    );
    assert(found[0].url.length > 0, "MAIN_CLIENT_SCRIPT_PATH_MISSING");
    assert.equal(
      typeof batches[0].url,
      "string",
      "MAIN_CLIENT_BATCH_PATH_MISSING",
    );
    assert(batches[0].url.length > 0, "MAIN_CLIENT_BATCH_PATH_MISSING");
    return {
      id: name,
      graphRegistered: true,
      scriptPath: found[0].url,
      revision: found[0].rev,
      batchPath: batches[0].url,
      batchPhase: batches[0].phase,
      browserExecuted: false,
    };
  });
  // Test actual importer routing at each installed plugin, including non-dsh SDK peers that version preflight omits.
  checkpoint("sdk");
  projected.sdk = [];
  for (const artifact of owner.artifacts) {
    const installed = join(v.profile, "node_modules", artifact.name),
      manifest = await readJson(join(installed, "package.json"));
    const exports = manifest.exports?.["."];
    const entry =
      typeof exports === "string"
        ? exports
        : (exports?.default ?? manifest.main);
    assert(entry, "PLUGIN_ROOT_EXPORT_MISSING");
    const parent = pathToFileURL(join(installed, entry)).href;
    for (const [name, range] of Object.entries(
      manifest.peerDependencies ?? {},
    )) {
      if (!name.startsWith("@deepseek-ai/")) continue;
      const actual = ctx.pluginPackages.packageOf(name, parent);
      assert(actual, `SDK_NOT_ROUTED:${name}`);
      const supplied = resolution.entries.find(
        (row) => row.name === name && row.scope === "installation",
      );
      assert(supplied, `SDK_NOT_INSTALLATION_OWNED:${name}`);
      assert.equal(
        await realpath(actual.dir),
        await realpath(supplied.packageDir),
        `SDK_SHADOWED:${name}`,
      );
      assert(
        semver.satisfies(actual.version, range, { includePrerelease: true }),
        `SDK_VERSION_MISMATCH:${name}`,
      );
      projected.sdk.push({
        plugin: artifact.name,
        name,
        version: actual.version,
        peerRange: range,
        path: await realpath(actual.dir),
        sameInstallationInstance: true,
        peerSatisfied: true,
      });
    }
  }
  checkpoint("resources");
  const handler = ctx.connection.createSharedFetchHandler("/api");
  const response = await handler.fetch(
    new Request(
      "http://localhost/api/agent-manage/resources?cwd=" +
        encodeURIComponent(v.home),
    ),
  );
  assert.equal(response.status, 200, "RESOURCE_ROUTE_FAILED");
  const resources = await response.json();
  assert(Array.isArray(resources), "RESOURCE_ROSTER_NOT_ARRAY");
  projected.resources = resources.map((row) => ({
    id: row.id,
    kind: row.kind,
    enabled: row.enabled,
    error: Boolean(row.error),
    missingSkills: row.missingSkills ?? [],
  }));
  const signal = new AbortController().signal;
  const initialRoster = await ctx.agentPresets.remoteExportList();
  projected.initialPresets = initialRoster.presets.map((row) => ({
    id: row.id,
    isDefault: row.isDefault,
    broken: Boolean(row.broken),
  }));
  for (const id of businessIds)
    assert(
      projected.initialPresets.some((row) => row.id === id && !row.broken),
      `BUSINESS_PRESET_NOT_DISCOVERABLE_BEFORE_SELECTION:${id}`,
    );
  for (const id of [
    "gea-html-inventory-customer",
    "gea-html-inventory-orderworkbench",
    "gea-html-inventory-orderfulfillment",
  ])
    assert(
      !projected.initialPresets.some((row) => row.id === id),
      `PREVIEW_PRESET_VISIBLE:${id}`,
    );
  for (const id of businessIds) {
    assert(
      resources.some(
        (row) =>
          row.id === id &&
          row.enabled &&
          !row.error &&
          !row.missingSkills?.length,
      ),
      `BUSINESS_RESOURCE_NOT_READY:${id}`,
    );
    const selected = await ctx.agentResources.select(id, signal, v.home);
    assert.equal(selected.preset, id, "BUSINESS_RESOURCE_PRESET_MISMATCH");
  }
  const skill = resources.find(
    (row) =>
      row.kind === "skill" &&
      row.enabled &&
      !row.error &&
      row.id.startsWith("skill:"),
  );
  assert(skill, "INSTALLED_INVOCABLE_SKILL_REQUIRED");
  assert.equal(
    (await ctx.agentResources.select(skill.id, signal, v.home)).preset,
    "agent-resource-skill",
    "SKILL_PRESET_MISMATCH",
  );
  const ids = documentIds;
  checkpoint("documents");
  const docs = new Map();
  for (const id of ids) {
    assert.equal(
      (await ctx.agentPresets.resolve(id)).broken,
      undefined,
      "PRESET_BROKEN",
    );
    const doc = await ctx.agentPresets.readDocument(id);
    docs.set(id, {
      content: doc.content,
      rows: load(doc.content, { schema: entryListSchema }),
    });
    assert(Array.isArray(docs.get(id).rows), "PRESET_DOCUMENT_NOT_PLUGIN_LIST");
  }
  const standard = docs.get("standard").rows;
  const manageRequire = createRequire(join(v.profile, "package.json"));
  const { composeStandardPreset, ORCHESTRATION_PRESET } = await import(
    pathToFileURL(manageRequire.resolve("dsh-agent-manage/standard-preset"))
  );
  const companyStandard = (
    await composeStandardPreset(ctx.agentPresets, ORCHESTRATION_PRESET)
  ).plugins;
  const manageRoot = dirname(
    manageRequire.resolve("dsh-agent-manage/package.json"),
  );
  let orchestrationPrompt;
  try {
    orchestrationPrompt = await readFile(
      join(manageRoot, "business-resources/orchestration/prompt.md"),
      "utf8",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const managedOrchestration = (await ctx.agentResources.pluginAgents()).find(
    (row) => row.id === ORCHESTRATION_PRESET.id,
  );
  if (managedOrchestration) {
    assert.equal(
      managedOrchestration.prompt,
      orchestrationPrompt,
      "ORCHESTRATION_SOURCE_PROMPT_DIFFERS",
    );
    assert.equal(
      managedOrchestration.customized,
      false,
      "ORCHESTRATION_FRESH_PROFILE_REQUIRED",
    );
  }
  const orchestrationStandard = projectOrchestrationStandard(companyStandard, {
    prompt: orchestrationPrompt,
    skillDirectory: join(manageRoot, "business-resources/orchestration/skills"),
    managed: Boolean(managedOrchestration),
  });
  assert.deepEqual(
    docs.get("auto-negotiation").rows,
    orchestrationStandard,
    "ORCHESTRATION_PRESET_DIFFERS_FROM_DECLARATION",
  );
  assert.deepEqual(
    docs.get("agent-resource-skill").rows,
    companyStandard,
    "GENERAL_PRESET_DIFFERS_FROM_COMPANY_STANDARD",
  );
  projected.documents = ids.map((id) => {
    const doc = docs.get(id),
      additions = [];
    const baseline =
      id === "standard"
        ? standard
        : id === "auto-negotiation"
          ? orchestrationStandard
          : companyStandard;
    retainStandard(baseline, doc.rows, id, additions);
    return {
      id,
      sha256: createHash("sha256").update(doc.content).digest("hex"),
      standardEntries: flatten(baseline).length,
      declaredEntries: flatten(doc.rows).length,
      fullStandardRetained: true,
      byteEqualStandard: doc.content === docs.get("standard").content,
      allowedPersonaPrefixExtension: additions,
    };
  });
  checkpoint("default-preset");
  const roster = await ctx.agentPresets.remoteExportList();
  projected.presets = roster.presets.map((row) => ({
    id: row.id,
    isDefault: row.isDefault,
    broken: Boolean(row.broken),
  }));
  projected.actualDefault = (await ctx.agentPresets.resolve()).id;
  // Observe the installed default; do not write a legacy selectedDefault patch to make it pass.
  assert.equal(
    projected.actualDefault,
    "auto-negotiation",
    "DEFAULT_ORCHESTRATION_NOT_EFFECTIVE",
  );
  projected.workbenchPageCount = ctx.workbenchPages.list().length;
  assert.equal(
    Object.values(projected.outgoingAttempts).reduce((a, b) => a + b, 0),
    0,
    "OUTGOING_REQUEST_ATTEMPTED",
  );
  projected.success = true;
  checkpoint("complete");
} catch (error) {
  // Only explicit leading harness codes are public; incidental enum/text fragments are not codes.
  projected.failure =
    String(error?.message ?? "").match(
      /^([A-Z][A-Z0-9_]{4,})(?=:|\n|$)/,
    )?.[1] ?? "RUNTIME_RECEPTION_FAILED";
  await privateDiagnostic("observation", error);
  process.exitCode = 1;
} finally {
  try {
    await ctx?.fiber.dispose();
  } catch (error) {
    projected.cleanupFailed = true;
    projected.success = false;
    process.exitCode = 1;
    await privateDiagnostic("cleanup", error);
  }
  clearTimeout(watchdog);
  await save();
}

async function privateDiagnostic(phase, error) {
  await writeFile(
    v.receipt + `.private.${phase}.diagnostic.log`,
    inspect(
      { checkpoint: projected.checkpoint, error },
      {
        depth: 12,
        customInspect: false,
        maxArrayLength: 1000,
        maxStringLength: null,
      },
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
async function save() {
  await writeFile(
    v.receipt + ".runtime.json",
    JSON.stringify(projected, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );
}
function flatten(rows) {
  return rows.flatMap((row) => [
    row,
    ...(row.group === true ? flatten(row.config) : []),
  ]);
}
