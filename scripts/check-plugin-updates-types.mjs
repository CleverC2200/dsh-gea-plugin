/** Explicit prepared SDK lane: unchanged public declarations plus current UI source contract. */
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK,
  candidate = process.env.GEA_PLUGIN_UPDATE_CANDIDATE_CORE;
if (!sdk || !candidate || !isAbsolute(sdk) || !isAbsolute(candidate))
  throw Error("PLUGIN_UPDATES_TYPE_INPUTS_REQUIRED");
const root = process.cwd(),
  config = JSON.parse(await readFile("tsconfig.official.json", "utf8"));
config.compilerOptions.paths = Object.fromEntries(
  Object.entries(config.compilerOptions.paths)
    .filter(([name]) => name.startsWith("@deepseek-ai/"))
    .map(([name, paths]) => [
      name,
      paths.map((path) => path.replace("../../official-latest-standard", sdk)),
    ]),
);
config.compilerOptions.paths["@deepseek-ai/dsh-client-ui-plugin-manager/client"] = [
  join(candidate, "packages/client/ui-plugin-manager/src/client/update-contract.ts"),
];
config.compilerOptions.types = ["node"];
config.compilerOptions.typeRoots = [resolve("node_modules/@types")];
config.include = [
  "src/host/plugin-updates.ts",
  "src/plugin-updates-client.ts",
  "src/plugin-package-version.ts",
].map((path) => join(root, path));
await mkdir(".runtime", { recursive: true });
const directory = await mkdtemp(resolve(".runtime/plugin-update-types-"));
try {
  const file = join(directory, "tsconfig.json");
  const probe = join(directory, "contract.ts");
  await writeFile(
    probe,
    [
      'import type { PluginUpdateProvider, PluginPackageUpdateProblem } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";',
      `import type { createPluginUpdatesProvider } from ${JSON.stringify(join(root, "src/plugin-updates-client.ts"))};`,
      `import type { PluginUpdateProblem } from ${JSON.stringify(join(root, "src/shared/plugin-update-diagnostics.ts"))};`,
      "type RequireProvider<T extends PluginUpdateProvider> = T;",
      "type RequireProblem<T extends PluginPackageUpdateProblem> = T;",
      'export type ProviderContract = RequireProvider<ReturnType<typeof createPluginUpdatesProvider>["provider"]>;',
      "export type ProblemContract = RequireProblem<PluginUpdateProblem>;",
    ].join("\n"),
  );
  config.include.push(probe);
  await writeFile(file, JSON.stringify(config));
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", file], {
    stdio: "inherit",
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
