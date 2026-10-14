/** Curate only publication metadata after an owner's normal pack lifecycle. */
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const { values } = parseArgs({
  options: {
    input: { type: "string" },
    versions: { type: "string" },
    destination: { type: "string" },
  },
});
if (!values.input || !values.versions || !values.destination)
  throw Error("COMPANION_PACKAGE_INPUTS_REQUIRED");
const input = resolve(values.input),
  destination = resolve(values.destination);
const files = execFileSync("tar", ["-tzf", input], { encoding: "utf8" }).trim().split("\n");
if (
  files.some(
    (file) =>
      !file.startsWith("package/") ||
      file.split("/").includes("..") ||
      file.includes("/node_modules/"),
  )
)
  throw Error("INVALID_COMPANION_ARCHIVE");
const work = await mkdtemp(join(tmpdir(), "dsh-companion-publication-"));
try {
  execFileSync("tar", ["-xzf", input, "-C", work]);
  const root = join(work, "package"),
    path = join(root, "package.json");
  const excludedProvenanceFiles = [];
  for (const file of files.filter((file) =>
    /^package\/lib\/business\/.+\/build-inputs\.json$/.test(file),
  )) {
    const location = join(work, file);
    excludedProvenanceFiles.push({
      path: file.slice("package/".length),
      sha256: createHash("sha256")
        .update(await readFile(location))
        .digest("hex"),
    });
    await rm(location);
  }
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (!["dsh-agent-manage", "@cleverc2200/dsh-agent-workbench"].includes(manifest.name))
    throw Error("UNEXPECTED_COMPANION_IDENTITY");
  const versions = JSON.parse(await readFile(resolve(values.versions), "utf8"));
  if (!versions[manifest.name]) throw Error("COMPANION_VERSION_REQUIRED");
  if (manifest.version !== versions[manifest.name])
    throw Error("COMPILED_PACKAGE_VERSION_MISMATCH");
  for (const key of ["devDependencies", "scripts", "workspaces", "packageManager", "pnpm"])
    delete manifest[key];
  if (/(?:link:|file:|\/Users\/)/.test(JSON.stringify(manifest)))
    throw Error("SOURCE_LINK_IN_COMPANION");
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  await mkdir(destination, { recursive: true });
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const artifact = join(destination, packed.filename);
  const receipt = {
    name: manifest.name,
    version: manifest.version,
    artifact,
    sourceArchive: input,
    sourceArchiveSha256: createHash("sha256")
      .update(await readFile(input))
      .digest("hex"),
    sha256: createHash("sha256")
      .update(await readFile(artifact))
      .digest("hex"),
    changedFields: ["development-only metadata"],
    excludedProvenanceFiles,
    originalLifecycleAlreadyCompleted: true,
  };
  await writeFile(artifact + ".json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {
  await rm(work, { recursive: true, force: true });
}
