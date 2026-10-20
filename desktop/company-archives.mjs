import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

const genui = "@changfenhuang/dsh-genui";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function cacheArchive(home, file, bytes) {
  let directory = home;
  for (const part of ["desktop-company-cache", "archives", hash(bytes)]) {
    directory = join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("GEA_ARCHIVE_CACHE_UNSAFE");
  }
  const target = join(directory, file);
  const entry = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (entry) {
    if (!entry.isFile() || entry.isSymbolicLink() || !(await readFile(target)).equals(bytes))
      throw Error("GEA_ARCHIVE_CACHE_CHANGED");
  } else await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  return target;
}

function releaseIndex(name, version) {
  const expression =
    name === "dsh-agent-manage"
      ? /^0\.6\.3-company\.(\d+)$/
      : name.endsWith("dsh-agent-workbench")
        ? /^0\.1\.(\d+)$/
        : /^0\.0\.(\d+)$/;
  const match = expression.exec(version);
  if (!match) throw Error("GEA_LEGACY_ARCHIVE_VERSION_UNSUPPORTED");
  return BigInt(match[1]);
}

export async function prepareCompanyArchives({ root, seed, home, profile, packages }) {
  const manifest = JSON.parse(await readFile(join(seed, "manifest.json"), "utf8"));
  const bundled = new Map();
  for (const row of manifest.packages) {
    if (basename(row.file) !== row.file || !row.file.endsWith(".tgz"))
      throw Error("GEA_SEED_INVALID");
    const bytes = await readFile(join(seed, "archives", row.file));
    if (hash(bytes) !== row.sha256) throw Error("GEA_SEED_ARCHIVE_CHANGED");
    bundled.set(row.name, {
      ...row,
      path: await cacheArchive(home, row.file, bytes),
    });
  }
  const requested = packages.map((path) => {
    const row = [...bundled.values()].find(
      (row) => resolve(seed, "archives", row.file) === resolve(path),
    );
    if (!row) throw Error("GEA_INSTALL_ARCHIVE_NOT_BUNDLED");
    return row.path;
  });
  const current = await readFile(join(profile, "package.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return {};
      throw error;
    });
  const replacements = [];
  for (const [name, spec] of Object.entries(current.dependencies ?? {})) {
    if (!bundled.has(name) && name !== genui) continue;
    if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
    const source = spec.slice(5);
    const file = source.replaceAll("\\", "/").split("/").at(-1);
    if (!source.replaceAll("\\", "/").includes("/company-seed/archives/")) continue;
    const installed = JSON.parse(
      await readFile(join(profile, "node_modules", name, "package.json"), "utf8"),
    );
    const prefix = name === genui ? "dsh-genui" : name.replace(/^@/, "").replace("/", "-");
    const expected = prefix + "-" + installed.version + ".tgz";
    if (installed.name !== name || file !== expected)
      throw Error("GEA_LEGACY_ARCHIVE_IDENTITY_CHANGED");
    const entry = await lstat(join(profile, "node_modules", name));
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("GEA_LEGACY_ARCHIVE_LINKED");
    let path;
    let version = installed.version;
    const row = bundled.get(name);
    if (row) {
      if (releaseIndex(name, installed.version) > releaseIndex(name, row.version))
        throw Error("GEA_LEGACY_ARCHIVE_DOWNGRADE_REJECTED");
      path = row.path;
      version = row.version;
    } else {
      if (installed.version !== "0.11.3") throw Error("GEA_LEGACY_ARCHIVE_VERSION_UNSUPPORTED");
      const require = createRequire(join(root, "dsh/package.json"));
      const lock = require("yaml").parse(await readFile(join(profile, "pnpm-lock.yaml"), "utf8"));
      const importer = lock.importers?.["."]?.dependencies?.[name];
      const resolutions = Object.entries(lock.packages ?? {}).filter(
        ([key, value]) =>
          key.startsWith(name + "@file:") &&
          typeof value.resolution?.tarball === "string" &&
          resolve(profile, value.resolution.tarball.slice(5)) === resolve(profile, source),
      );
      if (importer?.specifier !== spec || resolutions.length !== 1)
        throw Error("GEA_LEGACY_ARCHIVE_LOCK_MISMATCH");
      const integrity = resolutions[0][1].resolution.integrity;
      if (typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity))
        throw Error("GEA_LEGACY_ARCHIVE_INTEGRITY_MISSING");
      let bytes = await readFile(source).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!bytes) {
        const response = await fetch(
          "https://registry.npmjs.org/@changfenhuang/dsh-genui/-/dsh-genui-0.11.3.tgz",
          { signal: AbortSignal.timeout(30000), redirect: "error" },
        );
        if (!response.ok) throw Error("GEA_LEGACY_ARCHIVE_DOWNLOAD_FAILED");
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024) throw Error("GEA_LEGACY_ARCHIVE_TOO_LARGE");
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      }
      if ("sha512-" + createHash("sha512").update(bytes).digest("base64") !== integrity)
        throw Error("GEA_LEGACY_ARCHIVE_INTEGRITY_CHANGED");
      path = await cacheArchive(home, file, bytes);
    }
    replacements.push({ name, before: spec, path, version });
    if (!requested.includes(path)) requested.push(path);
  }
  return { packages: requested, replacements };
}

export async function repointCompanyArchives({ root, profile, replacements, writeFileAtomic }) {
  if (!replacements.length) return;
  const manifest = JSON.parse(await readFile(join(profile, "package.json"), "utf8"));
  const require = createRequire(join(root, "dsh/package.json"));
  const YAML = require("yaml");
  const lock = YAML.parse(await readFile(join(profile, "pnpm-lock.yaml"), "utf8"));
  for (const row of replacements) {
    if (
      manifest.dependencies?.[row.name] !== row.before ||
      lock.importers?.["."]?.dependencies?.[row.name]?.specifier !== row.before
    )
      throw Error("GEA_LEGACY_ARCHIVE_LOCK_MISMATCH");
    manifest.dependencies[row.name] = "file:" + row.path.replaceAll("\\", "/");
    delete lock.importers["."].dependencies[row.name];
  }
  for (const section of ["packages", "snapshots"])
    for (const key of Object.keys(lock[section] ?? {}))
      if (replacements.some((row) => key.startsWith(row.name + "@file:")))
        delete lock[section][key];
  await writeFileAtomic(join(profile, "package.json"), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  await writeFileAtomic(join(profile, "pnpm-lock.yaml"), YAML.stringify(lock), { mode: 0o600 });
}
