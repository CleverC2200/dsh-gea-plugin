import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { prepareSourcePlugins } from "../scripts/source-profile.mjs";
await mkdir(".scratch", { recursive: true });
test("a new composition without explicit five-source records refuses before reading SDK paths or creating runtime state", async (t) => {
  const dir = await mkdtemp(resolve(".scratch/explicit-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = join(dir, "runtime");
  await assert.rejects(
    prepareSourcePlugins(join(dir, "SDK-must-not-be-read"), runtime, undefined),
    /EXPLICIT_SOURCE_INPUTS_REQUIRED/,
  );
  await assert.rejects(access(runtime), { code: "ENOENT" });
});

import { writeFile, readFile, cp, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { checkSourcePlugins } from "../scripts/check-source-plugins.mjs";
import { sourcePlugins } from "../scripts/source-composition.mjs";
import { runSourceProfile } from "../scripts/start-isolated-validation.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const dir = await mkdtemp(resolve(".scratch/explicit-inputs-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = [];
  const packageNames = [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
    "@changfenhuang/dsh-genui",
    "dsh-better-sidebar",
  ];
  for (const [index, plugin] of sourcePlugins.entries()) {
    const source = join(dir, plugin.repo),
      assets = join(dir, "assets", plugin.repo);
    await mkdir(join(source, "lib"), { recursive: true });
    await mkdir(join(source, "node_modules/typescript/bin"), {
      recursive: true,
    });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: packageNames[index],
        version: "1.0.0",
        main: "lib/host.js",
        exports: { ".": "./lib/host.js", "./client": "./lib/client.js" },
      }),
    );
    await writeFile(join(source, "lib/host.js"), "export function apply(){}\n");
    await writeFile(
      join(source, "lib/client.js"),
      "export function apply(){}\n",
    );
    await writeFile(join(source, "cordis.patch.yml"), "- insert: []\n");
    for (const file of plugin.digests) {
      await mkdir(resolve(source, file, ".."), { recursive: true });
      await writeFile(join(source, file), "source fixed input\n");
    }
    await writeFile(
      join(source, ".gitignore"),
      "node_modules/\ncompiler-ran.txt\nbuilder-ran.txt\n",
    );
    await mkdir(join(source, "scripts"), { recursive: true });
    await writeFile(
      join(source, "scripts/build.mjs"),
      "import{appendFileSync}from'node:fs';appendFileSync('builder-ran.txt',process.env.DSH_TYPECHECK_PROJECT+'\\n');",
    );
    await writeFile(join(source, "tsconfig.json"), "{}\n");
    await writeFile(join(source, "tsconfig.client.json"), "{}\n");
    await writeFile(
      join(source, "node_modules/typescript/bin/tsc"),
      `require('node:fs').appendFileSync('compiler-ran.txt',process.argv.join(' ')+'\\n')`,
    );
    execFileSync("git", ["init", "-q"], { cwd: source });
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
    await mkdir(assets, { recursive: true });
    for (const file of [
      "package.json",
      "lib",
      "cordis.patch.yml",
      ...plugin.digests,
    ]) {
      await mkdir(resolve(assets, file, ".."), { recursive: true });
      await cp(join(source, file), join(assets, file), { recursive: true });
    }
    const files = {};
    async function scan(path, prefix = "") {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) await scan(join(path, entry.name), file);
        else files[file] = hash(await readFile(join(path, entry.name)));
      }
    }
    await scan(assets);
    records.push({
      repo: plugin.repo,
      source,
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: source,
        encoding: "utf8",
      }).trim(),
      assets,
      files,
    });
  }
  return { dir, records };
}
test("frozen five-source assets are verified and reused for both check and build; corrupted bytes fail before output/compiler writes", async (t) => {
  const { dir, records } = await fixture(t);
  const core = resolve("../../official-latest-standard");
  await checkSourcePlugins({
    sources: records,
    core,
    output: join(dir, "check-output"),
  });
  await checkSourcePlugins({
    sources: records,
    core,
    build: true,
    output: join(dir, "build-output"),
  });
  for (const record of records)
    await assert.rejects(access(join(record.source, "compiler-ran.txt")), {
      code: "ENOENT",
    });
  const damaged = join(records[3].assets, "lib/client.js");
  await writeFile(damaged, "damaged original asset\n");
  await assert.rejects(
    checkSourcePlugins({
      sources: records,
      core,
      build: true,
      output: join(dir, "damage-output"),
    }),
    /SOURCE_ASSET_DIGEST_MISMATCH/,
  );
  await assert.rejects(access(join(dir, "damage-output")), { code: "ENOENT" });
  assert.equal(await readFile(damaged, "utf8"), "damaged original asset\n");
  for (const record of records)
    await assert.rejects(access(join(record.source, "compiler-ran.txt")), {
      code: "ENOENT",
    });
});
test("ordinary declared source still runs its original TypeScript checks while frozen siblings stay untouched", async (t) => {
  const { dir, records } = await fixture(t);
  delete records[0].assets;
  delete records[0].files;
  await checkSourcePlugins({
    sources: records,
    core: resolve("../../official-latest-standard"),
    output: join(dir, "normal-output"),
  });
  assert.match(
    await readFile(join(records[0].source, "compiler-ran.txt"), "utf8"),
    /-p .*dsh-agent-workbench-tsconfig.json/,
  );
  await checkSourcePlugins({
    sources: records,
    core: resolve("../../official-latest-standard"),
    build: true,
    output: join(dir, "normal-build-output"),
  });
  assert.match(
    await readFile(join(records[0].source, "builder-ran.txt"), "utf8"),
    /dsh-agent-workbench-tsconfig.json/,
  );
  for (const record of records.slice(1))
    await assert.rejects(access(join(record.source, "compiler-ran.txt")), {
      code: "ENOENT",
    });
});
test("new start and generic check/build reject missing records before SDK lookup or runtime mutation", async (t) => {
  const dir = await mkdtemp(resolve(".scratch/explicit-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    checkSourcePlugins({
      core: join(dir, "SDK-poison"),
      output: join(dir, "output"),
    }),
    /EXPLICIT_SOURCE_INPUTS_REQUIRED/,
  );
  await assert.rejects(
    runSourceProfile(join(dir, "SDK-poison"), join(dir, "runtime"), true),
    /EXPLICIT_SOURCE_INPUTS_REQUIRED/,
  );
  await assert.rejects(access(join(dir, "output")), { code: "ENOENT" });
  await assert.rejects(access(join(dir, "runtime")), { code: "ENOENT" });
});
