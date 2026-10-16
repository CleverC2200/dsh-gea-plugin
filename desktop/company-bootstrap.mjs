import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
  "@changfenhuang/dsh-genui",
];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function readCompanySeed(seed) {
  const manifest = await json(join(seed, "manifest.json"));
  if (
    manifest.schema !== 1 ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length !== names.length
  )
    throw Error("GEA_SEED_INVALID");
  for (const [index, row] of manifest.packages.entries()) {
    if (
      row.name !== names[index] ||
      typeof row.version !== "string" ||
      !row.version ||
      typeof row.file !== "string" ||
      basename(row.file) !== row.file ||
      !row.file.endsWith(".tgz") ||
      !/^[a-f0-9]{64}$/.test(row.sha256)
    )
      throw Error("GEA_SEED_INVALID");
    if (digest(await readFile(join(seed, "archives", row.file))) !== row.sha256)
      throw Error("GEA_SEED_ARCHIVE_CHANGED");
  }
  return manifest;
}

export async function installCompanyPackages({
  root,
  support,
  home,
  profile,
  packages,
  store,
  offline,
}) {
  const anchor = join(root, "dsh/node_modules/@deepseek-ai/dsh/package.json");
  const require = createRequire(anchor);
  const boot = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-app-boot"))
  );
  const { runProfilePnpm } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-plugin-manager/operations"))
  );
  const { withFileLock } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-atomic-write"))
  );
  boot.initProfile(profile, boot.PROFILE_TEMPLATES.web.bundles);
  const result = await withFileLock(
    join(profile, "package.json"),
    () =>
      runProfilePnpm(
        {
          profile: "desktop",
          dir: profile,
          home,
          cwd: profile,
          installAnchor: anchor,
        },
        [
          "add",
          ...packages,
          ...(offline ? ["--offline"] : []),
          "--registry=https://registry.npmjs.org",
          "--store-dir=" + store,
          "--config.cache-dir=" +
            join(home, "desktop-company-cache", "metadata"),
        ],
        {
          execution: "service",
          command: process.execPath,
          args: ["--expose-internals", join(support, "pnpm/bin/pnpm.mjs")],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
            DSH_HOME: home,
            PATH: join(support, "bin") + delimiter + (process.env.PATH ?? ""),
          },
          outputBytes: 16000,
          idleTimeoutMs: 120000,
          lookupTimeoutMs: 30000,
        },
      ),
    { waitMs: 120000 },
  );
  if (result.exitCode !== 0)
    throw Error("GEA_COMPANY_INSTALL_FAILED: " + result.logPath);
  return result;
}

export async function bootstrapCompanyProfile({ root, support, seed, home }) {
  const profile = join(home, "profiles/desktop");
  const current = existsSync(join(profile, "package.json"))
    ? await json(join(profile, "package.json"))
    : undefined;
  let missing = names.filter((name) => !current?.dependencies?.[name]);
  if (!missing.length)
    return { status: "existing-profile-preserved", changed: false };
  const manifest = await readCompanySeed(seed);
  const app = await json(join(root, "package.json"));
  if (
    app.dshBuildCommit !== manifest.core.head ||
    app.version !== manifest.core.version ||
    app.dshBuildDirty !== false
  )
    throw Error("GEA_SEED_CORE_MISMATCH");
  for (const artifact of manifest.core.artifacts) {
    if (digest(await readFile(join(root, artifact.path))) !== artifact.sha256)
      throw Error("GEA_SEED_CORE_CHANGED");
  }
  const record = join(profile, "gea/bootstrap");
  await mkdir(record, { recursive: true, mode: 0o700 });
  const requireLock = createRequire(join(root, "dsh/package.json"));
  const { withFileLock } = await import(
    pathToFileURL(requireLock.resolve("@deepseek-ai/dsh-atomic-write"))
  );
  return withFileLock(
    join(record, "installation"),
    async () => {
      const latest = existsSync(join(profile, "package.json"))
        ? await json(join(profile, "package.json"))
        : undefined;
      missing = names.filter((name) => !latest?.dependencies?.[name]);
      if (!missing.length)
        return { status: "existing-profile-preserved", changed: false };
      for (const file of [
        "package.json",
        "cordis.patch.yml",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
      ]) {
        if (
          existsSync(join(profile, file)) &&
          !existsSync(join(record, "before-" + file))
        )
          await cp(join(profile, file), join(record, "before-" + file), {
            errorOnExist: true,
            force: false,
          });
      }
      const store = join(
        home,
        "desktop-company-cache",
        digest(Buffer.from(JSON.stringify(manifest.packages))),
        "store",
      );
      if (!existsSync(store))
        await cp(join(seed, "store"), store, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      const metadata = join(home, "desktop-company-cache/metadata");
      if (!existsSync(metadata))
        await cp(join(seed, "metadata"), metadata, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      await writeFile(
        join(record, "receipt.json"),
        JSON.stringify({ status: "installing", packages: missing }) + "\n",
        { mode: 0o600 },
      );
      try {
        const selected = manifest.packages.filter((row) =>
          missing.includes(row.name),
        );
        await installCompanyPackages({
          root,
          support,
          home,
          profile,
          packages: selected.map((row) => join(seed, "archives", row.file)),
          store,
          offline: true,
        });
        const installed = await json(join(profile, "package.json"));
        for (const row of selected) {
          const actual = await json(
            join(profile, "node_modules", row.name, "package.json"),
          );
          if (
            actual.version !== row.version ||
            !installed.dsh?.profile?.bundles?.includes(row.name)
          )
            throw Error("GEA_COMPANY_ACTIVATION_INCOMPLETE");
        }
        if (missing.includes("@cleverc2200/gea-dsh-prototype")) {
          const require = createRequire(join(root, "dsh/package.json"));
          const YAML = require("yaml");
          const patch = join(profile, "cordis.patch.yml");
          const document = YAML.parseDocument(await readFile(patch, "utf8"));
          if (document.errors.length || !Array.isArray(document.toJS()))
            throw Error("GEA_PROFILE_PATCH_INVALID");
          const rows = document.toJS();
          const index = rows.findIndex(
            (row) =>
              row?.id === "gea-proof" ||
              row?.name === "@cleverc2200/gea-dsh-prototype",
          );
          if (index === -1)
            document.add({
              id: "gea-proof",
              config: {
                pluginUpdates: {
                  source: manifest.source,
                  core: { ...manifest.core, root, kind: "desktop" },
                },
              },
            });
          else if (!rows[index].config?.pluginUpdates)
            document.setIn([index, "config", "pluginUpdates"], {
              source: manifest.source,
              core: { ...manifest.core, root, kind: "desktop" },
            });
          await writeFile(patch, document.toString(), { mode: 0o600 });
        }
        const result = {
          status: "installed",
          changed: true,
          packages: selected.map(({ name, version }) => ({ name, version })),
        };
        await writeFile(
          join(record, "receipt.json"),
          JSON.stringify(result, null, 2) + "\n",
          { mode: 0o600 },
        );
        return result;
      } catch (error) {
        await writeFile(
          join(record, "receipt.json"),
          JSON.stringify({ status: "failed", diagnostic: error.message }) +
            "\n",
          { mode: 0o600 },
        );
        throw error;
      }
    },
    { waitMs: 120000 },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [root, support, seed] = process.argv.slice(2);
  const require = createRequire(join(root, "dsh/package.json"));
  const { resolveDshHome } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-home-paths"))
  );
  await bootstrapCompanyProfile({
    root,
    support,
    seed,
    home: resolveDshHome(),
  });
}
