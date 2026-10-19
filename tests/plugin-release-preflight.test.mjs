import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { companyPackageNames } from "../src/shared/plugin-release.mjs";

const [, M, G] = companyPackageNames;
import { createReleasePreflightFixture as fixture } from "./fixtures/plugin-release-preflight.mjs";

test("public preflight finds a GEA-first path from previous stable, sales and resubmit using full installed graphs", async (t) => {
  const f = await fixture(t),
    result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, "release-preflight-passed");
  assert.deepEqual(
    receipt.paths.map((row) => row.id),
    ["previous-stable", "sales", "resubmit"],
  );
  assert.ok(receipt.paths.every((row) => row.order[0] === G && row.order.length === 3));
});

test("public preflight requires clean fixed sources containing every required commit or merge", async (t) => {
  const f = await fixture(t);
  const missing = structuredClone(f.input);
  delete missing.sources;
  assert.match((await f.run(missing)).stderr, /RELEASE_SOURCE_COVERAGE_REQUIRED/);
  const source = f.input.sources[0];
  const git = (...args) =>
    execFileSync("git", ["-C", source.path, ...args], { encoding: "utf8" }).trim();
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "unmerged change",
  );
  const unmerged = git("rev-parse", "HEAD");
  git("reset", "--hard", source.head);
  source.requiredCommits.push(unmerged);
  assert.match((await f.run()).stderr, /RELEASE_REQUIRED_COMMIT_MISSING/);
  source.requiredCommits.pop();
  await writeFile(join(source.path, "uncommitted.mjs"), "export {};\n");
  assert.match((await f.run()).stderr, /RELEASE_SOURCE_DIRTY/);
  await rm(join(source.path, "uncommitted.mjs"));
  source.head = unmerged;
  assert.match((await f.run()).stderr, /RELEASE_SOURCE_HEAD_MISMATCH/);
});

test("public preflight refuses missing deployment identity, any deployed high water and same-version byte replacement", async (t) => {
  const f = await fixture(t),
    missing = structuredClone(f.input);
  delete missing.deployed;
  assert.match((await f.run(missing)).stderr, /RELEASE_DEPLOYED_INPUT_REQUIRED/);
  const gea = f.input.deployed[0].installed.find((row) => row.name === G);
  gea.version = "0.0.173-sales.1";
  assert.match((await f.run()).stderr, /RELEASE_VERSION_BELOW_DEPLOYED_HIGH_WATER/);
  gea.version = "0.0.172";
  assert.match((await f.run()).stderr, /RELEASE_SAME_VERSION_CONTENT_MISMATCH/);
  delete gea.artifactSha256;
  assert.match((await f.run()).stderr, /RELEASE_ARTIFACT_IDENTITY_REQUIRED/);
});

test("public projection requires the gate and refuses an archive outside its approved three-package inputs", async (t) => {
  const f = await fixture(t),
    target = f.input.targets[0],
    destination = join(f.root, "release");
  const args = [
    resolve("scripts/create-plugin-release.mjs"),
    "--archive",
    target.archive,
    "--metadata",
    target.metadata,
    "--destination",
    destination,
  ];
  const missing = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RELEASE_PREFLIGHT_INPUT_REQUIRED/);
  await writeFile(f.file, JSON.stringify(f.input));
  const accepted = spawnSync(process.execPath, [...args, "--preflight", f.file], {
    encoding: "utf8",
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  const receipt = JSON.parse(accepted.stdout);
  assert.equal(receipt.preflight.status, "release-preflight-passed");
  assert.equal(receipt.published, false);
  const copy = join(f.root, "unbound.tgz");
  await writeFile(copy, await readFile(target.archive));
  const unbound = spawnSync(
    process.execPath,
    [...args.map((arg) => (arg === target.archive ? copy : arg)), "--preflight", f.file],
    { encoding: "utf8" },
  );
  assert.notEqual(unbound.status, 0);
  assert.match(unbound.stderr, /RELEASE_PREFLIGHT_TARGET_MISMATCH/);
});

test("release gate binds archive bytes to the existing delivery manifest and actual source build receipt", async (t) => {
  const f = await fixture(t),
    missing = structuredClone(f.input);
  delete missing.deliveryManifest;
  assert.match((await f.run(missing)).stderr, /RELEASE_DELIVERY_MANIFEST_REQUIRED/);
  f.delivery.packages[0].source.head = "b".repeat(40);
  await writeFile(f.input.deliveryManifest, JSON.stringify(f.delivery));
  assert.match((await f.run()).stderr, /RELEASE_DELIVERY_SOURCE_MISMATCH/);
  f.delivery.packages[0].source.head = f.input.sources[0].head;
  await writeFile(f.input.deliveryManifest, JSON.stringify(f.delivery));
  await writeFile(join(f.input.sources[0].path, "lib", "host.js"), "stale build\n");
  assert.match((await f.run()).stderr, /DELIVERY_BUILD_OUTPUT_MISMATCH/);
});

test("gate retains non-company consumers and Core SDK constraints throughout every path and rejects incomplete snapshots", async (t) => {
  const f = await fixture(t),
    consumerBlocked = structuredClone(f.input);
  consumerBlocked.supportedStarts[0].installed.find(
    (row) => row.name === "customer-dashboard",
  ).peerDependencies[G] = "0.0.167";
  assert.match((await f.run(consumerBlocked)).stderr, /RELEASE_UPGRADE_PATH_MISSING/);
  const sdkBlocked = structuredClone(f.input);
  sdkBlocked.supportedStarts[0].core.sdk["@deepseek-ai/dsh-tools"] = "0.2.1-alpha.1";
  assert.match((await f.run(sdkBlocked)).stderr, /RELEASE_UPGRADE_PATH_MISSING/);
  const missing = structuredClone(f.input);
  missing.supportedStarts[0].installed = missing.supportedStarts[0].installed.filter(
    (row) => row.name !== M,
  );
  assert.match((await f.run(missing)).stderr, /RELEASE_INSTALLED_GRAPH_INCOMPLETE/);
  delete missing.supportedStarts[0].core.sdk;
  missing.supportedStarts[0].installed = f.input.supportedStarts[0].installed;
  assert.match((await f.run(missing)).stderr, /RELEASE_CORE_SDK_REQUIRED/);
});

test("same-version three-package promotion accepts the identical deployed bytes and current planner states", async (t) => {
  const f = await fixture(t),
    installed = [];
  for (const [index, target] of f.input.targets.entries()) {
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", target.archive, "package/package.json"], { encoding: "utf8" }),
    );
    installed.push({ ...manifest, artifactSha256: f.delivery.packages[index].sha256 });
  }
  f.input.deployed = [{ id: "test-channel", installed }];
  f.input.supportedStarts = [{ ...f.input.supportedStarts[0], id: "test-promotion", installed }];
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).paths[0].order.length, 3);
});

test("generated output renames into source remain uncommitted source edits", async (t) => {
  const f = await fixture(t),
    source = f.input.sources[0];
  execFileSync("git", ["-C", source.path, "mv", "lib/compiler.txt", "source.txt"]);
  assert.match((await f.run()).stderr, /RELEASE_SOURCE_DIRTY/);
});

test("the actual debug 4.4.3 npm shape permits orphan optional metadata and retains declared consumer peers", async (t) => {
  const f = await fixture(t);
  const debug = {
    name: "debug",
    version: "4.4.3",
    peerDependencies: {},
    peerDependenciesMeta: { "supports-color": { optional: true } },
    dependencies: { ms: "^2.1.3" },
  };
  for (const snapshot of [...f.input.deployed, ...f.input.supportedStarts])
    snapshot.installed.push(structuredClone(debug));
  const accepted = await f.run();
  assert.equal(accepted.status, 0, accepted.stderr);
  f.input.supportedStarts[0].installed.find(
    (manifest) => manifest.name === "debug",
  ).peerDependencies[G] = "0.0.167";
  const blocked = await f.run();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /RELEASE_UPGRADE_PATH_MISSING/);
  const consumer = f.input.supportedStarts[0].installed.find(
    (manifest) => manifest.name === "debug",
  );
  delete consumer.peerDependencies[G];
  consumer.dependencies = { ms: "npm:ms@^2.1.3", [G]: "0.0.167" };
  assert.match((await f.run()).stderr, /RELEASE_UPGRADE_PATH_MISSING/);
  consumer.version = "invalid-version";
  assert.match((await f.run()).stderr, /RELEASE_INVALID/);
});
