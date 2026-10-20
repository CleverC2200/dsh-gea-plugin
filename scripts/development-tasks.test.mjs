import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import cp from "node:child_process";
import { join } from "node:path";
import { prepareDependencies, digest } from "./development-dependencies.mjs";
import { developmentTask } from "./development-tasks.mjs";
import { packRaw } from "./pack-raw.mjs";

function fixture(t, { dotfile = false } = {}) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "development-task-"));
  t.after(() => {
    delete process.env.DSH_BUILD_ADMISSION;
    fs.rmSync(root, { recursive: true, force: true });
  });
  t.mock.method(os, "tmpdir", () => root);
  t.mock.method(fs, "statfsSync", () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }));
  const path = join(root, "dsh-agent-manage");
  fs.mkdirSync(path);
  const manifest = {
    name: "dsh-agent-manage",
    version: "1.0.0",
    packageManager: "pnpm@1.0.0",
    scripts: { build: "fixture", "build:client": "fixture" },
    dependencies: { fixture: "1.0.0" },
    files: ["lib", "client", ...(dotfile ? [".env"] : [])],
    exports: { ".": "./lib/host.js", "./client": "./client/index.js" },
  };
  fs.writeFileSync(join(path, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(join(path, "pnpm-lock.yaml"), "fixture-lock\n");
  fs.writeFileSync(join(path, ".gitignore"), "node_modules/\nlib/\nclient/\n.runtime/\n");
  fs.writeFileSync(join(path, "source.js"), "fixture-source");
  if (dotfile) fs.writeFileSync(join(path, ".env"), "fixture-only");
  const git = (...args) =>
    cp.execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const owner = {
    path,
    manifest,
    repo: "dsh-agent-manage",
    manager: "pnpm",
    lock: "pnpm-lock.yaml",
  };
  const install = () => {
    fs.mkdirSync(join(path, "node_modules/fixture"), { recursive: true });
    fs.writeFileSync(join(path, "node_modules/.modules.yaml"), "fixture-metadata");
    fs.writeFileSync(
      join(path, "node_modules/fixture/package.json"),
      '{"name":"fixture","version":"1.0.0"}',
    );
  };
  const compile = () => {
    for (const file of ["lib/host.js", "client/index.js"]) {
      fs.mkdirSync(join(path, file, ".."), { recursive: true });
      fs.writeFileSync(
        join(path, file),
        fs.readFileSync(join(path, "source.js")) + (process.env.APS_BUILD_MODE ?? ""),
      );
    }
  };
  return { root, path, owner, install, compile, git };
}
test("validated dependencies skip installation; missing packages or changed lock prepare again", async (t) => {
  const { owner, path, install } = fixture(t);
  let calls = 0;
  t.mock.method(cp, "spawnSync", (file, args) => {
    assert.equal(file, process.platform === "win32" ? "corepack.cmd" : "corepack");
    assert.ok(args.includes("--frozen-lockfile"));
    assert.ok(args.includes("--ignore-scripts"));
    calls++;
    install();
    return { status: 0 };
  });
  assert.equal((await prepareDependencies(owner)).status, "prepared");
  assert.equal((await prepareDependencies(owner)).status, "reused");
  assert.equal(calls, 1);
  fs.unlinkSync(join(path, "node_modules/fixture/package.json"));
  assert.equal((await prepareDependencies(owner)).status, "prepared");
  fs.appendFileSync(join(path, "pnpm-lock.yaml"), "changed");
  assert.equal((await prepareDependencies(owner)).status, "prepared");
  assert.equal(calls, 3);
});
test("build cache tracks source, dependency state and every output while ignoring test-only edits", async (t) => {
  const { path, install, compile, git } = fixture(t);
  install();
  const original = cp.execFileSync;
  t.mock.method(cp, "execFileSync", (file, args, options) =>
    args.join(" ") === "pnpm --version" ? "1.0.0\n" : original(file, args, options),
  );
  let calls = 0;
  t.mock.method(cp, "spawnSync", () => {
    calls++;
    compile();
    return { status: 0 };
  });
  assert.equal((await developmentTask("build", {}, path)).status, "built");
  fs.mkdirSync(join(path, "tests"));
  fs.writeFileSync(join(path, "tests/example.test.mjs"), "fixture-test");
  fs.mkdirSync(join(path, "scripts"));
  fs.writeFileSync(join(path, "scripts/example.test.mjs"), "fixture-test");
  git("add", "tests", "scripts");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "tests only",
  );
  assert.equal((await developmentTask("build", {}, path)).status, "reused");
  assert.equal(calls, 1);
  const receipt = JSON.parse(fs.readFileSync(join(path, ".runtime/development/build-plugin.json")));
  assert.equal(receipt.sourceHead, git("rev-parse", "HEAD"));
  assert.notEqual(receipt.compiledSourceHead, receipt.sourceHead);
  fs.writeFileSync(join(path, "source.js"), "changed-source");
  assert.equal((await developmentTask("build", {}, path)).status, "built");
  fs.unlinkSync(join(path, "client/index.js"));
  assert.equal((await developmentTask("build", {}, path)).status, "built");
  fs.appendFileSync(join(path, "node_modules/.modules.yaml"), "changed");
  assert.equal((await developmentTask("build", {}, path)).status, "built");
  assert.equal(calls, 4);
  const previousMode = process.env.APS_BUILD_MODE;
  t.after(() => {
    if (previousMode === undefined) delete process.env.APS_BUILD_MODE;
    else process.env.APS_BUILD_MODE = previousMode;
  });
  process.env.APS_BUILD_MODE = previousMode === "mock" ? "production" : "mock";
  assert.equal((await developmentTask("build", {}, path)).status, "built");
  assert.equal(calls, 5);
  assert.ok(
    fs.readFileSync(join(path, "client/index.js"), "utf8").endsWith(process.env.APS_BUILD_MODE),
  );
  const report = await developmentTask("finish", {}, path);
  assert.equal(report.status, "report-only");
  assert.equal(report.receipts[0].purpose, "development-build");
  assert.ok(fs.existsSync(join(path, "client/index.js")));
});
async function packageFixture(t, options) {
  const fixtureData = fixture(t, options);
  const { path, root, compile, git } = fixtureData;
  compile();
  const buildReceipt = join(root, "build.json");
  fs.writeFileSync(
    buildReceipt,
    JSON.stringify({
      sourceHead: git("rev-parse", "HEAD"),
      lockSha256: digest(fs.readFileSync(join(path, "pnpm-lock.yaml"))),
      exitCode: 0,
      command: { file: "fixture", args: [], cwd: path },
      outputs: ["lib/host.js", "client/index.js"].map((file) => ({
        path: file,
        sha256: digest(fs.readFileSync(join(path, file))),
      })),
    }),
  );
  const input = join(root, "input.json");
  fs.writeFileSync(
    input,
    JSON.stringify({
      repositories: [
        { repo: "dsh-agent-manage", path, head: git("rev-parse", "HEAD"), buildReceipt },
      ],
    }),
  );
  return { ...fixtureData, input, destination: join(root, "out") };
}
test("raw TGZ uses its frozen owner and verified build outputs", async (t) => {
  const { input, destination } = await packageFixture(t);
  const receipt = await packRaw({ input, destination, repo: "dsh-agent-manage" });
  assert.ok(fs.existsSync(receipt.artifact));
  assert.deepEqual(receipt.files.sort(), ["client/index.js", "lib/host.js", "package.json"]);
  await assert.rejects(
    packRaw({ input, destination, repo: "dsh-agent-manage" }),
    /RAW_PACKAGE_DESTINATION_EXISTS/,
  );
  assert.equal(digest(fs.readFileSync(receipt.artifact)), receipt.sha256);
});
test("raw TGZ rejects dotfiles and checkout destinations before writing a package", async (t) => {
  const { input, path, destination } = await packageFixture(t, { dotfile: true });
  await assert.rejects(
    packRaw({ input, destination: join(path, "out"), repo: "dsh-agent-manage" }),
    /RAW_PACKAGE_DESTINATION_OVERLAP/,
  );
  await assert.rejects(
    packRaw({ input, destination, repo: "dsh-agent-manage" }),
    /RAW_PACKAGE_FILE_FORBIDDEN/,
  );
  assert.equal(fs.existsSync(destination), false);
});

test("registry package links without Git metadata bind their public artifact bytes", async (t) => {
  const { root, path, owner, install } = fixture(t);
  const local = join(root, "public-package");
  fs.mkdirSync(local);
  fs.writeFileSync(
    join(local, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", exports: "./index.js" }),
  );
  fs.writeFileSync(join(local, "index.js"), "first");
  owner.manifest.dependencies.fixture = "file:../public-package";
  fs.writeFileSync(join(path, "package.json"), JSON.stringify(owner.manifest));
  let calls = 0;
  t.mock.method(cp, "spawnSync", () => {
    calls++;
    install();
    return { status: 0 };
  });
  assert.equal((await prepareDependencies(owner)).status, "prepared");
  assert.equal((await prepareDependencies(owner)).status, "reused");
  fs.writeFileSync(join(local, "index.js"), "second");
  assert.equal((await prepareDependencies(owner)).status, "prepared");
  assert.equal(calls, 2);
});

test("a client-only receipt cannot package an older Host alongside the rebuilt client", async (t) => {
  const { path, root, install, compile, git } = fixture(t);
  install();
  compile();
  const host = fs.readFileSync(join(path, "lib/host.js"));
  fs.writeFileSync(join(path, "source.js"), "new-client-source");
  git("add", "source.js");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "client source",
  );
  const original = cp.execFileSync;
  t.mock.method(cp, "execFileSync", (file, args, options) =>
    args.join(" ") === "pnpm --version" ? "1.0.0\n" : original(file, args, options),
  );
  t.mock.method(cp, "spawnSync", () => {
    fs.writeFileSync(join(path, "client/index.js"), "new-client-source");
    return { status: 0 };
  });
  const build = await developmentTask("build", { target: "client" }, path);
  const receipt = JSON.parse(fs.readFileSync(build.receipt));
  assert.deepEqual(
    receipt.outputs.map((file) => file.path),
    ["client/index.js"],
  );
  assert.deepEqual(fs.readFileSync(join(path, "lib/host.js")), host);
  const input = join(root, "input.json"),
    destination = join(root, "out");
  fs.writeFileSync(
    input,
    JSON.stringify({
      repositories: [
        {
          repo: "dsh-agent-manage",
          path,
          head: git("rev-parse", "HEAD"),
          buildReceipt: build.receipt,
        },
      ],
    }),
  );
  await assert.rejects(
    packRaw({ input, destination, repo: "dsh-agent-manage" }),
    /RAW_PACKAGE_BUILD_INCOMPLETE/,
  );
  assert.equal(fs.existsSync(destination), false);
});

test("a shared tool verifies SDK inputs through the current consumer's Manage checkout", async (t) => {
  const { root, path, owner } = fixture(t);
  const integration = join(root, "integration");
  fs.mkdirSync(integration);
  owner.path = join(integration, "dsh-agent-manage");
  fs.renameSync(path, owner.path);
  const core = join(root, "official-latest-standard");
  fs.mkdirSync(core);
  fs.writeFileSync(join(core, "package.json"), '{"name":"fixture-core"}');
  cp.execFileSync("git", ["init", "-q", core]);
  cp.execFileSync("git", ["-C", core, "add", "."]);
  cp.execFileSync("git", [
    "-C",
    core,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Core",
  ]);
  fs.writeFileSync(join(owner.path, "tsconfig.official-paths.json"), "{}");
  fs.mkdirSync(join(owner.path, "scripts"));
  fs.writeFileSync(
    join(owner.path, "scripts/prepare-official-sdk.mjs"),
    'export function verifyOfficialSDK() { throw Error("CURRENT_OWNER_SDK"); }',
  );
  await assert.rejects(prepareDependencies(owner), /CURRENT_OWNER_SDK/);
  assert.equal(fs.existsSync(join(owner.path, "node_modules")), false);
});
