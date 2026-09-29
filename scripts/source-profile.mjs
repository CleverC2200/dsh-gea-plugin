/** Assemble immutable plugin snapshots for the isolated DSH source profile. */
import {
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { composeSourcePresets } from "./source-presets.mjs";
import { corePackages, sourcePlugins } from "./source-composition.mjs";
function clientEntry(manifest) {
  const entry = manifest.exports?.["./client"];
  return typeof entry === "string"
    ? entry
    : (entry?.default ?? "client/client.js");
}

export async function prepareSourcePlugins(core, runtime, deployment) {
  const workspace = resolve(import.meta.dirname, "../..");
  const profile = join(runtime, "home/profiles/plugin-split-validation");
  const modules = join(profile, "node_modules");
  const packages = new Map((await corePackages(core)).map(
    ({ manifest, directory }) => [manifest.name, directory],
  ));
  const plugins = new Map();
  for (const plugin of sourcePlugins) {
    const repo = plugin.repo;
    const source = join(workspace, repo);
    const expectedCommit = plugin.commit;
    if (expectedCommit) {
      const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
        cwd: source, encoding: "utf8",
      }).trim();
      if (commit !== expectedCommit) throw Error(`SOURCE_PLUGIN_COMMIT_MISMATCH: ${repo} expected ${expectedCommit}, got ${commit}`);
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
        filter: path => !path.split(/[\\/]/).includes("node_modules"),
      });
    }
    plugins.set(manifest.name, { source, target, version: manifest.version, plugin });
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
    join(runtime, "company-plugins.json"),
    JSON.stringify(snapshots, null, 2),
  );
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
  const modelIndex = patch.findIndex(row => row.id === "agent-default-model");
  if (modelIndex < 0) throw Error("SOURCE_MODEL_DEFAULT_MISSING");
  const [modelDefault] = patch.splice(modelIndex, 1);
  // User-selectable defaults belong to the editable profile, not a read-only CLI overlay.
  try {
    await writeFile(join(profile, "cordis.patch.yml"), JSON.stringify([modelDefault], null, 2), { flag: "wx", mode: 0o600 });
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  patch.push({
    id: "agent-preset-registry",
    config: { default: "auto-negotiation" },
  });
  patch.push({ id: "dsh-agent-manage", config: { sources: [] } });
  await writeFile(
    join(runtime, "deployment.patch.json"),
    JSON.stringify(patch, null, 2),
  );
  const standard = join(core, "packages/bundle/web-app/presets/standard.patch.yml");
  const business = join(gea, "presets/gea-readonly/agent.cordis.yml");
  const presetPatch = composeSourcePresets(
    { source: standard, text: await readFile(standard, "utf8") },
    { source: business, text: await readFile(business, "utf8") },
    join(gea, "lib/skill-reference.js"),
  );
  await writeFile(join(runtime, "presets.patch.yml"), presetPatch);
  return {
    dependencies: Object.fromEntries(
      [...plugins].map(([name, data]) => [name, data.version]),
    ),
    bundles: [...plugins].filter(([, data]) => data.plugin.bundleOrder !== undefined).sort((a, b) => a[1].plugin.bundleOrder - b[1].plugin.bundleOrder).map(([name]) => name),
    patches: [
      join(runtime, "deployment.patch.json"),
      join(runtime, "presets.patch.yml"),
    ],
  };
}
