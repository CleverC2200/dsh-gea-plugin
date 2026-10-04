import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  prepareSourcePlugins,
  readSourceCombination,
} from "../scripts/source-profile.mjs";
import { sourcePlugins } from "../scripts/source-composition.mjs";
const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
  "@changfenhuang/dsh-genui",
  "dsh-better-sidebar",
];

test(
  "the single fixed-source assembler publishes five owners without old preset rewriting or profile writes",
  { timeout: 180000 },
  async (t) => {
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
      if (index === 2) {
        await mkdir(join(source, "scripts"));
        await writeFile(
          join(source, "scripts/deployment.mjs"),
          "export function deploymentPatch(){return [{id:'agent-default-model',config:{provider:'fixture',model:'fixture'}},{id:'gea-proof',config:{analysisMode:'receipt'}}]}\n",
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
      sources.push({
        repo: plugin.repo,
        source,
        commit: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: source,
          encoding: "utf8",
        }).trim(),
      });
    }
    const core = resolve("../../official-latest-standard"),
      runtime = join(root, "own-runtime");
    await mkdir(runtime);
    const composition = await prepareSourcePlugins(core, runtime, undefined, {
      sources,
    });
    assert.deepEqual(Object.keys(composition.dependencies), names);
    assert.deepEqual(new Set(composition.bundles), new Set(names));
    assert.equal(composition.patches.length, 1);
    assert.deepEqual(
      await readSourceCombination(runtime, composition.id, core),
      composition,
    );
    const directory = join(runtime, "source-combinations", composition.id);
    await assert.rejects(access(join(directory, "presets.patch.yml")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(runtime, "home")), { code: "ENOENT" });
    assert.deepEqual(
      JSON.parse(await readFile(composition.profileDefaults, "utf8")),
      [
        {
          id: "agent-default-model",
          config: { provider: "fixture", model: "fixture" },
        },
      ],
    );
    const patch = JSON.parse(await readFile(composition.patches[0], "utf8"));
    assert.equal(
      patch.find((row) => row.id === "agent-preset-registry").config.default,
      "standard",
    );
    assert.ok(!JSON.stringify(composition).includes("dsh-plugin-hub"));
    assert.ok(!JSON.stringify(composition).includes("skill-reference"));
  },
);
