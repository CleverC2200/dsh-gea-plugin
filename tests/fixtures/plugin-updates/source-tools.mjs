import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import ts from "typescript";

export function sourceTools(sdk) {
  const donor = process.env.GEA_PLUGIN_UPDATE_TOOLS;
  const coreTools = process.env.GEA_PLUGIN_UPDATE_CORE_TOOLS;
  if (!donor || !coreTools) return [];
  const paths = ts.readConfigFile(resolve(sdk, "tsconfig.base.json"), ts.sys.readFile).config
    .compilerOptions.paths;
  const toolRequire = createRequire(resolve(donor, "package.json"));
  return [
    {
      name: "current-update-source-tools",
      setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, async ({ path, importer }) => {
          if (builder.initialOptions.external?.includes(path)) return { path, external: true };
          if (/^react(?:-dom)?(?:\/|$)/.test(path) || path === "@deepseek-ai/cordis")
            return { path: toolRequire.resolve(path) };
          const parent = Object.keys(paths).find(
            (name) => path.startsWith(name + "/") && paths[name][0].endsWith("/src"),
          );
          const values =
            paths[path] ??
            (parent
              ? [paths[parent][0] + path.slice(parent.length).replace(/^\/src\//, "/")]
              : undefined);
          if (values) {
            const base = resolve(sdk, values[0]);
            for (const candidate of [base, base + ".ts", base + "/index.ts"]) {
              try {
                await readFile(candidate);
                return { path: candidate };
              } catch {}
            }
          }
          if (path.startsWith("@deepseek-ai/")) return;
          const locations = importer.startsWith(sdk)
            ? [
                resolve(coreTools, importer.slice(sdk.length + 1)),
                resolve(coreTools, "package.json"),
              ]
            : [resolve(donor, "package.json")];
          for (const location of locations) {
            try {
              return { path: createRequire(location).resolve(path) };
            } catch {}
          }
        });
      },
    },
  ];
}
