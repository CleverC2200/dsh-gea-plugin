import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
test("compiled GEA package stamp stays immutable until the next owner build", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-compiled-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "src"));
  await mkdir(join(directory, "scripts"));
  await copyFile(
    "scripts/generate-plugin-package-version.mjs",
    join(directory, "scripts/generate-plugin-package-version.mjs"),
  );
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  const generate = (...args) =>
    execFileSync(process.execPath, ["scripts/generate-plugin-package-version.mjs", ...args], {
      cwd: directory,
      stdio: "pipe",
    });
  generate();
  generate("--check");
  const output = join(directory, "first.mjs");
  await build({
    entryPoints: [join(directory, "src/plugin-package-version.ts")],
    format: "esm",
    outfile: output,
    logLevel: "silent",
  });
  const loaded = (await import(pathToFileURL(output))).pluginPackageVersion;
  assert.deepEqual(loaded, { name: manifest.name, version: manifest.version });
  assert.equal(Object.isFrozen(loaded), true);
  const next = "99.0.0-fixture";
  await writeFile(join(directory, "package.json"), JSON.stringify({ ...manifest, version: next }));
  assert.throws(() => generate("--check"), /PLUGIN_PACKAGE_VERSION_STALE/);
  assert.equal(loaded.version, manifest.version);
  generate();
  const rebuilt = join(directory, "second.mjs");
  await build({
    entryPoints: [join(directory, "src/plugin-package-version.ts")],
    format: "esm",
    outfile: rebuilt,
    logLevel: "silent",
  });
  assert.equal((await import(pathToFileURL(rebuilt))).pluginPackageVersion.version, next);
});

test("the actual declared client builder exposes the compiled stamp in its materialized namespace", async () => {
  const { runInNewContext } = await import("node:vm");
  execFileSync(process.execPath, ["scripts/build.mjs", "--target", "client"], { stdio: "pipe" });
  let loaded;
  runInNewContext(await readFile("lib/client.js", "utf8"), {
    window: {
      __ModuleLoader__: {
        load(record) {
          loaded = record;
        },
      },
    },
  });
  // This namespace-only contract does not render UI; the browser contract loads actual SDK controls.
  const externals = {
    react: await import("react"),
    "react/jsx-runtime": await import("react/jsx-runtime"),
    "@deepseek-ai/dsh-client-store": await import("@deepseek-ai/dsh-client-store"),
    "@deepseek-ai/dsh-client-ui-primitives": {},
  };
  const namespace = loaded.factory((name) => {
    if (!(name in externals)) throw Error("Unexpected client external: " + name);
    return externals[name];
  });
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(namespace.pluginPackageVersion.name, manifest.name);
  assert.equal(namespace.pluginPackageVersion.version, manifest.version);
  assert.equal(Object.isFrozen(namespace.pluginPackageVersion), true);
});
