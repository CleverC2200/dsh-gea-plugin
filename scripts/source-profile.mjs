/** Assemble immutable plugin snapshots for the isolated DSH source profile. */
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
  rename,
  open,
  unlink,
  lstat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { composeSourcePresets } from "./source-presets.mjs";
import { corePackages, sourcePlugins } from "./source-composition.mjs";
function clientEntry(manifest) {
  const entry = manifest.exports?.["./client"];
  return typeof entry === "string"
    ? entry
    : (entry?.default ?? "client/client.js");
}

export async function prepareSourcePlugins(
  core,
  runtime,
  deployment,
  { workspace = resolve(import.meta.dirname, "../..") } = {},
) {
  const id = randomUUID();
  const snapshot = join(runtime, "source-combinations", id);
  const profile = join(runtime, "home/profiles/plugin-split-validation");
  const modules = join(snapshot, "node_modules");
  await mkdir(modules, { recursive: true });
  const packages = new Map(
    (await corePackages(core)).map(({ manifest, directory }) => [
      manifest.name,
      directory,
    ]),
  );
  const plugins = new Map();
  for (const plugin of sourcePlugins) {
    const repo = plugin.repo;
    const source = join(workspace, repo);
    const expectedCommit = plugin.commit;
    if (expectedCommit) {
      const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
        cwd: source,
        encoding: "utf8",
      }).trim();
      if (commit !== expectedCommit)
        throw Error(
          `SOURCE_PLUGIN_COMMIT_MISMATCH: ${repo} expected ${expectedCommit}, got ${commit}`,
        );
    }
    const manifest = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    const target = join(modules, manifest.name);
    await mkdir(target, { recursive: true });
    for (const file of plugin.resources) {
      try {
        await cp(join(source, file), join(target, file), { recursive: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await readFile(
      join(
        target,
        manifest.main ?? manifest.exports?.["."]?.default ?? "lib/host.js",
      ),
    );
    await readFile(join(target, clientEntry(manifest)));
    if (plugin.example && deployment?.workbenchExample === true) {
      const fixture = plugin.example;
      await readFile(join(source, fixture, "lib/host.js"));
      await cp(join(source, fixture), join(target, fixture), {
        recursive: true,
        filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
      });
    }
    plugins.set(manifest.name, {
      source,
      target,
      version: manifest.version,
      plugin,
    });
  }
  const snapshots = {};
  for (const [name, { source, target, version, plugin }] of plugins) {
    const manifest = JSON.parse(
      await readFile(join(target, "package.json"), "utf8"),
    );
    const files = [
      "package.json",
      manifest.main ?? manifest.exports?.["."]?.default ?? "lib/host.js",
      clientEntry(manifest),
      ...plugin.digests,
    ];
    const digests = {};
    for (const file of files)
      digests[file] = createHash("sha256")
        .update(await readFile(join(target, file)))
        .digest("hex");
    snapshots[name] = {
      version,
      source,
      commit: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
      dirty: execFileSync("/usr/bin/git", ["status", "--porcelain"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
      digests,
    };
  }
  await writeFile(
    join(snapshot, "company-plugins.json"),
    JSON.stringify(snapshots, null, 2),
  );
  const externalDirectories = new Set();
  for (const { source, target } of plugins.values()) {
    const dependencies = new Map(packages);
    for (const entry of await readdir(join(source, "node_modules"))) {
      if (entry.startsWith(".")) continue;
      const names = entry.startsWith("@")
        ? (await readdir(join(source, "node_modules", entry))).map(
            (name) => `${entry}/${name}`,
          )
        : [entry];
      for (const name of names) {
        if (!dependencies.has(name))
          dependencies.set(
            name,
            await realpath(join(source, "node_modules", name)),
          );
      }
    }
    for (const [name, plugin] of plugins) dependencies.set(name, plugin.target);
    for (const [name, path] of dependencies) {
      if (!path.startsWith(snapshot + "/"))
        externalDirectories.add(await realpath(path));
      const link = join(target, "node_modules", name);
      await mkdir(resolve(link, ".."), { recursive: true });
      try {
        await symlink(path, link);
      } catch (error) {
        if (
          error.code !== "EEXIST" ||
          (await realpath(link)) !== (await realpath(path))
        )
          throw error;
      }
    }
  }
  const gea = plugins.get("@cleverc2200/gea-dsh-prototype").target;
  const { deploymentPatch } = await import(
    pathToFileURL(join(gea, "scripts/deployment.mjs"))
  );
  const endpoint = "https://127.0.0.1:1";
  const patch = deploymentPatch(
    deployment ?? {
      geaBaseUrl: endpoint,
      environment: "test",
      geaEnvironments: { test: endpoint, production: endpoint },
      pageSize: 10,
      periodPageSize: 100,
      requestTimeoutMs: 1000,
      mcpRequestTimeoutMs: 1000,
      modelRequestTimeoutMs: 1000,
      maxSnapshotBytes: 100000,
      analysis: { mode: "receipt" },
    },
    gea,
    runtime,
    { bundle: true },
  ).filter((row) => row.id !== "agent-presets");
  const modelIndex = patch.findIndex((row) => row.id === "agent-default-model");
  if (modelIndex < 0) throw Error("SOURCE_MODEL_DEFAULT_MISSING");
  const [modelDefault] = patch.splice(modelIndex, 1);
  // User-selectable defaults belong to the editable profile, not a read-only CLI overlay.
  try {
    await writeFile(
      join(profile, "cordis.patch.yml"),
      JSON.stringify([modelDefault], null, 2),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  patch.push({
    id: "agent-preset-registry",
    config: { default: "auto-negotiation" },
  });
  patch.push({ id: "dsh-agent-manage", config: { sources: [] } });
  await writeFile(
    join(snapshot, "deployment.patch.json"),
    JSON.stringify(patch, null, 2),
  );
  const standard = join(
    core,
    "packages/bundle/web-app/presets/standard.patch.yml",
  );
  const business = join(gea, "presets/gea-readonly/agent.cordis.yml");
  const presetPatch = composeSourcePresets(
    { source: standard, text: await readFile(standard, "utf8") },
    { source: business, text: await readFile(business, "utf8") },
    join(gea, "lib/skill-reference.js"),
  );
  await writeFile(join(snapshot, "presets.patch.yml"), presetPatch);
  const composition = {
    id,
    dependencies: Object.fromEntries(
      [...plugins].map(([name, data]) => [name, data.version]),
    ),
    bundles: [...plugins]
      .filter(([, data]) => data.plugin.bundleOrder !== undefined)
      .sort((a, b) => a[1].plugin.bundleOrder - b[1].plugin.bundleOrder)
      .map(([name]) => name),
    patches: [
      join(snapshot, "deployment.patch.json"),
      join(snapshot, "presets.patch.yml"),
    ],
  };
  const files = await resourceDigests(snapshot);
  externalDirectories.add(join(core, "apps/web/dist"));
  const externalFiles = await dependencyDigests(externalDirectories);
  const locks = {},
    externalLockFiles = [];
  for (const [name, directory] of [
    ["core", core],
    ...[...plugins].map(([name, data]) => [name, data.source]),
  ]) {
    locks[name] = {};
    for (const file of [
      "pnpm-lock.yaml",
      "package-lock.json",
      "npm-shrinkwrap.json",
    ]) {
      try {
        locks[name][file] = await fileDigest(join(directory, file));
        externalFiles[join(directory, file)] = locks[name][file];
        externalLockFiles.push(join(directory, file));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  await writeFile(
    join(snapshot, "combination.json"),
    JSON.stringify(
      {
        composition,
        files,
        externalFiles,
        externalRoots: [...externalDirectories],
        externalLockFiles,
        locks,
        core: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
          cwd: core,
          encoding: "utf8",
        }).trim(),
        assembler: await fileDigest(new URL(import.meta.url)),
      },
      null,
      2,
    ) + "\n",
  );
  return composition;
}

const fileDigest = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

/** Hash shipped resources, excluding dependency links and their writable stores. */
async function resourceDigests(directory, prefix = "") {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = join(directory, entry.name);
    if (entry.isDirectory())
      Object.assign(files, await resourceDigests(file, relative));
    else if (entry.isSymbolicLink())
      files[relative] = "link:" + (await realpath(file));
    else if (entry.isFile() && relative !== "combination.json")
      files[relative] = await fileDigest(file);
  }
  return files;
}

/** Reject incomplete snapshots before changing the selected combination. */
export async function readSourceCombination(runtime, id, core) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("INVALID_SOURCE_COMBINATION");
  const directory = join(runtime, "source-combinations", id);
  const record = JSON.parse(
    await readFile(join(directory, "combination.json"), "utf8"),
  );
  if (record.composition.id !== id)
    throw Error("SOURCE_COMBINATION_ID_MISMATCH");
  if (
    core &&
    record.core !==
      execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
        cwd: core,
        encoding: "utf8",
      }).trim()
  )
    throw Error("SOURCE_COMBINATION_CORE_MISMATCH");
  const actual = await resourceDigests(directory);
  if (
    JSON.stringify(Object.entries(actual).sort()) !==
    JSON.stringify(Object.entries(record.files).sort())
  )
    throw Error("SOURCE_COMBINATION_DIGEST_MISMATCH");
  const external = await dependencyDigests(record.externalRoots);
  for (const file of record.externalLockFiles)
    external[file] = await fileDigest(file);
  if (
    JSON.stringify(Object.entries(external).sort()) !==
    JSON.stringify(Object.entries(record.externalFiles).sort())
  )
    throw Error("SOURCE_DEPENDENCY_DIGEST_MISMATCH");
  return record.composition;
}

/** Select a verified local combination only while its Host is stopped. */
export async function selectSourceCombination(runtime, id, core) {
  const lock = await open(join(runtime, "source-profile.lock"), "wx", 0o600);
  try {
    await readSourceCombination(runtime, id, core);
    const temporary = join(runtime, `source-selection-${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify({ id }) + "\n", { mode: 0o600 });
    await rename(temporary, join(runtime, "source-selection.json"));
  } finally {
    await lock.close();
    await unlink(join(runtime, "source-profile.lock"));
  }
}

/** Fix the resolved dependency graph, including built core files and transitive links. */
async function dependencyDigests(directories) {
  const files = {},
    visited = new Set();
  async function visit(directory) {
    const physical = await realpath(directory);
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const entry of await readdir(physical, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = join(physical, entry.name);
      if (entry.isFile()) files[file] = await fileDigest(file);
      else if (entry.isDirectory() || entry.isSymbolicLink()) {
        const resolved = await realpath(file);
        if (entry.isSymbolicLink()) files[file] = "link:" + resolved;
        if ((await lstat(resolved)).isDirectory()) await visit(resolved);
        else files[resolved] = await fileDigest(resolved);
      }
    }
  }
  for (const directory of directories) await visit(directory);
  return files;
}

/** One-time offline upgrade of the ticket08 code directory; never moves user state. */
export async function upgradeSourceProfileLayout(runtime) {
  const lock = await open(join(runtime, "source-profile.lock"), "wx", 0o600);
  try {
    const modules = join(
      runtime,
      "home/profiles/plugin-split-validation/node_modules",
    );
    const info = await lstat(modules);
    if (info.isSymbolicLink()) return;
    if (!info.isDirectory()) throw Error("INVALID_SOURCE_PROFILE_LAYOUT");
    const backup = join(runtime, "before09-modules-" + randomUUID());
    await rename(modules, backup);
    await writeFile(
      join(runtime, "source-layout-upgrade.json"),
      JSON.stringify({ backup, upgradedAt: new Date().toISOString() }) + "\n",
      { mode: 0o600 },
    );
  } finally {
    await lock.close();
    await unlink(join(runtime, "source-profile.lock"));
  }
}
