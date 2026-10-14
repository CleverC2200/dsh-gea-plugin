import { cp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { companyPackageNames } from "../../../src/shared/plugin-release.mjs";
/** Real isolated pnpm layout. Only local TGZ inputs and a private store are permitted. */
export async function installPnpmConsumerLayout(f, range, sdkPeers = {}) {
  let manager = process.env.GEA_PLUGIN_UPDATE_PNPM;
  if (!manager) {
    const descriptor = createRequire(import.meta.url).resolve("pnpm");
    const manifest = JSON.parse(await readFile(descriptor, "utf8"));
    manager = join(dirname(descriptor), manifest.bin.pnpm);
  }
  const home = join(f.root, "pnpm-home"),
    store = join(f.root, "pnpm-store");
  await mkdir(home);
  const config = join(home, "empty.npmrc");
  await writeFile(config, "");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    npm_config_userconfig: config,
    npm_config_globalconfig: config,
  };
  const invoke = (args) =>
    execFileSync(process.execPath, [manager, ...args], {
      cwd: f.dir,
      env,
      encoding: "utf8",
      timeout: 30000,
    });
  if (invoke(["--version"]).trim() !== "11.7.0") throw Error("PNPM_FIXTURE_VERSION_MISMATCH");
  const pack = async (name, manifest) => {
    const base = join(f.root, "pnpm-inputs", name.replaceAll("/", "_"));
    const pkg = join(base, "package");
    await mkdir(pkg, { recursive: true });
    if (companyPackageNames.includes(name))
      await cp(join(f.dir, "node_modules", name), pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify(manifest ?? JSON.parse(await readFile(join(pkg, "package.json"), "utf8"))),
    );
    await writeFile(join(pkg, "index.js"), "export default {};\n");
    const archive = join(base, "input.tgz");
    execFileSync("tar", ["-czf", archive, "-C", base, "package"]);
    return archive;
  };
  const company = await Promise.all(companyPackageNames.map((name) => pack(name)));
  const b = await pack("fixture-consumer-b", {
    name: "fixture-consumer-b",
    version: "1.0.0",
    type: "module",
    peerDependencies: { [companyPackageNames[2]]: range, ...sdkPeers },
  });
  const a = await pack("fixture-parent-a", {
    name: "fixture-parent-a",
    version: "1.0.0",
    type: "module",
    dependencies: { "fixture-consumer-b": "file:" + b },
  });
  await rename(join(f.dir, "node_modules"), join(f.root, "direct-fixture-node_modules"));
  const manifest = JSON.parse(await readFile(join(f.dir, "package.json"), "utf8"));
  await writeFile(
    join(f.dir, "package.json"),
    JSON.stringify({
      ...manifest,
      packageManager: "pnpm@11.7.0",
      dependencies: {
        ...Object.fromEntries(companyPackageNames.map((name, i) => [name, "file:" + company[i]])),
        "fixture-parent-a": "file:" + a,
      },
    }),
  );
  const output = invoke([
    "install",
    "--offline",
    "--ignore-scripts",
    "--ignore-pnpmfile",
    "--config.auto-install-peers=false",
    "--store-dir",
    store,
  ]);
  await writeFile(join(f.root, "actual-pnpm-install.log"), output);
  return { invoke, store, company };
}
