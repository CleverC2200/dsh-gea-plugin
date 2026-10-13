/** Compile a fixed source into fixture-owned output while retaining its declared dependency graph. */
import { build } from "esbuild";
import { mkdtemp, realpath, symlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function compiledSource(t, { contents, source, dependencies, url, parent }) {
  const directory = await mkdtemp(join(parent, "compiled-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(await realpath(dependencies), join(directory, "node_modules"), "dir");
  const result = await build({
    stdin: { contents, resolveDir: source },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(url).href) },
  });
  const output = join(directory, "source.mjs");
  await writeFile(output, result.outputFiles[0].text);
  return import(pathToFileURL(output).href);
}
