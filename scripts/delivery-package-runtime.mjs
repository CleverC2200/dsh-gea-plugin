import fs from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolRoot = dirname(import.meta.dirname);
const within = (root, path) => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== ".." && !value.startsWith("../");
};

export function readDeliveryRuntime(path) {
  try {
    if (!isAbsolute(path ?? "")) throw Error();
    const root = fs.realpathSync(path);
    for (const file of ["package.json", "pnpm-lock.yaml"])
      if (
        !fs
          .readFileSync(join(root, file))
          .equals(fs.readFileSync(join(toolRoot, "scripts/delivery-runtime", file)))
      )
        throw Error();
    const manifest = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8"));
    const sourceManifest = JSON.parse(fs.readFileSync(join(toolRoot, "package.json"), "utf8"));
    if (manifest.packageManager !== sourceManifest.packageManager) throw Error();
    const require = createRequire(join(root, "package.json"));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const source = fs.realpathSync(require.resolve(name + "/package.json"));
      const installed = JSON.parse(fs.readFileSync(source, "utf8"));
      if (
        sourceManifest.dependencies[name] !== version ||
        !within(join(root, "node_modules"), source) ||
        installed.name !== name ||
        installed.version !== version
      )
        throw Error();
    }
    return root;
  } catch {
    throw Error("DEVELOPMENT_DELIVERY_RUNTIME_INVALID");
  }
}

if (process.execArgv.includes(fileURLToPath(import.meta.url))) {
  try {
    const runtime = readDeliveryRuntime(process.env.DSH_DELIVERY_RUNTIME);
    const runtimeParent = pathToFileURL(join(runtime, "package.json")).href;
    const toolPrefix = pathToFileURL(toolRoot + "/").href;
    const runtimePrefix = pathToFileURL(runtime + "/node_modules/").href;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const redirected =
          ["tar", "semver"].includes(specifier) && context.parentURL?.startsWith(toolPrefix);
        const result = nextResolve(
          specifier,
          redirected ? { ...context, parentURL: runtimeParent } : context,
        );
        if ((redirected || context.parentURL?.startsWith(runtimePrefix)) && !isBuiltin(specifier)) {
          if (
            !result.url.startsWith("file:") ||
            !within(join(runtime, "node_modules"), fs.realpathSync(fileURLToPath(result.url)))
          )
            throw Error("DEVELOPMENT_DELIVERY_RUNTIME_INVALID");
        }
        return result;
      },
    });
  } catch {
    console.error("DEVELOPMENT_DELIVERY_RUNTIME_INVALID");
    process.exit(1);
  }
}
