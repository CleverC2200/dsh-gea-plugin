import fs from "node:fs";
import { join, resolve, relative, isAbsolute, dirname, basename, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { managedPackages } from "./development-repositories.mjs";
import { verifyPackageBuild, sourceChanges, builtArchive } from "./package-source-integrity.mjs";
import { withBuildAdmission } from "./build-admission.mjs";
import { digest, json } from "./development-dependencies.mjs";

const inside = (root, path) => {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep));
};
export async function packRaw({ input, repo, destination }) {
  if (
    !["dsh-agent-workbench", "dsh-agent-manage"].includes(repo) ||
    !isAbsolute(input ?? "") ||
    !isAbsolute(destination ?? "")
  )
    throw Error("RAW_PACKAGE_EXPLICIT_INPUT_REQUIRED");
  destination = fs.existsSync(destination)
    ? fs.realpathSync(destination)
    : join(fs.realpathSync(dirname(destination)), basename(destination));
  const request = json(input);
  const rows = request.repositories?.filter((row) => row.repo === repo);
  if (rows?.length !== 1) throw Error("RAW_PACKAGE_OWNER_REQUIRED");
  const owner = rows[0];
  if (!isAbsolute(owner.path ?? "")) throw Error("RAW_PACKAGE_OWNER_REQUIRED");
  const root = fs.realpathSync(owner.path);
  const manifest = json(join(root, "package.json"));
  if (
    manifest.name !== managedPackages[repo] ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length
  )
    throw Error("RAW_PACKAGE_IDENTITY_MISMATCH");
  if (
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !==
      owner.head ||
    sourceChanges(root).length
  )
    throw Error("RAW_PACKAGE_SOURCE_MISMATCH");
  if (inside(root, destination)) throw Error("RAW_PACKAGE_DESTINATION_OVERLAP");
  if (fs.existsSync(destination)) throw Error("RAW_PACKAGE_DESTINATION_EXISTS");
  const lock = repo === "dsh-agent-workbench" ? "package-lock.json" : "pnpm-lock.yaml";
  const build = await verifyPackageBuild({ ...owner, path: root, lock });
  for (const key of [".", "./client"]) {
    const item = manifest.exports?.[key];
    const path = typeof item === "string" ? item : (item?.default ?? item?.import ?? item?.require);
    if (!path?.startsWith("./") || !build.outputs.some((output) => output.path === path.slice(2)))
      throw Error("RAW_PACKAGE_BUILD_INCOMPLETE");
  }
  return withBuildAdmission({ operation: "package", cwd: root, output: destination }, async () => {
    const pack = (args) =>
      JSON.parse(
        execFileSync(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["pack", "--ignore-scripts", "--json", ...args],
          {
            cwd: root,
            encoding: "utf8",
            shell: process.platform === "win32",
            maxBuffer: 32 * 1024 ** 2,
          },
        ),
      )[0];
    const preview = pack(["--dry-run"]);
    const allowed = (file) =>
      /^(?:package\.json|(?:README|LICEN[CS]E|COPYING)(?:\.[^/]*)?)$/i.test(file) ||
      manifest.files.some((entry) => {
        const path = entry.replace(/^\.\//, "").replace(/\/$/, "");
        return !path.includes("*") && (file === path || file.startsWith(path + "/"));
      });
    if (
      preview.name !== manifest.name ||
      preview.files.some(
        ({ path }) =>
          !allowed(path) ||
          path.split("/").some((part) => part.startsWith(".") || part === "node_modules"),
      )
    )
      throw Error("RAW_PACKAGE_FILE_FORBIDDEN");
    if (
      build.outputs.some((file) => !preview.files.some((entry) => entry.path === file.path)) ||
      preview.files.some((file) => !inside(root, fs.realpathSync(join(root, file.path))))
    )
      throw Error("RAW_PACKAGE_BUILD_INCOMPLETE");
    fs.mkdirSync(destination);
    const packed = pack(["--pack-destination", destination]);
    const artifact = join(destination, packed.filename);
    if (
      JSON.stringify(packed.files.map((file) => file.path)) !==
      JSON.stringify(preview.files.map((file) => file.path))
    )
      throw Error("RAW_PACKAGE_FILES_CHANGED");
    builtArchive(artifact, manifest, build.outputs);
    if (sourceChanges(root).length) throw Error("RAW_PACKAGE_SOURCE_MISMATCH");
    const receipt = {
      status: "packaged",
      repo,
      sourceHead: owner.head,
      artifact,
      sha256: digest(fs.readFileSync(artifact)),
      buildReceiptSha256: build.buildReceiptSha256,
      files: packed.files.map((file) => file.path),
    };
    fs.writeFileSync(artifact + ".json", JSON.stringify(receipt, null, 2) + "\n");
    return receipt;
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      repo: { type: "string" },
      destination: { type: "string" },
    },
  });
  try {
    console.log(JSON.stringify(await packRaw(values)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
