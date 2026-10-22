import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { t as readTar } from "tar";
import { join, resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { assertHtmlMcp } from "../src/capability/html-mcp.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code) => {
  throw Error(code);
};
const absolute = (path) =>
  typeof path === "string" && isAbsolute(path) ? path : fail("DELIVERY_ABSOLUTE_PATH_REQUIRED");
const within = (root, path) => {
  const value = relative(root, path);
  return value !== ".." && !value.startsWith("../") && !isAbsolute(value);
};
const runtimeExport = (value) =>
  typeof value === "string" ? value : (value?.default ?? value?.import ?? value?.require);
export function sourceChanges(path) {
  const fields = execFileSync(
    "git",
    ["-C", path, "status", "--porcelain=v1", "--untracked-files=all", "-z"],
    { encoding: "utf8" },
  ).split("\0");
  const changes = [];
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index];
    if (!entry) continue;
    const paths = [entry.slice(3)];
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(fields[++index]);
    if (paths.some((file) => !/^(?:lib\/|client\/)/.test(file))) changes.push(entry);
  }
  return changes;
}

export async function verifyPackageBuild({ path, head, buildReceipt, lock }) {
  const lockBytes = await readFile(join(path, lock));
  if (
    digest(lockBytes) !==
    digest(
      execFileSync("git", ["-C", path, "show", `HEAD:${lock}`], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    )
  )
    fail("DELIVERY_SOURCE_LOCK_MISMATCH");
  const buildPath = absolute(buildReceipt),
    build = JSON.parse(await readFile(buildPath, "utf8"));
  if (
    build.exitCode !== 0 ||
    build.sourceHead !== head ||
    build.lockSha256 !== digest(lockBytes) ||
    !build.command?.file ||
    !Array.isArray(build.command.args) ||
    (await realpath(absolute(build.command.cwd))) !== path ||
    !Array.isArray(build.outputs) ||
    !build.outputs.length
  )
    fail("DELIVERY_BUILD_RECEIPT_INVALID");
  for (const output of build.outputs) {
    if (
      typeof output.path !== "string" ||
      isAbsolute(output.path) ||
      !within(path, resolve(path, output.path)) ||
      digest(await readFile(join(path, output.path))) !== output.sha256
    )
      fail("DELIVERY_BUILD_OUTPUT_MISMATCH");
  }
  return {
    outputs: build.outputs,
    lockSha256: digest(lockBytes),
    buildReceiptSha256: digest(await readFile(buildPath)),
  };
}
export function builtArchive(path, manifest, outputs) {
  for (const key of [".", "./client"]) {
    const target = runtimeExport(manifest.exports[key]).slice(2);
    if (!outputs.some((output) => output.path === target)) fail("DELIVERY_BUILD_RECEIPT_INVALID");
  }
  const pending = new Map(outputs.map((output) => [`package/${output.path}`, output.sha256]));
  const seen = new Set();
  let failure;
  readTar({
    file: path,
    sync: true,
    strict: true,
    onReadEntry(entry) {
      if (entry.type !== "File" && entry.type !== "Directory") failure = "DELIVERY_ARCHIVE_INVALID";
      if (!pending.has(entry.path)) return;
      if (seen.has(entry.path)) failure = "DELIVERY_ARCHIVE_INVALID";
      seen.add(entry.path);
      if (entry.type !== "File") return;
      const hash = createHash("sha256");
      entry.on("data", (bytes) => hash.update(bytes));
      entry.on("end", () => {
        if (hash.digest("hex") !== pending.get(entry.path))
          failure ??= "DELIVERY_STALE_BUILD_ARCHIVE";
      });
    },
  });
  if (failure) fail(failure);
  if (seen.size !== pending.size) fail("DELIVERY_BUILD_OUTPUT_MISSING_IN_ARCHIVE");
}

export async function verifyHtmlCapabilities(path, outputs) {
  const names = new Set(outputs.map((output) => output.path));
  for (const output of outputs.filter((output) => output.path.endsWith("/plugin.json"))) {
    try {
      const manifest = JSON.parse(await readFile(join(path, output.path), "utf8"));
      if (!manifest.gea) continue;
      const directory = dirname(output.path);
      const mcpFile = relative(path, resolve(path, directory, manifest.mcp))
        .split(sep)
        .join("/");
      if (!within(join(path, directory), resolve(path, mcpFile)) || !names.has(mcpFile))
        fail("DELIVERY_HTML_CAPABILITY_INVALID");
      const mcp = JSON.parse(await readFile(join(path, mcpFile), "utf8"));
      assertHtmlMcp(mcp, manifest.gea.consumerCode, manifest.mode === "mock");
    } catch {
      throw Object.assign(Error("DELIVERY_HTML_CAPABILITY_INVALID"), {
        delivery: { file: output.path },
      });
    }
  }
}
