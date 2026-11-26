import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  readdir,
  lstat,
  readlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { makeArchive } from "./fixtures/plugin-updates/installed-runtime.mjs";
import { CompanyInstallation } from "../desktop/company-installation.mjs";
import { prepareCompanyBoot, writeCompanySeedLock } from "../desktop/company-bootstrap.mjs";
import { companyPackageNames } from "../desktop/company-archives.mjs";

const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
const packaged = process.env.GEA_PLUGIN_UPDATE_PACKAGED;
const fileSpec = (profile, path) => "file:" + relative(profile, path).replaceAll("\\", "/");
const pnpm =
  process.env.GEA_PLUGIN_UPDATE_PNPM ??
  join(dirname(createRequire(import.meta.url).resolve("pnpm")), "bin/pnpm.cjs");
if (!sdk && !packaged) throw Error("fixed Core SDK or installed Windows runtime required");
const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function inventory(directory, prefix = "") {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const relative = prefix ? prefix + "/" + name : name;
    const entry = await lstat(path);
    const type = entry.isSymbolicLink() ? "link" : entry.isDirectory() ? "directory" : "file";
    entries.push([relative, type, type === "link" ? await readlink(path) : null]);
    if (type === "directory") entries.push(...(await inventory(path, relative)));
  }
  return entries;
}

for (const userCache of [false, true, "active-wal"])
  test(
    `a new Core installs the bundled seed offline and preserves the previous user store (${userCache})`,
    { timeout: 120000 },
    async (t) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "gea-core-offline-seed-")));
      t.after(() =>
        process.env.GEA_KEEP_TEST_ARTIFACTS
          ? console.error(directory)
          : rm(directory, { recursive: true, force: true }),
      );
      const home = join(directory, "home");
      const profile = join(home, "profiles/desktop");
      const root = packaged ? join(packaged, "app.asar") : join(directory, "runtime");
      const support = packaged ? join(packaged, "runtime") : join(directory, "support");
      const seed = join(directory, "seed");
      const store = userCache
        ? join(directory, "external-user-store")
        : join(home, "desktop-company-cache/installation/store");
      await mkdir(profile, { recursive: true });
      await mkdir(join(seed, "archives"), { recursive: true });
      if (!packaged) {
        await mkdir(join(root, "dsh/node_modules/@deepseek-ai"), { recursive: true });
        await mkdir(support, { recursive: true });
        for (const [name, path] of Object.entries({
          "dsh-app-boot": "packages/boot/app-boot",
          "dsh-plugin-manager": "packages/boot/plugin-manager",
          "dsh-atomic-write": "packages/util/atomic-write",
        }))
          await symlink(join(sdk, path), join(root, "dsh/node_modules/@deepseek-ai", name), "dir");
        await symlink(
          dirname(createRequire(import.meta.url).resolve("yaml/package.json")),
          join(root, "dsh/node_modules/yaml"),
          "dir",
        );
        await symlink(dirname(dirname(pnpm)), join(support, "pnpm"), "dir");
      }
      const run = async (cwd, args) =>
        execute(
          process.execPath,
          [
            "--expose-internals",
            pnpm,
            "--dir",
            cwd,
            ...args,
            "--config.lockfile-dir=" + cwd,
            "--config.update-notifier=false",
            "--config.manage-package-manager-versions=false",
          ],
          { cwd, env: process.env },
        );
      const old = await Promise.all(
        companyPackageNames.map((name, index) =>
          makeArchive(
            join(directory, "old"),
            name,
            ["0.1.50", "0.6.3-company.46", "0.0.216"][index],
          ),
        ),
      );
      await writeFile(
        join(profile, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: companyPackageNames } },
          retained: "user configuration",
        }),
      );
      await run(profile, [
        "add",
        ...old.map((row) => fileSpec(profile, row.path)),
        "--offline",
        "--store-dir=" + store,
      ]);
      const dependency = await makeArchive(
        join(directory, "dependency"),
        "seed-only-dependency",
        "1.0.0",
      );
      const employee = await makeArchive(
        join(directory, "employee"),
        "employee-registry-widget",
        "1.0.0",
      );
      const oldMetadata = join(home, "desktop-company-cache/metadata");
      let origin;
      const tarballPath = ({ name, version }) => `/${name}/-/${name}-${version}.tgz`;
      const registryMetadata = (pkg, registry) => {
        const { name, version } = pkg.manifest;
        return {
          name,
          "dist-tags": { latest: version },
          time: { [version]: "2020-01-01T00:00:00.000Z" },
          versions: {
            [version]: {
              ...pkg.manifest,
              dist: {
                tarball: registry + tarballPath(pkg.manifest),
                integrity: "sha512-" + createHash("sha512").update(pkg.bytes).digest("base64"),
              },
            },
          },
        };
      };
      const cachePublicMetadata = async (cache, pkg) => {
        const metadata = registryMetadata(pkg, "https://registry.npmjs.org");
        for (const format of ["metadata", "metadata-full"]) {
          const directory = join(cache, "v11", format, "registry.npmjs.org");
          await mkdir(directory, { recursive: true });
          await writeFile(
            join(directory, metadata.name + ".jsonl"),
            "{}\n" + JSON.stringify(metadata),
          );
        }
      };
      const server = createServer((request, response) => {
        const pkg = request.url.includes("employee") ? employee : dependency;
        if (request.url === tarballPath(pkg.manifest)) response.end(pkg.bytes);
        else {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(registryMetadata(pkg, origin)));
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => server.close());
      origin = "http://127.0.0.1:" + server.address().port;
      if (userCache) {
        await run(profile, [
          "add",
          employee.manifest.name + "@1.0.0",
          "--save-exact",
          "--registry=" + origin,
          "--store-dir=" + store,
          "--cache-dir=" + oldMetadata,
        ]);
        await cachePublicMetadata(oldMetadata, employee);
      }
      const previous = new CompanyInstallation(profile, "a".repeat(40));
      await previous.initialize();
      await previous.beginBoot();
      const packages = [];
      for (const [index, name] of companyPackageNames.entries()) {
        const artifact = await makeArchive(
          join(directory, "new"),
          name,
          ["0.1.51", "0.6.3-company.47", "0.0.217"][index],
        );
        const source = join(dirname(artifact.path), "package");
        if (index === 2) {
          artifact.manifest.dependencies = { "seed-only-dependency": "1.0.0" };
          await writeFile(join(source, "package.json"), JSON.stringify(artifact.manifest));
        }
        const file = "company-" + index + ".tgz";
        const archive = join(seed, "archives", file);
        execFileSync("tar", ["-czf", archive, "-C", dirname(source), "package"], {
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        });
        packages.push({
          name,
          version: artifact.manifest.version,
          file,
          sha256: digest(await readFile(archive)),
        });
      }
      const seedProfile = join(directory, "seed-profile");
      await mkdir(seedProfile);
      await writeFile(join(seedProfile, "package.json"), '{"private":true}');
      await writeFile(join(seedProfile, "pnpm-workspace.yaml"), "autoInstallPeers: false\n");
      await run(seedProfile, [
        "add",
        ...packages.map((row) => fileSpec(seedProfile, join(seed, "archives", row.file))),
        "--registry=" + origin,
        "--store-dir=" + join(seed, "store"),
        "--cache-dir=" + join(seed, "metadata"),
      ]);
      await cachePublicMetadata(join(seed, "metadata"), dependency);
      const manifest = { schema: 1, core: { head: "b".repeat(40) }, packages };
      await writeFile(join(seed, "manifest.json"), JSON.stringify(manifest));
      await writeCompanySeedLock({ root, seed, profile: seedProfile }).catch(async (error) => {
        const lock = await readFile(join(seedProfile, "pnpm-lock.yaml"), "utf8");
        console.error(lock.split(/\n\s*packages:/u, 1)[0]);
        throw error;
      });
      await rm(join(seed, "store/v11/projects"), { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
      if (userCache) {
        const control = join(directory, "independent-control");
        await mkdir(control);
        await writeFile(
          join(control, "package.json"),
          JSON.stringify({ private: true, dependencies: { [employee.manifest.name]: "1.0.0" } }),
        );
        await run(control, [
          "install",
          "--offline",
          "--frozen-store",
          "--store-dir=" + store,
          "--cache-dir=" + oldMetadata,
          "--registry=https://registry.npmjs.org",
        ]);
        assert.equal(
          JSON.parse(
            await readFile(join(control, "node_modules", employee.manifest.name, "package.json")),
          ).version,
          "1.0.0",
        );
      }
      await writeFile(join(store, "old-store-sentinel"), "retained old store");
      const oldIndex = await readFile(join(store, "v11/index.db"));
      const oldEntries = await inventory(store);
      const seedIndex = await readFile(join(seed, "store/v11/index.db"));
      if (userCache === "active-wal") {
        await writeFile(join(store, "v11/index.db-wal"), "active cache writer");
        await assert.rejects(
          prepareCompanyBoot({ home, root, support, seed, manifest }),
          /GEA_PREVIOUS_STORE_ACTIVE/,
        );
        assert.deepEqual(await readFile(join(store, "v11/index.db")), oldIndex);
        assert.deepEqual(await readFile(join(seed, "store/v11/index.db")), seedIndex);
        assert.equal(
          await readFile(join(store, "v11/index.db-wal"), "utf8"),
          "active cache writer",
        );
        assert.equal((await previous.store.selected()).id, "baseline");
        return;
      }
      for (const coreHead of ["b".repeat(40), "c".repeat(40)]) {
        const result = await prepareCompanyBoot({
          home,
          root,
          support,
          seed,
          manifest: { ...manifest, core: { head: coreHead } },
        }).catch(async (error) => {
          const prefix = "GEA_COMPANY_INSTALL_FAILED: ";
          if (error.message.startsWith(prefix))
            console.error(await readFile(error.message.slice(prefix.length), "utf8"));
          throw error;
        });
        assert.equal(result.coreHead, coreHead);
        if (userCache)
          assert.equal(
            JSON.parse(
              await readFile(join(profile, "node_modules", employee.manifest.name, "package.json")),
            ).version,
            "1.0.0",
          );
        if (userCache) {
          const employeeEntry = createRequire(join(profile, "package.json")).resolve(
            employee.manifest.name,
          );
          assert.equal(
            (await import(pathToFileURL(employeeEntry).href)).pluginPackageVersion.version,
            "1.0.0",
          );
          assert.equal(
            JSON.parse(await readFile(join(profile, "package.json"))).dependencies[
              employee.manifest.name
            ],
            "1.0.0",
          );
        }
        const dependencyPath = createRequire(
          join(profile, "node_modules", companyPackageNames[2], "package.json"),
        ).resolve("seed-only-dependency");
        assert.equal(
          JSON.parse(await readFile(join(dirname(dirname(dependencyPath)), "package.json")))
            .version,
          "1.0.0",
        );
        assert.equal(
          (await import(pathToFileURL(dependencyPath).href)).pluginPackageVersion.version,
          "1.0.0",
        );
        assert.equal(
          JSON.parse(await readFile(join(profile, "package.json"))).retained,
          "user configuration",
        );
        assert.equal(
          await readFile(join(store, "old-store-sentinel"), "utf8"),
          "retained old store",
        );
        assert.deepEqual(await readFile(join(store, "v11/index.db")), oldIndex);
        assert.deepEqual(await inventory(store), oldEntries);
        assert.deepEqual(await readFile(join(seed, "store/v11/index.db")), seedIndex);
      }
      const caches = await readdir(join(home, "desktop-company-cache"));
      assert(!caches.some((entry) => /^[a-f0-9]{64}$/.test(entry)));
      assert.equal((await readdir(join(home, "desktop-company-cache/seed-stores"))).length, 1);
      if (userCache)
        assert.equal((await readdir(join(home, "desktop-company-cache/seed-recovery"))).length, 1);
    },
  );
