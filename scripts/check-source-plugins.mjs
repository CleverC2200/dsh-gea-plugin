/** Check/build this isolated workspace's plugins against the built sibling DSH source. */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { corePackages, sourcePlugins } from "./source-composition.mjs";

import { pathToFileURL } from "node:url";
import { resolveSourceInputs } from "./source-profile.mjs";

/** Check/build only the declared source inputs; frozen release assets are verified and reused. */
export async function checkSourcePlugins({
  sources,
  build = false,
  core = resolve(import.meta.dirname, "../../../official-latest-standard"),
  output = resolve(import.meta.dirname, "../.runtime/source-compatibility"),
} = {}) {
  const records = await resolveSourceInputs(sources);
  if (records.every((input) => input.assets)) return;
  const inputFor = (repo) => records.find((entry) => entry.repo === repo);
  const sourceFor = (repo) => inputFor(repo).source;
  const dependencyFor = (repo) =>
    inputFor(repo).dependencies ?? join(sourceFor(repo), "node_modules");
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
    if (manifest.types) paths[manifest.name] ??= [resolve(directory, manifest.types)];
  }
  for (const plugin of sourcePlugins) {
    for (const [name, file] of Object.entries(plugin.typeEntries ?? {}))
      paths[name] = [join(inputFor(plugin.repo).assetRoot, file)];
  }
  for (const plugin of sourcePlugins) {
    const name = plugin.repo;
    if (inputFor(name).assets) continue;
    const cwd = sourceFor(name);
    const projects = [];
    for (const config of plugin.configs) {
      const declared = JSON.parse(await readFile(join(cwd, config), "utf8"));
      const projectPaths = {};
      for (const [specifier, targets] of Object.entries(declared.compilerOptions?.paths ?? {}))
        if (!(specifier in paths))
          projectPaths[specifier] = targets.map((file) =>
            resolve(cwd, declared.compilerOptions?.baseUrl ?? ".", file),
          );
      const target = join(output, `${name}-${config}`);
      await writeFile(
        target,
        JSON.stringify(
          {
            extends: join(cwd, config),
            compilerOptions: {
              paths: { ...projectPaths, ...paths },
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
    if (!build) continue;
    if (plugin.build === "workbench") {
      execFileSync(process.execPath, ["scripts/build.mjs"], {
        cwd,
        env: { ...process.env, DSH_TYPECHECK_PROJECT: projects[0] },
        stdio: "inherit",
      });
    } else if (plugin.build === "manage") {
      execFileSync(
        process.execPath,
        ["node_modules/typescript/bin/tsc", "-p", projects[0], "--noEmit", "false"],
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
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: { build: { type: "boolean" }, sources: { type: "string" } },
  });
  if (!values.sources) throw Error("EXPLICIT_SOURCE_INPUTS_REQUIRED");
  await checkSourcePlugins({
    sources: JSON.parse(await readFile(values.sources, "utf8")),
    build: values.build === true,
  });
}
