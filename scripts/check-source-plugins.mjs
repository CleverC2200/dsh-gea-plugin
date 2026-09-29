/** Check/build this isolated workspace's plugins against the built sibling DSH source. */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { corePackages, sourcePlugins } from "./source-composition.mjs";

const { values } = parseArgs({ options: { build: { type: "boolean" } } });
const root = resolve(import.meta.dirname, "..");
const workspace = resolve(root, "..");
const core = join(workspace, "deepseek-harness");
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
    paths[name] = [join(workspace, plugin.repo, file)];
}
for (const plugin of sourcePlugins) {
  const name = plugin.repo;
  const cwd = join(workspace, name);
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
            typeRoots: [join(cwd, "node_modules/@types")],
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
      [join(cwd, "node_modules/typescript/bin/tsc"), "-p", target],
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
  } else if (plugin.build === "hub") {
    execFileSync("npm", ["run", "build"], { cwd, stdio: "inherit" });
  } else {
    execFileSync("corepack", ["pnpm", "run", plugin.build], {
      cwd,
      stdio: "inherit",
    });
  }
}
