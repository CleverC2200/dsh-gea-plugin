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
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

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
  {
    workspace = resolve(import.meta.dirname, "../.."),
    sources,
    id = randomUUID(),
  } = {},
) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("INVALID_SOURCE_COMBINATION");
  const snapshot = join(runtime, "source-combinations", id);
  const modules = join(snapshot, "node_modules");
  const supported = JSON.parse(
    await readFile(new URL("./current-core.json", import.meta.url), "utf8"),
  );
  const coreCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: core,
    encoding: "utf8",
  }).trim();
  if (
    coreCommit !== supported.adaptation ||
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: core,
      encoding: "utf8",
    }).trim()
  )
    throw Error("FIXED_OFFICIAL_INPUT_REQUIRED");
  const entries =
    sources ??
    sourcePlugins.map((plugin) => ({
      repo: plugin.repo,
      source: join(workspace, plugin.repo),
    }));
  if (
    !Array.isArray(entries) ||
    entries.length !== sourcePlugins.length ||
    new Set(entries.map((entry) => entry.repo)).size !== entries.length ||
    entries.some(
      (entry) => !sourcePlugins.some((plugin) => plugin.repo === entry.repo),
    )
  )
    throw Error("INVALID_SOURCE_PLUGIN_SET");
  await mkdir(join(runtime, "source-combinations"), { recursive: true });
  await mkdir(snapshot, { recursive: false });
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
    const input = entries.find((entry) => entry.repo === repo);
    const source = await realpath(input.source);
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    if (
      execFileSync("git", ["status", "--porcelain"], {
        cwd: source,
        encoding: "utf8",
      }).trim()
    )
      throw Error("SOURCE_PLUGIN_DIRTY: " + repo);
    if (input.integration) {
      const integration = await realpath(input.integration);
      if (
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: integration,
          encoding: "utf8",
        }).trim() !== commit ||
        execFileSync("git", ["status", "--porcelain"], {
          cwd: integration,
          encoding: "utf8",
        }).trim()
      )
        throw Error("SOURCE_PLUGIN_UNMERGED: " + repo);
    }
    const expectedCommit = input.commit;
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
    const assetRoot = input.assets ? await realpath(input.assets) : source;
    if (input.assets) {
      if (!input.files)
        throw Error("SOURCE_ASSET_PROVENANCE_REQUIRED: " + repo);
      const actual = await resourceDigests(assetRoot, "", true);
      if (
        JSON.stringify(Object.entries(actual).sort()) !==
        JSON.stringify(Object.entries(input.files).sort())
      )
        throw Error("SOURCE_ASSET_DIGEST_MISMATCH: " + repo);
    }
    const target = join(modules, manifest.name);
    await mkdir(target, { recursive: true });
    for (const file of plugin.resources) {
      try {
        await cp(join(assetRoot, file), join(target, file), {
          recursive: true,
          filter: (path) =>
            !relative(assetRoot, path).split(/[\\/]/).includes("node_modules"),
        });
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
    plugins.set(manifest.name, {
      source,
      assetRoot,
      dependencyRoot: await realpath(
        input.dependencies ?? join(source, "node_modules"),
      ),
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
      origin: execFileSync("/usr/bin/git", ["remote", "get-url", "source"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
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
  for (const { dependencyRoot, target } of plugins.values()) {
    const dependencies = new Map(packages);
    for (const entry of await readdir(dependencyRoot)) {
      if (entry.startsWith(".")) continue;
      const names = entry.startsWith("@")
        ? (await readdir(join(dependencyRoot, entry))).map(
            (name) => `${entry}/${name}`,
          )
        : [entry];
      for (const name of names) {
        if (!dependencies.has(name) && !plugins.has(name))
          dependencies.set(name, await realpath(join(dependencyRoot, name)));
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
  // The verified snapshot carries a seed; only the actual stopped-profile launcher
  // may adopt it, without overwriting an existing user-selected default.
  await writeFile(
    join(snapshot, "profile-defaults.json"),
    JSON.stringify([modelDefault], null, 2),
    { mode: 0o600 },
  );
  patch.push({
    id: "agent-preset-registry",
    config: { default: "standard" },
  });
  patch.push({ id: "dsh-agent-manage", config: { sources: [] } });
  await writeFile(
    join(snapshot, "deployment.patch.json"),
    JSON.stringify(patch, null, 2),
  );
  const composition = {
    id,
    dependencies: Object.fromEntries(
      [...plugins].map(([name, data]) => [name, data.version]),
    ),
    bundles: [...plugins]
      .filter(([, data]) => data.plugin.bundleOrder !== undefined)
      .sort((a, b) => a[1].plugin.bundleOrder - b[1].plugin.bundleOrder)
      .map(([name]) => name),
    patches: [join(snapshot, "deployment.patch.json")],
    profileDefaults: join(snapshot, "profile-defaults.json"),
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
        compatibility: Object.fromEntries(
          [...plugins.keys()].map((name) => [
            name,
            {
              core: [
                execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
                  cwd: core,
                  encoding: "utf8",
                }).trim(),
              ],
              interface: "current-unified-v2",
              workbench: [
                composition.dependencies["@cleverc2200/dsh-agent-workbench"],
              ],
            },
          ]),
        ),
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
async function resourceDigests(
  directory,
  prefix = "",
  excludeDependencies = false,
) {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludeDependencies && entry.name === "node_modules") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = join(directory, entry.name);
    if (entry.isDirectory())
      Object.assign(
        files,
        await resourceDigests(file, relative, excludeDependencies),
      );
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
  if (
    !record.composition.dependencies ||
    typeof record.composition.dependencies !== "object" ||
    Array.isArray(record.composition.dependencies)
  )
    throw Error("INVALID_SOURCE_DEPENDENCIES");
  if (Object.keys(record.composition.dependencies).length) {
    const plugins = JSON.parse(
      await readFile(join(directory, "company-plugins.json"), "utf8"),
    );
    for (const [name, version] of Object.entries(
      record.composition.dependencies,
    )) {
      if (
        !/^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
          name,
        ) ||
        typeof version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
      )
        throw Error("INVALID_SOURCE_COMPONENT");
      const manifest = JSON.parse(
        await readFile(
          join(directory, "node_modules", name, "package.json"),
          "utf8",
        ),
      );
      if (
        manifest.name !== name ||
        manifest.version !== version ||
        plugins[name]?.version !== version
      )
        throw Error("SOURCE_COMPONENT_VERSION_MISMATCH");
    }
  }
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
export async function selectSourceCombination(
  runtime,
  id,
  core,
  { expected } = {},
) {
  expected = expected && structuredClone(expected);
  const lock = await open(join(runtime, "source-profile.lock"), "wx", 0o600);
  try {
    let current;
    try {
      current = JSON.parse(
        await readFile(join(runtime, "source-selection.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (expected) {
      // Bind the previous choice, even when its dependencies are the reason for rebuilding.
      // The target below must independently pass the complete artifact/dependency gate.
      if (
        current?.id !== expected.id ||
        current?.manifestSha256 !== expected.manifestSha256
      )
        throw Error("STALE_SOURCE_RECOVERY");
      if (
        (await fileDigest(
          join(runtime, "source-combinations", current.id, "combination.json"),
        )) !== expected.manifestSha256
      )
        throw Error("STALE_SOURCE_RECOVERY");
    }
    await readSourceCombination(runtime, id, core);
    const temporary = join(runtime, `source-selection-${randomUUID()}.json`);
    await writeFile(
      temporary,
      JSON.stringify({
        id,
        manifestSha256: await fileDigest(
          join(runtime, "source-combinations", id, "combination.json"),
        ),
        ...(current?.releaseHistory
          ? { releaseHistory: current.releaseHistory }
          : {}),
      }) + "\n",
      { mode: 0o600 },
    );
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

/** A component's shipped files and declared source form its update identity. */
export function sourceComponent(record, plugins, name) {
  const prefix = `node_modules/${name}/`;
  const files = Object.entries(record.files)
    .filter(
      ([file]) =>
        file.startsWith(prefix) &&
        !file.slice(prefix.length).startsWith("node_modules/"),
    )
    .map(([file, hash]) => [file.slice(prefix.length), hash])
    .sort();
  const source = plugins[name];
  if (!source || !files.length) throw Error("SOURCE_COMPONENT_MISSING");
  if (typeof source.origin !== "string" || !source.origin)
    throw Error("SOURCE_ORIGIN_REQUIRED");
  const origin = source.origin;
  return {
    version: record.composition.dependencies[name],
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    source: { origin, commit: source.commit },
    core: record.core,
  };
}

/** Assemble selected component artifacts without replacing the latest unrelated components. */
export async function mergeSourceComponents(
  runtime,
  latest,
  updates,
  core,
  { expectedManifests } = {},
) {
  const records = new Map(),
    metadata = new Map();
  for (const id of new Set([latest, ...Object.values(updates)])) {
    const directory = join(runtime, "source-combinations", id);
    const bytes = await readFile(join(directory, "combination.json"));
    if (
      expectedManifests &&
      createHash("sha256").update(bytes).digest("hex") !== expectedManifests[id]
    )
      throw Error("SOURCE_ARTIFACT_MANIFEST_MISMATCH");
    const record = JSON.parse(bytes);
    await readSourceCombination(runtime, id, core);
    const pluginBytes = await readFile(join(directory, "company-plugins.json"));
    if (
      createHash("sha256").update(pluginBytes).digest("hex") !==
      record.files["company-plugins.json"]
    )
      throw Error("SOURCE_COMBINATION_DIGEST_MISMATCH");
    records.set(id, record);
    metadata.set(id, JSON.parse(pluginBytes));
  }
  const expectedExternal = {};
  for (const record of records.values()) {
    for (const [file, expected] of Object.entries(record.externalFiles)) {
      if (
        expectedExternal[file] !== undefined &&
        expectedExternal[file] !== expected
      )
        throw Error("SOURCE_DEPENDENCY_BASELINE_CONFLICT");
      expectedExternal[file] = expected;
    }
  }
  const original = records.get(latest);
  const id = randomUUID(),
    directory = join(runtime, "source-combinations", id),
    modules = join(directory, "node_modules");
  await mkdir(modules, { recursive: true });
  const plugins = {},
    dependencies = {},
    externalRoots = new Set(),
    externalLockFiles = new Set(),
    locks = { core: original.locks.core };
  const names = Object.keys(original.composition.dependencies);
  for (const name of names) {
    const selected = updates[name] ?? latest;
    const record = records.get(selected);
    const source = join(
        runtime,
        "source-combinations",
        selected,
        "node_modules",
        name,
      ),
      target = join(modules, name);
    await cp(source, target, {
      recursive: true,
      filter: (file) =>
        !file.slice(source.length).split(/[\\/]/).includes("node_modules"),
    });
    dependencies[name] = record.composition.dependencies[name];
    plugins[name] = metadata.get(selected)[name];
    locks[name] = record.locks[name];
    for (const file of record.externalLockFiles)
      if (file.startsWith(plugins[name].source + "/"))
        externalLockFiles.add(file);
    const nodeModules = join(source, "node_modules");
    const packages = [];
    for (const entry of await readdir(nodeModules)) {
      if (entry.startsWith(".")) continue;
      if (entry.startsWith("@"))
        for (const child of await readdir(join(nodeModules, entry)))
          packages.push(`${entry}/${child}`);
      else packages.push(entry);
    }
    for (const dependency of packages) {
      const location = names.includes(dependency)
        ? join(modules, dependency)
        : await realpath(join(nodeModules, dependency));
      if (!names.includes(dependency)) {
        if (
          record.files[`node_modules/${name}/node_modules/${dependency}`] !==
          "link:" + location
        )
          throw Error("SOURCE_DEPENDENCY_LINK_CHANGED");
        externalRoots.add(location);
      }
      const link = join(target, "node_modules", dependency);
      await mkdir(resolve(link, ".."), { recursive: true });
      await symlink(location, link);
    }
  }
  externalRoots.add(join(core, "apps/web/dist"));
  externalRoots.add(join(core, "packages/bundle/web-app/presets"));
  for (const file of original.externalLockFiles)
    if (file.startsWith(core + "/")) externalLockFiles.add(file);
  await writeFile(
    join(directory, "company-plugins.json"),
    JSON.stringify(plugins, null, 2),
  );
  const oldModules = join(
    runtime,
    "source-combinations",
    latest,
    "node_modules",
  );
  const overlayFile = join(
    runtime,
    "source-combinations",
    latest,
    "deployment.patch.json",
  );
  if (original.composition.patches[0] !== overlayFile)
    throw Error("INVALID_SOURCE_OVERLAY_PATH");
  const patch = JSON.parse(
    await readPinnedInput(overlayFile, original.files["deployment.patch.json"]),
  );
  const rewritten = JSON.stringify(patch, null, 2)
    .split(oldModules)
    .join(modules);
  await writeFile(join(directory, "deployment.patch.json"), rewritten);
  let profileDefaults;
  if (original.composition.profileDefaults) {
    const defaultsPath = join(
      runtime,
      "source-combinations",
      latest,
      "profile-defaults.json",
    );
    if (original.composition.profileDefaults !== defaultsPath)
      throw Error("INVALID_SOURCE_DEFAULTS_PATH");
    const defaults = await readPinnedInput(
      defaultsPath,
      original.files["profile-defaults.json"],
    );
    await writeFile(join(directory, "profile-defaults.json"), defaults);
    profileDefaults = join(directory, "profile-defaults.json");
  }
  const composition = {
    ...original.composition,
    id,
    dependencies,
    patches: [join(directory, "deployment.patch.json")],
    ...(profileDefaults ? { profileDefaults } : {}),
  };
  const externalFiles = await dependencyDigests(externalRoots);
  for (const [file, hash] of Object.entries(externalFiles))
    if (expectedExternal[file] !== hash)
      throw Error("SOURCE_DEPENDENCY_DIGEST_MISMATCH");
  for (const file of externalLockFiles)
    externalFiles[file] = createHash("sha256")
      .update(await readPinnedInput(file, expectedExternal[file]))
      .digest("hex");
  await writeFile(
    join(directory, "combination.json"),
    JSON.stringify(
      {
        ...original,
        composition,
        files: await resourceDigests(directory),
        externalRoots: [...externalRoots],
        externalFiles,
        externalLockFiles: [...externalLockFiles],
        locks,
        assembler: await fileDigest(new URL(import.meta.url)),
      },
      null,
      2,
    ) + "\n",
  );
  return composition;
}

/** Use only bytes covered by the input snapshot's frozen resource or dependency digest. */
async function readPinnedInput(file, expected) {
  if (!expected) throw Error("SOURCE_INPUT_DIGEST_MISSING: " + file);
  const bytes = await readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw Error("SOURCE_INPUT_DIGEST_MISMATCH: " + file);
  return bytes;
}
