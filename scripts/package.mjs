/** Create a local release tarball from an explicit allowlist, excluding credentials and machine state. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, ".runtime/packages");
await mkdir(destination, { recursive: true, mode: 0o700 });
const manifest = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const allowed = new Set([
  "package.json",
  "npm-shrinkwrap.json",
  "LICENSE",
  ...manifest.files.filter((x) => !x.endsWith("/")),
  "presets/gea-readonly/preset.yml",
  "presets/gea-readonly/agent.cordis.yml",
]);
const [preview] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
  }),
);
for (const file of preview.files) {
  if (!allowed.has(file.path) && !/^packages\/agent-workbench\/lib\/types\/[A-Za-z-]+\.d\.ts$/.test(file.path))
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
};
await writeFile(artifact + ".json", JSON.stringify(receipt, null, 2) + "\n", {
  mode: 0o600,
});
console.log(JSON.stringify({ artifact, sha256, files: receipt.files.length }));
