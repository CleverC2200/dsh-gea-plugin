import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareSourcePlugins, readSourceCombination } from "../scripts/source-profile.mjs";
import { spawnSync } from "node:child_process";
import { sourceAssemblyFixture, names } from "./fixtures/source-assembly.mjs";

test(
  "the single assembler verifies reused published assets without source locks, while source-lock changes remain rejected",
  { timeout: 180000 },
  async (t) => {
    const { root, sources } = await sourceAssemblyFixture(t);
    const core = resolve("../../official-latest-standard"),
      runtime = join(root, "own-runtime");
    await mkdir(runtime);
    const composition = await prepareSourcePlugins(core, runtime, undefined, {
      sources,
    });
    assert.deepEqual(Object.keys(composition.dependencies), names);
    assert.deepEqual(new Set(composition.bundles), new Set(names));
    assert.equal(composition.patches.length, 1);
    assert.deepEqual(await readSourceCombination(runtime, composition.id, core), composition);
    const directory = join(runtime, "source-combinations", composition.id);
    await assert.rejects(access(join(directory, "presets.patch.yml")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(runtime, "home")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(composition.profileDefaults, "utf8")), [
      {
        id: "agent-default-model",
        config: { provider: "fixture", model: "fixture" },
      },
    ]);
    const patch = JSON.parse(await readFile(composition.patches[0], "utf8"));
    assert.equal(
      patch.find((row) => row.id === "agent-preset-registry").config.default,
      "auto-negotiation",
    );
    assert.ok(!JSON.stringify(composition).includes("dsh-plugin-hub"));
    assert.ok(!JSON.stringify(composition).includes("skill-reference"));
    const record = JSON.parse(await readFile(join(directory, "combination.json"), "utf8"));
    const originalLock = join(sources[3].source, "pnpm-lock.yaml");
    assert.ok(record.externalLockFiles.includes(originalLock));
    assert.equal(record.externalFiles[originalLock], record.locks[names[3]]["pnpm-lock.yaml"]);
    assert.match(record.externalFiles[originalLock], /^[a-f0-9]{64}$/);
    await writeFile(originalLock, "changed source dependency input\n");
    await assert.rejects(
      readSourceCombination(runtime, composition.id, core),
      /SOURCE_DEPENDENCY_DIGEST_MISMATCH/,
    );
  },
);

test(
  "each new composition records post-copy source identity and keeps case snapshots independent",
  { timeout: 180000 },
  async (t) => {
    const { root, sources } = await sourceAssemblyFixture(t);
    const core = resolve("../../official-latest-standard");
    const runtime = join(root, "first-case"),
      other = join(root, "second-case");
    const observed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {writeFileSync, unlinkSync} from 'node:fs';
const source = ${JSON.stringify(sources[0].source)}, previous = ${JSON.stringify(sources[0].commit)};
const exec = child.execFileSync;
let expected;
child.execFileSync = function(command, args, options) {
 if (!expected && options?.cwd === source && args.join(' ') === 'remote get-url source') {
  writeFileSync(source + '/post-copy-commit.txt', 'post-copy revision');
  exec.call(this, 'git', ['add', 'post-copy-commit.txt'], {cwd: source});
  exec.call(this, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'post-copy revision'], {cwd: source});
  writeFileSync(source + '/post-copy-dirty.txt', 'post-copy dirty bytes');
  expected = {
   commit: exec.call(this, 'git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'}).trim(),
   dirty: exec.call(this, 'git', ['status', '--porcelain'], {cwd: source, encoding: 'utf8'}).trim()
  };
 }
 return exec.call(this, command, args, options);
};
syncBuiltinESMExports();
const {prepareSourcePlugins} = await import(${JSON.stringify(new URL("../scripts/source-profile.mjs", import.meta.url).href)});
const composition = await prepareSourcePlugins(${JSON.stringify(core)}, ${JSON.stringify(runtime)}, undefined, {sources: ${JSON.stringify(sources)}});
const {readFile} = await import('node:fs/promises');
const audit = JSON.parse(await readFile(${JSON.stringify(runtime)} + '/source-combinations/' + composition.id + '/company-plugins.json', 'utf8'));
exec('git', ['reset', '--hard', previous], {cwd: source, stdio: 'ignore'});
unlinkSync(source + '/post-copy-dirty.txt');
console.log(JSON.stringify({composition, audit, expected}));
`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(observed.status, 0, observed.stderr);
    const { composition, audit, expected } = JSON.parse(observed.stdout);
    assert.ok(expected);
    assert.notEqual(expected.commit, sources[0].commit);
    assert.match(expected.dirty, /post-copy-dirty.txt/);
    assert.equal(audit[names[0]].commit, expected.commit);
    assert.equal(audit[names[0]].dirty, expected.dirty);
    const second = await prepareSourcePlugins(core, other, undefined, { sources });
    assert.notEqual(composition.id, second.id);
    const entry = join(
      runtime,
      "source-combinations",
      composition.id,
      "node_modules",
      names[0],
      "lib/host.js",
    );
    await writeFile(entry, "case-local mutation");
    await assert.rejects(
      readSourceCombination(runtime, composition.id, core),
      /SOURCE_COMBINATION_DIGEST_MISMATCH/,
    );
    assert.deepEqual(await readSourceCombination(other, second.id, core), second);
    const third = await prepareSourcePlugins(core, join(root, "third-case"), undefined, {
      sources,
    });
    assert.deepEqual(await readSourceCombination(join(root, "third-case"), third.id, core), third);
  },
);
