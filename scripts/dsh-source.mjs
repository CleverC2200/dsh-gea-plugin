import { existsSync, globSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Resolve the DSH checkout used for a local fork integration run. */
export function resolveDshSource(value = process.env.DSH_SOURCE_DIR) {
  if (!value) return undefined;
  const root = resolve(value);
  if (!existsSync(resolve(root, "apps/cli/lib/bin.js")))
    throw new Error(
      "GEA_DSH_SOURCE_INVALID: apps/cli/lib/bin.js is missing; build the DSH fork first",
    );
  return root;
}

async function packageIndex(source) {
  const result = new Map();
  for (const file of globSync(
    [
      "packages/*/*/package.json",
      "vendor/*/package.json",
      "apps/*/package.json",
      "native/system/package.json",
      "native/system/packages/*/package.json",
    ],
    { cwd: source },
  )) {
    const path = resolve(source, file);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (typeof manifest.name === "string")
      result.set(manifest.name, dirname(path));
  }
  return result;
}

/**
 * Link the plugin's direct DSH runtime dependencies to one source checkout.
 * The links live below node_modules (ignored by Git) and are only for local
 * validation; published installs continue to use their declared versions.
 */
export async function linkDshSource({ source, pluginRoot }) {
  const index = await packageIndex(source);
  const manifest = JSON.parse(
    await readFile(resolve(pluginRoot, "package.json"), "utf8"),
  );
  const names = Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  }).filter(
    (name) =>
      name === "@deepseek-ai/dsh" ||
      name === "@deepseek-ai/cordis" ||
      name === "@deepseek-ai/schemastery" ||
      name.startsWith("@deepseek-ai/dsh-"),
  );
  const layout = index.get("@deepseek-ai/dsh-client-ui-layout");
  if (!layout || !existsSync(resolve(layout, "lib/client.js")))
    throw new Error(
      "GEA_DSH_SOURCE_ARTIFACT_MISSING: build ui-layout with pnpm --filter @deepseek-ai/dsh-client-ui-layout bundle",
    );
  for (const name of names) {
    if (!index.has(name))
      throw new Error(`GEA_DSH_SOURCE_PACKAGE_MISSING: ${name}`);
  }
  for (const name of names) {
    const target = index.get(name);
    const destination = resolve(pluginRoot, "node_modules", name);
    try {
      if ((await realpath(destination)) === target) continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rm(destination, { recursive: true, force: true });
    await mkdir(dirname(destination), { recursive: true });
    await symlink(target, destination, "dir");
  }
  await mkdir(resolve(pluginRoot, "lib"), { recursive: true });
  await writeFile(
    resolve(pluginRoot, "lib/dsh-runtime.json"),
    JSON.stringify({ source }, null, 2) + "\n",
  );
  return { source, linked: names, layout };
}

/** Ensure a source checkout is ready and link its runtime packages when selected. */
export async function prepareDshSource(
  pluginRoot,
  value = process.env.DSH_SOURCE_DIR,
) {
  if (!value) {
    try {
      value = JSON.parse(
        await readFile(resolve(pluginRoot, "lib/dsh-runtime.json"), "utf8"),
      ).source;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const source = resolveDshSource(value);
  if (!source)
    throw new Error(
      "GEA_DSH_SOURCE_REQUIRED: set DSH_SOURCE_DIR to the built DSH fork; published rc.1 does not include the native conversation panel",
    );
  return linkDshSource({ source, pluginRoot });
}
