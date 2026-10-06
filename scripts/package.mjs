/** Create a local release tarball from an explicit allowlist, excluding credentials and machine state. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { input: { type: 'string' }, destination: { type: 'string' } } });
if (!values.input) throw Error('PRODUCTION_PACKAGE_INPUT_REQUIRED');
const root = resolve(values.input);
const destination = resolve(values.destination ?? resolve(import.meta.dirname, '../.runtime/packages'));
await mkdir(destination, { recursive: true, mode: 0o700 });
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const lock = JSON.parse(await readFile(resolve(root, 'npm-shrinkwrap.json'), 'utf8'));
if (manifest.name !== '@cleverc2200/gea-dsh-prototype' || lock.name !== manifest.name || lock.version !== manifest.version || lock.lockfileVersion !== 3) throw Error('PRODUCTION_PACKAGE_LOCK_MISMATCH');
const lockRoot = lock.packages?.[''];
for (const field of ['dependencies', 'peerDependencies'])
  if (JSON.stringify(Object.entries(lockRoot?.[field] ?? {}).sort()) !== JSON.stringify(Object.entries(manifest[field] ?? {}).sort())) throw Error('PRODUCTION_PACKAGE_LOCK_MISMATCH: ' + field);
if (manifest.devDependencies || manifest.scripts || /(?:link:|file:|\/Users\/|git\+|\.git#)/.test(JSON.stringify({ dependencies: manifest.dependencies, peerDependencies: manifest.peerDependencies, lock }))) throw Error('SOURCE_DEPENDENCY_IN_PACKAGE');
const allowed = new Set(['package.json', 'npm-shrinkwrap.json', 'LICENSE']);
async function include(path) {
  if (path.startsWith('/') || path.split('/').some(part => part === '..' || part === 'node_modules' || part.startsWith('.'))) throw Error('INVALID_PACKAGE_PATH: ' + path);
  const location = resolve(root, path);
  const stat = await lstat(location);
  if (stat.isSymbolicLink()) throw Error('PACKAGE_SYMLINK: ' + path);
  if (stat.isDirectory()) {
    for (const child of await readdir(location)) await include(path.replace(/\/$/, '') + '/' + child);
  } else if (stat.isFile()) allowed.add(path);
}
for (const file of manifest.files) await include(file);
const [preview] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  }),
);
for (const file of preview.files) {
  if (!allowed.has(file.path))
    throw Error("UNEXPECTED_PACKAGE_FILE: " + file.path);
  const content = await readFile(resolve(root, file.path), "utf8");
  if (/\/Users\/|Bearer [A-Za-z0-9_-]{20,}|[?&](?:token|auth)=/i.test(content))
    throw Error("LOCAL_STATE_IN_PACKAGE: " + file.path);
}
for (const file of allowed)
  if (!preview.files.some((x) => x.path === file))
    throw Error("MISSING_PACKAGE_FILE: " + file);
const [packed] = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    { cwd: root, encoding: "utf8" },
  ),
);
const artifact = resolve(destination, packed.filename);
const sha256 = createHash("sha256")
  .update(await readFile(artifact))
  .digest("hex");
const receipt = {
  version: manifest.version,
  filename: packed.filename,
  sha256,
  files: packed.files.map((x) => x.path),
  runtimeDependencies: manifest.dependencies,
  providedPeers: manifest.peerDependencies,
  shrinkwrapSha256: createHash('sha256').update(await readFile(resolve(root, 'npm-shrinkwrap.json'))).digest('hex'),
};
await writeFile(artifact + ".json", JSON.stringify(receipt, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify({ artifact, sha256, files: receipt.files.length }));
