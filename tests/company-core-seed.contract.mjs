import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { makeArchive } from "./fixtures/plugin-updates/installed-runtime.mjs";
import { CompanyInstallation } from "../desktop/company-installation.mjs";
import { prepareCompanyBoot, writeCompanySeedLock } from "../desktop/company-bootstrap.mjs";
import { companyPackageNames } from "../desktop/company-archives.mjs";

const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
const pnpm =
  process.env.GEA_PLUGIN_UPDATE_PNPM ??
  join(dirname(createRequire(import.meta.url).resolve("pnpm")), "bin/pnpm.cjs");
if (!sdk) throw Error("fixed GEA_PLUGIN_UPDATE_SDK required");
const execute = promisify(execFile);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test(
  "a new Core installs a content-only bundled seed offline without replacing an existing shared store",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "gea-core-offline-seed-"));
    t.after(() =>
      process.env.GEA_KEEP_TEST_ARTIFACTS
        ? console.error(directory)
        : rm(directory, { recursive: true, force: true }),
    );
    const home = join(directory, "home");
    const profile = join(home, "profiles/desktop");
    const root = join(directory, "runtime");
    const support = join(directory, "support");
    const seed = join(directory, "seed");
    const store = join(home, "desktop-company-cache/installation/store");
    for (const path of [
      profile,
      join(root, "dsh/node_modules/@deepseek-ai"),
      support,
      join(seed, "archives"),
    ])
      await mkdir(path, { recursive: true });
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
    const run = async (cwd, args) =>
      execute(
        process.execPath,
        [
          pnpm,
          ...args,
          "--config.update-notifier=false",
          "--config.manage-package-manager-versions=false",
        ],
        { cwd, env: process.env },
      );
    const old = await Promise.all(
      companyPackageNames.map((name, index) =>
        makeArchive(join(directory, "old"), name, ["0.1.50", "0.6.3-company.46", "0.0.216"][index]),
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
    await run(profile, ["add", ...old.map((row) => row.path), "--offline", "--store-dir=" + store]);
    const previous = new CompanyInstallation(profile, "a".repeat(40));
    await previous.initialize();
    await previous.beginBoot();
    const dependency = await makeArchive(
      join(directory, "dependency"),
      "seed-only-dependency",
      "1.0.0",
    );
    let origin;
    const server = createServer((request, response) => {
      if (request.url === "/dependency.tgz") response.end(dependency.bytes);
      else {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            name: dependency.manifest.name,
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": {
                ...dependency.manifest,
                dist: {
                  tarball: origin + "/dependency.tgz",
                  integrity:
                    "sha512-" + createHash("sha512").update(dependency.bytes).digest("base64"),
                },
              },
            },
          }),
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    origin = "http://127.0.0.1:" + server.address().port;
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
      ...packages.map((row) => join(seed, "archives", row.file)),
      "--registry=" + origin,
      "--store-dir=" + join(seed, "store"),
      "--cache-dir=" + join(seed, "metadata"),
    ]);
    const metadata = join(seed, "metadata/v11/metadata");
    for (const entry of await readdir(metadata))
      await cp(join(metadata, entry), join(metadata, "registry.npmjs.org"), { recursive: true });
    const manifest = { schema: 1, core: { head: "b".repeat(40) }, packages };
    await writeFile(join(seed, "manifest.json"), JSON.stringify(manifest));
    await writeCompanySeedLock({ root, seed, profile: seedProfile });
    await rm(join(seed, "store/v11/projects"), { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
    await writeFile(join(store, "old-store-sentinel"), "retained old store");
    const oldIndex = await readFile(join(store, "v11/index.db"));
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
      const dependencyPath = createRequire(
        join(profile, "node_modules", companyPackageNames[2], "package.json"),
      ).resolve("seed-only-dependency");
      assert.equal(
        JSON.parse(await readFile(join(dirname(dirname(dependencyPath)), "package.json"))).version,
        "1.0.0",
      );
      assert.equal(
        JSON.parse(await readFile(join(profile, "package.json"))).retained,
        "user configuration",
      );
      assert.equal(await readFile(join(store, "old-store-sentinel"), "utf8"), "retained old store");
      assert.deepEqual(await readFile(join(store, "v11/index.db")), oldIndex);
    }
    const caches = await readdir(join(home, "desktop-company-cache"));
    assert(!caches.some((entry) => /^[a-f0-9]{64}$/.test(entry)));
    assert.equal((await readdir(join(home, "desktop-company-cache/seed-stores"))).length, 1);
  },
);
