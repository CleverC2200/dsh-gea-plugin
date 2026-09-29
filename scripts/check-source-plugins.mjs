/** Check/build this isolated workspace's plugins against the built sibling DSH source. */
import { readFile, writeFile, mkdir, glob } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { build: { type: "boolean" } } });
const root = resolve(import.meta.dirname, "..");
const workspace = resolve(root, "..");
const core = join(workspace, "deepseek-harness");
const output = join(root, ".runtime/source-compatibility");
await mkdir(output, { recursive: true });
const paths = {};
for await (const file of glob(
  ["packages/*/*/package.json", "apps/*/package.json", "vendor/*/package.json"],
  { cwd: core },
)) {
  const manifest = JSON.parse(await readFile(join(core, file), "utf8"));
  const directory = resolve(core, file, "..");
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
paths["@cleverc2200/dsh-agent-workbench"] = [
  join(workspace, "dsh-agent-workbench/lib/types/host.d.ts"),
];
paths["@cleverc2200/dsh-agent-workbench/client"] = [
  join(workspace, "dsh-agent-workbench/lib/types/client.d.ts"),
];
for (const name of [
  "dsh-agent-workbench",
  "dsh-agent-manage",
  "dsh-gea-plugin",
]) {
  const cwd = join(workspace, name);
  const configurations =
    name === "dsh-agent-manage"
      ? ["tsconfig.json", "tsconfig.client.json"]
      : ["tsconfig.json"];
  const projects = [];
  for (const config of configurations) {
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
  if (name === "dsh-agent-workbench") {
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd,
      env: { ...process.env, DSH_TYPECHECK_PROJECT: projects[0] },
      stdio: "inherit",
    });
  } else if (name === "dsh-agent-manage") {
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
    execFileSync("corepack", ["pnpm", "run", "build:plugin"], {
      cwd,
      stdio: "inherit",
    });
  }
}
