/** Isolated published-source fixtures for the public source assembler. */
import assert from "node:assert/strict";
import {
  mkdtemp, mkdir, writeFile, readFile, realpath, rm, access, cp, readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { sourcePlugins } from "../../scripts/source-composition.mjs";
export const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
  "@changfenhuang/dsh-genui",
  "dsh-better-sidebar",
];
export async function sourceAssemblyFixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "source-assembly-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [];
  for (const [index, plugin] of sourcePlugins.entries()) {
    const source = join(root, plugin.repo);
    await mkdir(join(source, "lib"), { recursive: true });
    await mkdir(join(source, "node_modules"));
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: names[index],
        version: "1.0.0",
        type: "module",
        main: "lib/host.js",
        exports: {
          ".": "./lib/host.js",
          "./client": "./lib/client.js",
          "./package.json": "./package.json",
        },
      }),
    );
    await writeFile(
      join(source, "lib/host.js"),
      "export function apply() {}\n",
    );
    await writeFile(
      join(source, "lib/client.js"),
      "export function apply() {}\n",
    );
    await writeFile(join(source, "cordis.patch.yml"), "- insert: []\n");
    for (const file of plugin.digests) {
      await mkdir(resolve(source, file, ".."), { recursive: true });
      await writeFile(join(source, file), "original fixture input\n");
    }
    await writeFile(
      join(source, "pnpm-lock.yaml"),
      "source-only locked dependency input\n",
    );
    if (index === 2) {
      await mkdir(join(source, "scripts"));
      await writeFile(
        join(source, "scripts/deployment.mjs"),
        "export function businessDeploymentPatch(){return [{id:'agent-default-model',config:{provider:'fixture',model:'fixture'}},{id:'gea-proof',config:{analysisMode:'receipt'}}]}\n",
      );
    }
    execFileSync("git", ["init", "-q"], { cwd: source });
    execFileSync(
      "git",
      ["remote", "add", "source", "https://example.invalid/" + plugin.repo],
      { cwd: source },
    );
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixed source",
      ],
      { cwd: source },
    );
    const assets = join(root, "published-assets", plugin.repo);
    await mkdir(assets, { recursive: true });
    for (const file of plugin.resources.filter(
      (file) => file !== "pnpm-lock.yaml",
    )) {
      try {
        await cp(join(source, file), join(assets, file), { recursive: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const files = {};
    async function hashes(directory, prefix = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(prefix, entry.name),
          absolute = join(directory, entry.name);
        if (entry.isDirectory()) await hashes(absolute, file);
        else
          files[file] = createHash("sha256")
            .update(await readFile(absolute))
            .digest("hex");
      }
    }
    await hashes(assets);
    await assert.rejects(access(join(assets, "pnpm-lock.yaml")), {
      code: "ENOENT",
    });
    sources.push({
      repo: plugin.repo,
      source,
      assets,
      files,
      dependencies: join(source, "node_modules"),
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
    });
  }
  return { root, sources };
}
