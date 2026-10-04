/** Check/build this isolated workspace's plugins against the built sibling DSH source. */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { corePackages, sourcePlugins } from "./source-composition.mjs";

const { values } = parseArgs({
  options: { build: { type: "boolean" }, sources: { type: "string" } },
});
const root = resolve(import.meta.dirname, "..");
const workspace = resolve(root, "..");
const core = resolve(root, "../../official-latest-standard");
const records = values.sources
  ? JSON.parse(await readFile(values.sources, "utf8"))
  : sourcePlugins.map((plugin) => ({
      repo: plugin.repo,
      source: join(workspace, plugin.repo),
    }));
const inputFor = (repo) => records.find((entry) => entry.repo === repo);
const dependencyFor = (repo) =>
  inputFor(repo)?.dependencies ?? join(sourceFor(repo), "node_modules");
const sourceFor = (repo) =>
  records.find((entry) => entry.repo === repo)?.source ??
  (() => {
    throw Error("SOURCE_PLUGIN_MISSING: " + repo);
  })();
const output = join(root, ".runtime/source-compatibility");
await mkdir(output, { recursive: true });
const paths = {};
for (const { manifest, directory } of await corePackages(core)) {
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    if (typeof value === "object" && value?.types) {
      paths[manifest.name + (key === "." ? "" : key.slice(1))] = [
        resolve(directory, value.types),
      ];
    }
  }
  if (manifest.types)
    paths[manifest.name] ??= [resolve(directory, manifest.types)];
}
for (const plugin of sourcePlugins) {
  for (const [name, file] of Object.entries(plugin.typeEntries ?? {}))
    paths[name] = [join(sourceFor(plugin.repo), file)];
}
for (const plugin of sourcePlugins) {
  const name = plugin.repo;
  const cwd = sourceFor(name);
  const projects = [];
  for (const config of plugin.configs) {
    const target = join(output, `${name}-${config}`);
    await writeFile(
      target,
      JSON.stringify(
        {
          extends: join(cwd, config),
          compilerOptions: {
            paths,
            typeRoots: [join(dependencyFor(name), "@types")],
            noEmit: true,
            emitDeclarationOnly: false,
          },
        },
        null,
        2,
      ) + "\n",
    );
    execFileSync(
      process.execPath,
      [join(dependencyFor(name), "typescript/bin/tsc"), "-p", target],
      { cwd, stdio: "inherit" },
    );
    projects.push(target);
  }
  if (!values.build) continue;
  if (plugin.build === "workbench") {
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd,
      env: { ...process.env, DSH_TYPECHECK_PROJECT: projects[0] },
      stdio: "inherit",
    });
  } else if (plugin.build === "manage") {
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-p",
        projects[0],
        "--noEmit",
        "false",
      ],
      { cwd, stdio: "inherit" },
    );
    execFileSync("corepack", ["pnpm", "run", "build:client"], {
      cwd,
      stdio: "inherit",
    });
  } else {
    execFileSync("corepack", ["pnpm", "run", plugin.build], {
      cwd,
      stdio: "inherit",
    });
  }
}
