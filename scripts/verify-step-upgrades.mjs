import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { inspectPluginArchive } from "../src/host/plugin-release-source.ts";
import { archiveMatches } from "../src/host/plugin-update-archive.mjs";
import { readSupportedCore } from "./supported-cores.mjs";
import { artifactSetSha256, digest, pluginNames } from "./plugin-reception/contract.mjs";

const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const within = (root, file) => {
  const part = relative(root, file);
  return !isAbsolute(part) && part !== ".." && !part.startsWith("../");
};

export async function verifyStepUpgrades(inputFile, output) {
  assert(isAbsolute(inputFile) && isAbsolute(output), "UPGRADE_ABSOLUTE_INPUT_REQUIRED");
  const input = await read(inputFile),
    core = await realpath(input.core),
    pnpm = await realpath(input.pnpm);
  const identity = await readSupportedCore(core);
  for (const protectedRoot of [core, dirname(import.meta.dirname)])
    assert(!within(protectedRoot, output), "UPGRADE_OUTPUT_IN_PROTECTED_INPUT");
  assert(Array.isArray(input.starts) && input.starts.length > 0, "UPGRADE_STARTS_REQUIRED");
  assert(Array.isArray(input.targets) && input.targets.length === 3, "UPGRADE_TARGETS_REQUIRED");
  async function artifact(row) {
    const file = await realpath(row.archive),
      bytes = await readFile(file),
      sha256 = digest(bytes);
    assert.equal(sha256, row.artifactSha256, "UPGRADE_ARCHIVE_CHANGED");
    const manifest = await inspectPluginArchive(file);
    assert(pluginNames.includes(manifest.name), "UPGRADE_NOT_COMPANY_PACKAGE");
    assert.equal(manifest.name, row.name, "UPGRADE_ARCHIVE_NAME_MISMATCH");
    assert.equal(manifest.version, row.version, "UPGRADE_ARCHIVE_VERSION_MISMATCH");
    return { file, name: row.name, version: row.version, sha256 };
  }
  const targets = await Promise.all(input.targets.map(artifact));
  assert.equal(new Set(targets.map((row) => row.name)).size, 3, "UPGRADE_TARGETS_REQUIRED");
  const starts = [];
  for (const start of input.starts) {
    assert(typeof start.id === "string" && start.id.length > 0, "UPGRADE_START_ID_REQUIRED");
    assert.equal(start.archives.length, 3, "UPGRADE_START_GRAPH_REQUIRED");
    const initial = await Promise.all(start.archives.map(artifact));
    assert.equal(new Set(initial.map((row) => row.name)).size, 3, "UPGRADE_START_GRAPH_REQUIRED");
    starts.push({ ...start, initial });
  }
  await mkdir(output, { mode: 0o700 });
  const result = {
    schema: 1,
    status: "verifying-step-upgrades",
    core: { head: identity.head, version: identity.version },
    targets,
    paths: [],
    nativeRun: false,
    credentialsReadOrCopied: false,
  };
  const worker = join(import.meta.dirname, "plugin-reception");
  const verified = new Map();
  async function child(entry, args, env, log) {
    const stream = createWriteStream(log, { flags: "wx", mode: 0o600 });
    try {
      await new Promise((resolve, reject) => {
        const childProcess = spawn(process.execPath, [entry, ...args], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        childProcess.stdout.pipe(stream, { end: false });
        childProcess.stderr.pipe(stream, { end: false });
        const timeout = setTimeout(() => {
          childProcess.kill("SIGTERM");
        }, 265000);
        childProcess.once("error", reject);
        childProcess.once("exit", (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else reject(Error("UPGRADE_CHILD_FAILED:" + log + ":" + (signal ?? code)));
        });
      });
    } finally {
      await new Promise((resolve) => stream.end(resolve));
    }
  }
  function blocked(combo) {
    const gea = combo.find((row) => row.name === pluginNames[2]),
      workbench = combo.find((row) => row.name === pluginNames[0]);
    const profiles = JSON.parse(
      execFileSync("tar", ["-xOf", gea.file, "package/presets/execution-policy.json"], {
        encoding: "utf8",
      }),
    ).profiles;
    const entries = execFileSync("tar", ["-tzf", workbench.file], { encoding: "utf8" })
      .trim()
      .split("\n");
    return entries
      .filter((file) => /^package\/lib\/.+\/plugin.json$/.test(file))
      .flatMap((file) => {
        const manifest = JSON.parse(
          execFileSync("tar", ["-xOf", workbench.file, file], { encoding: "utf8" }),
        );
        const profile = profiles["gea-html-" + manifest.id];
        return manifest.gea?.contract === "gea-html-v2" &&
          profile &&
          profile.consumerCode !== manifest.gea.consumerCode
          ? [manifest.id]
          : [];
      })
      .sort();
  }
  for (const start of starts)
    for (const order of input.orders ?? [
      [pluginNames[2], pluginNames[0], pluginNames[1]],
      [pluginNames[2], pluginNames[1], pluginNames[0]],
    ]) {
      assert.deepEqual([...order].sort(), [...pluginNames].sort(), "UPGRADE_ORDER_REQUIRED");
      const key = artifactSetSha256(start.initial) + JSON.stringify(order);
      if (verified.has(key)) {
        result.paths.push({ ...verified.get(key), id: start.id });
        continue;
      }
      const directory = join(output, "path-" + result.paths.length),
        home = join(directory, "home"),
        profile = join(home, "profiles/reception");
      await mkdir(directory);
      const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: "1",
        npm_config_userconfig: join(home, "empty.npmrc"),
        npm_config_globalconfig: join(home, "empty.npmrc"),
      };
      const initial = pluginNames.map((name) => start.initial.find((row) => row.name === name));
      await child(
        join(worker, "empty-profile.mjs"),
        [
          "--mode",
          "install",
          "--core",
          core,
          "--home",
          home,
          "--profile",
          profile,
          "--pnpm",
          pnpm,
          "--workbench",
          initial[0].file,
          "--manage",
          initial[1].file,
          "--gea",
          initial[2].file,
          "--receipt",
          join(directory, "initial-install.json"),
        ],
        env,
        join(directory, "initial-install.log"),
      );
      let combo = initial;
      const path = {
        id: start.id,
        startArtifactSetSha256: artifactSetSha256(initial),
        order,
        steps: [],
      };
      for (const [index, name] of order.entries()) {
        const target = targets.find((row) => row.name === name),
          previous = combo.find((row) => row.name === name),
          changed = previous.sha256 !== target.sha256;
        if (changed) {
          const receipt = join(directory, "install-" + index + ".json"),
            parameters = join(directory, "install-" + index + ".input.json");
          await save(parameters, { core, home, profile, pnpm, receipt, artifacts: [target] });
          await child(join(worker, "install-worker.mjs"), [parameters], env, receipt + ".log");
          combo = combo.map((row) => (row.name === name ? target : row));
          await writeFile(
            join(home, ".three-plugin-reception.json"),
            JSON.stringify({ core, profile, artifacts: combo }) + "\n",
            { mode: 0o600 },
          );
        }
        const expectedBlocked = blocked(combo),
          receipt = join(directory, "observe-" + index + ".json"),
          parameters = receipt + ".input.json";
        for (const installed of combo)
          assert(
            await archiveMatches(installed.file, join(profile, "node_modules", installed.name)),
            "UPGRADE_INSTALLED_BYTES_MISMATCH",
          );
        await save(parameters, {
          core,
          home,
          profile,
          receipt,
          upgrade: { protectionRequired: true, expectedBlocked },
        });
        await child(join(worker, "observe-worker.mjs"), [parameters], env, receipt + ".log");
        const observationFile = receipt + ".runtime.json",
          bytes = await readFile(observationFile),
          observation = JSON.parse(bytes);
        assert.equal(observation.success, true, "UPGRADE_RESTART_NOT_VERIFIED");
        assert.equal(
          observation.artifactSetSha256,
          artifactSetSha256(combo),
          "UPGRADE_RESTART_INPUT_MISMATCH",
        );
        if (index === order.length - 1)
          assert.deepEqual(expectedBlocked, [], "UPGRADE_FINAL_RESOURCES_INCOMPATIBLE");
        path.steps.push({
          packageName: name,
          changed,
          installedArchiveBytesVerified: true,
          artifactSetSha256: artifactSetSha256(combo),
          artifacts: combo,
          observation: observationFile,
          observationSha256: digest(bytes),
        });
        console.log(
          JSON.stringify({
            start: start.id,
            step: name,
            versions: combo.map((row) => row.version),
            incompatibleResources: expectedBlocked,
            restartVerified: true,
          }),
        );
      }
      verified.set(key, path);
      result.paths.push(path);
    }
  result.status = "step-upgrades-verified";
  result.observerSha256 = digest(await readFile(join(worker, "observe-worker.mjs")));
  await save(join(output, "result.json"), result);
  return result;
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({
    options: { input: { type: "string" }, output: { type: "string" } },
  });
  await verifyStepUpgrades(values.input, values.output);
}
