import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readDesktopInput, resolveDesktopAcceptanceSource } from "./input.mjs";

export async function readDesktopAcceptanceInput(
  file,
  { sourceSha, qualifiedSourceSha, checkout },
) {
  const source = resolveDesktopAcceptanceSource(sourceSha, qualifiedSourceSha, checkout);
  if (source === sourceSha) return readDesktopInput(file, source);
  const directory = await mkdtemp(join(tmpdir(), "gea-archive-input-"));
  try {
    let contract;
    try {
      for (const name of [
        "package.json",
        "scripts/windows-complete-local/input.mjs",
        "scripts/ci-core-policy.mjs",
        "scripts/ci-core-policy.json",
        "scripts/supported-cores.json",
        "scripts/mac-complete-local/baseline.mjs",
        "src/shared/plugin-release.mjs",
      ]) {
        const bytes = execFileSync("git", ["show", `${source}:${name}`], {
          cwd: checkout,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
        await mkdir(dirname(join(directory, name)), { recursive: true });
        await writeFile(join(directory, name), bytes);
      }
      const original = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      const semverManifest = createRequire(import.meta.url).resolve("semver/package.json");
      const installed = JSON.parse(await readFile(semverManifest, "utf8"));
      if (original.dependencies?.semver !== installed.version)
        throw Error("DESKTOP_ARCHIVE_DEPENDENCY_MISMATCH: semver");
      await mkdir(join(directory, "node_modules"));
      await symlink(dirname(semverManifest), join(directory, "node_modules/semver"), "junction");
      contract = await import(
        pathToFileURL(join(directory, "scripts/windows-complete-local/input.mjs")).href
      );
      if (typeof contract.readDesktopInput !== "function") throw Error("input reader missing");
    } catch (error) {
      throw new Error("DESKTOP_ARCHIVE_CONTRACT_REQUIRED: " + error.message, { cause: error });
    }
    return await contract.readDesktopInput(file, source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
