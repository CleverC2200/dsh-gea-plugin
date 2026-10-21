import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtemp,
  readdir,
  rm,
  writeFile,
  mkdir,
  readFile,
  copyFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const entry = join(import.meta.dirname, "deliver-packages.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const admissionRoot = await mkdtemp(join(tmpdir(), "delivery-admission-test-"));
process.env.TMPDIR = admissionRoot;
after(() => rm(admissionRoot, { recursive: true, force: true }));

async function requestFixture(
  t,
  {
    missingClient = false,
    manageRepository = false,
    runtimeDependency,
    successfulPackageManager = false,
    coreVersion = "0.2.1-alpha.1",
    geaCompanionRange,
  } = {},
) {
  const work = await mkdtemp(join(tmpdir(), "delivery-owner-inputs-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  // Standalone fixtures run a copy of the production CLI with a test-only Core registry.
  // The actual scripts/supported-cores.json and fixed production preflight are never changed.
  const core = join(work, "fixture-core");
  await mkdir(core);
  await writeFile(join(core, "package.json"), JSON.stringify({ version: coreVersion }));
  execFileSync("git", ["init", "-q", core]);
  execFileSync("git", ["-C", core, "add", "."]);
  execFileSync("git", [
    "-C",
    core,
    "-c",
    "user.name=Delivery fixture",
    "-c",
    "user.email=delivery@example.invalid",
    "commit",
    "-qm",
    "fixture Core",
  ]);
  const coreHead = execFileSync("git", ["-C", core, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const copiedScripts = join(work, "cli");
  await mkdir(copiedScripts);
  for (const file of ["build-admission.mjs", "development-repositories.mjs"])
    await copyFile(join(import.meta.dirname, file), join(copiedScripts, file));
  const fixtureEntry = join(copiedScripts, "deliver-packages.mjs");
  const cliSource = await readFile(entry, "utf8");
  await copyFile(
    join(import.meta.dirname, "package-source-integrity.mjs"),
    join(copiedScripts, "package-source-integrity.mjs"),
  );
  // The temporary CLI exercises the production validator with its declared runtime dependency.
  await writeFile(
    fixtureEntry,
    cliSource.replace(
      "../src/shared/plugin-release.mjs",
      new URL("../src/shared/plugin-release.mjs", import.meta.url).href,
    ),
  );
  const supported = JSON.parse(
    await readFile(new URL("./supported-cores.json", import.meta.url), "utf8"),
  );
  supported.find((core) => core.version === coreVersion).head = coreHead;
  await copyFile(
    join(import.meta.dirname, "supported-cores.mjs"),
    join(copiedScripts, "supported-cores.mjs"),
  );
  await writeFile(join(copiedScripts, "supported-cores.json"), JSON.stringify(supported));
  const repositories = [];
  const versions = {};
  for (const [repo, name] of [
    ["dsh-agent-workbench", "@cleverc2200/dsh-agent-workbench"],
    ["dsh-agent-manage", "dsh-agent-manage"],
    ["dsh-gea-plugin", "@cleverc2200/gea-dsh-prototype"],
  ]) {
    const path = join(work, repo);
    await mkdir(join(path, "lib"), { recursive: true });
    const manifest = {
      name,
      version: "1.0.0-candidate.installable.1",
      files: ["lib", "cordis.patch.yml"],
      exports: { ".": "./lib/host.js", "./client": "./lib/client.js" },
      dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } },
      peerDependencies: { "@deepseek-ai/dsh-tools": "0.2.0-rc.2 || 0.2.1-alpha.1" },
      dependencies: {},
      devDependencies: { "@modelcontextprotocol/sdk": "1.30.0" },
    };
    if (repo === "dsh-gea-plugin") {
      manifest.files.push("npm-shrinkwrap.json");
      if (geaCompanionRange) manifest.peerDependencies["dsh-agent-manage"] = geaCompanionRange;
    }
    if (repo === "dsh-agent-manage" && manageRepository)
      manifest.repository = JSON.parse(
        await readFile(
          new URL("./fixtures/plugin-reception/manage-repository.json", import.meta.url),
          "utf8",
        ),
      ).repository;
    if (repo === "dsh-agent-manage" && runtimeDependency)
      manifest.dependencies["runtime-helper"] = runtimeDependency;
    await writeFile(join(path, "package.json"), JSON.stringify(manifest));
    await writeFile(join(path, "LICENSE"), "Fixture license\n");
    await writeFile(join(path, "cordis.patch.yml"), "[]\n");
    await writeFile(join(path, "lib/host.js"), "module.exports = {};\n");
    if (!(missingClient && repo === "dsh-agent-workbench"))
      await writeFile(join(path, "lib/client.js"), "module.exports = {};\n");
    const lock = repo === "dsh-agent-workbench" ? "package-lock.json" : "pnpm-lock.yaml";
    await writeFile(join(path, lock), "fixture lock\n");
    if (repo === "dsh-gea-plugin") {
      await mkdir(join(path, "scripts"));
      await writeFile(join(path, "scripts/supported-cores.json"), JSON.stringify(supported));
      for (const file of [
        "production-manifest.mjs",
        "build-admission.mjs",
        "prepare-package.mjs",
        "package.mjs",
        "package-companion.mjs",
        "supported-cores.mjs",
      ])
        await copyFile(join(import.meta.dirname, file), join(path, "scripts", file));
    }
    await mkdir(join(path, "scripts"), { recursive: true });
    await mkdir(join(path, "src"), { recursive: true });
    await copyFile(
      join(import.meta.dirname, "generate-plugin-package-version.mjs"),
      join(path, "scripts/generate-plugin-package-version.mjs"),
    );
    execFileSync(process.execPath, ["scripts/generate-plugin-package-version.mjs"], { cwd: path });
    execFileSync("git", ["init", "-q", path]);
    execFileSync("git", ["-C", path, "add", "."]);
    execFileSync("git", [
      "-C",
      path,
      "-c",
      "user.name=Delivery fixture",
      "-c",
      "user.email=delivery@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const head = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const buildReceipt = join(work, repo + "-build.json");
    const outputs = [
      { path: "lib/host.js", sha256: hash(await readFile(join(path, "lib/host.js"))) },
    ];
    if (!(missingClient && repo === "dsh-agent-workbench"))
      outputs.push({
        path: "lib/client.js",
        sha256: hash(await readFile(join(path, "lib/client.js"))),
      });
    await writeFile(
      buildReceipt,
      JSON.stringify({
        command: { file: "fixture-owner-build", args: [], cwd: path },
        exitCode: 0,
        sourceHead: head,
        lockSha256: hash(await readFile(join(path, lock))),
        outputs,
      }),
    );
    const row = { repo, path, head, buildReceipt };
    if (repo !== "dsh-gea-plugin") {
      const packed = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], {
          cwd: path,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      row.archive = join(work, packed[0].filename);
    }
    repositories.push(row);
    versions[name] = "1.0.0-candidate.installable.1";
  }
  const pnpm = join(work, "pnpm.mjs");
  await writeFile(
    pnpm,
    successfulPackageManager
      ? "import {readFileSync,writeFileSync} from 'node:fs'; const m=JSON.parse(readFileSync('package.json','utf8')); writeFileSync('package-lock.json',JSON.stringify({name:m.name,version:m.version,lockfileVersion:3,packages:{'':{name:m.name,version:m.version,dependencies:m.dependencies,peerDependencies:m.peerDependencies}}})); writeFileSync('pnpm-lock.yaml','fixture package-manager lock\\n');\n"
      : "console.error('http://localhost:1234/?token=private-command-token Authorization: Bearer private-bearer-token'); process.exit(7);\n",
  );
  const input = join(work, "request.json"),
    destination = join(work, "delivery");
  // Optional peers still need exact publication metadata, not installed tgz inputs.
  versions["@changfenhuang/dsh-genui"] = "0.11.3";
  versions["dsh-better-sidebar"] = "0.24.1";
  await writeFile(
    input,
    JSON.stringify({
      core: { path: core, head: coreHead, version: coreVersion },
      pnpm,
      versions,
      repositories,
    }),
  );
  return { work, input, destination, entry: fixtureEntry };
}

test("delivery rejects a cwd-relative request before creating output", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "delivery-preflight-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [entry, "--input", "request.json", "--destination", join(cwd, "delivery")],
    { cwd, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_ABSOLUTE_PATH_REQUIRED/);
  assert.deepEqual(await readdir(cwd), []);
});

test("the real Manage git repository metadata survives ordinary three-package delivery", async (t) => {
  const fixture = await requestFixture(t, {
    manageRepository: true,
    successfulPackageManager: true,
  });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8" },
  );
  const diagnostics =
    result.status === 0
      ? []
      : await Promise.all(
          (await readdir(join(fixture.destination, "evidence")))
            .filter((name) => name.startsWith("command-"))
            .map((name) => readFile(join(fixture.destination, "evidence", name), "utf8")),
        );
  assert.equal(
    result.status,
    0,
    result.stderr + diagnostics.filter((text) => !text.startsWith("exit=0\n")).join("\n"),
  );
  const receipt = JSON.parse(await readFile(join(fixture.destination, "manifest.json"), "utf8"));
  assert.equal(receipt.status, "packaged");
  const manage = receipt.packages.find((row) => row.repo === "dsh-agent-manage");
  const manifest = JSON.parse(
    execFileSync(
      "tar",
      ["-xOf", join(fixture.destination, "packages", manage.filename), "package/package.json"],
      { encoding: "utf8" },
    ),
  );
  assert.equal(manifest.repository.url, "git+https://github.com/CleverC2200/dsh-agent-manage.git");
  await assert.rejects(access(join(fixture.destination, "evidence/gea-production")));
});

test("git and workspace runtime dependency inputs cannot publish a delivery manifest", async (t) => {
  for (const runtimeDependency of [
    "git+https://github.com/example/runtime-helper.git",
    "workspace:*",
  ]) {
    const fixture = await requestFixture(t, {
      manageRepository: true,
      runtimeDependency,
      successfulPackageManager: true,
    });
    const result = spawnSync(
      process.execPath,
      [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
      { cwd: "/", encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DELIVERY_SOURCE_DEPENDENCY_IN_PACKAGE/);
    await assert.rejects(access(join(fixture.destination, "manifest.json")));
    await assert.rejects(access(join(fixture.destination, "packages")));
  }
});

test("the real production formatter rejects missing optional version metadata before creating delivery output", async (t) => {
  for (const name of ["@changfenhuang/dsh-genui", "dsh-better-sidebar"]) {
    const fixture = await requestFixture(t);
    const request = JSON.parse(await readFile(fixture.input, "utf8"));
    delete request.versions[name];
    await writeFile(fixture.input, JSON.stringify(request));
    const result = spawnSync(
      process.execPath,
      [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
      { cwd: "/", encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DELIVERY_COMPANION_VERSION_REQUIRED/);
    await assert.rejects(access(fixture.destination));
  }
});

test("a missing public client export stops before any production dependency command", async (t) => {
  const fixture = await requestFixture(t, { missingClient: true });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_PUBLIC_EXPORT_MISSING/);
  await assert.rejects(access(fixture.destination));
});

test("a failing production dependency command cannot publish success or expose its secrets", async (t) => {
  const fixture = await requestFixture(t);
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_COMMAND_FAILED/);
  assert.ok(!result.stderr.includes("private-command-token"));
  assert.ok(!result.stderr.includes("private-bearer-token"));
  const diagnostic = await readFile(join(fixture.destination, "evidence/command-1.log"), "utf8");
  assert.match(diagnostic, /redacted sensitive command output/);
  assert.ok(!diagnostic.includes("private-command-token"));
  assert.ok(!diagnostic.includes("private-bearer-token"));
  await assert.rejects(access(join(fixture.destination, "manifest.json")));
  await assert.rejects(access(join(fixture.destination, "SHA256SUMS")));
  await assert.rejects(access(join(fixture.destination, "packages")));
});

test("current owner build output cannot legitimize a stale raw archive", async (t) => {
  const fixture = await requestFixture(t);
  const request = JSON.parse(await readFile(fixture.input, "utf8"));
  const owner = request.repositories.find((row) => row.repo === "dsh-agent-workbench");
  const bytes = "module.exports = { newCapability: true };\n";
  await writeFile(join(owner.path, "lib/host.js"), bytes);
  const build = JSON.parse(await readFile(owner.buildReceipt, "utf8"));
  build.outputs.find((row) => row.path === "lib/host.js").sha256 = hash(bytes);
  await writeFile(owner.buildReceipt, JSON.stringify(build));
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_STALE_BUILD_ARCHIVE/);
  await assert.rejects(access(fixture.destination));
});

test("companion curation excludes machine-bound build provenance while retaining public code and page assets", async (t) => {
  const fixture = await requestFixture(t);
  const input = JSON.parse(await readFile(fixture.input, "utf8"));
  const owner = input.repositories.find((row) => row.repo === "dsh-agent-workbench");
  const business = join(owner.path, "lib/business/inventory-customer");
  await mkdir(business, { recursive: true });
  await writeFile(
    join(business, "build-inputs.json"),
    JSON.stringify({ "/Users/fixture/source": "original-source-hash" }),
  );
  await writeFile(join(business, "index.html"), "<!doctype html><p>Retained page</p>");
  const raw = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", fixture.work],
      { cwd: owner.path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  )[0];
  const versions = join(fixture.work, "versions.json");
  await writeFile(versions, JSON.stringify(input.versions));
  const receipt = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, "package-companion.mjs"),
        "--input",
        join(fixture.work, raw.filename),
        "--versions",
        versions,
        "--destination",
        fixture.destination,
      ],
      { cwd: "/", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  const files = execFileSync("tar", ["-tzf", receipt.artifact], { encoding: "utf8" });
  assert.ok(!files.includes("build-inputs.json"));
  assert.ok(files.includes("package/lib/business/inventory-customer/index.html"));
  assert.ok(files.includes("package/lib/host.js"));
  assert.ok(files.includes("package/lib/client.js"));
  assert.equal(receipt.sourceArchiveSha256, hash(await readFile(join(fixture.work, raw.filename))));
  assert.deepEqual(
    receipt.excludedProvenanceFiles.map((row) => row.path),
    ["lib/business/inventory-customer/build-inputs.json"],
  );
  assert.equal(
    await readFile(join(business, "build-inputs.json"), "utf8"),
    JSON.stringify({ "/Users/fixture/source": "original-source-hash" }),
  );
});

test("an incompatible Core stops delivery without echoing request secrets", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "delivery-incompatible-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const input = join(cwd, "request.json");
  await writeFile(
    input,
    JSON.stringify({ core: { path: "/not-used?token=private-test-token", version: "0.2.0-rc.2" } }),
  );
  const result = spawnSync(
    process.execPath,
    [entry, "--input", input, "--destination", join(cwd, "delivery")],
    { cwd: "/", encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_CORE_INCOMPATIBLE/);
  assert.ok(!result.stderr.includes("private-test-token"));
  assert.deepEqual(await readdir(cwd), ["request.json"]);
});

test("RC2 delivery retains upstream, private and company Core identities", async (t) => {
  const fixture = await requestFixture(t, {
    coreVersion: "0.2.0-rc.2",
    successfulPackageManager: true,
  });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(fixture.destination, "manifest.json"), "utf8"));
  const request = JSON.parse(await readFile(fixture.input, "utf8"));
  assert.equal(manifest.core.version, "0.2.0-rc.2");
  assert.deepEqual(manifest.supportedCores, [
    { head: request.core.head, version: "0.2.0-rc.2" },
    { head: "5badb15009ae1756c3afe0ae0cef1faafc290ccc", version: "0.2.1-alpha.1" },
    { head: "8ff14441ac932b55cf1f14b1715128eaa162b1ec", version: "0.2.1-alpha.1" },
    { head: "a0d854bd72b1d052fe24005cf10b8e72bb8f17f8", version: "0.2.0-rc.2" },
    { head: "8cfb899ccf21d3662421b99b5f4627842ef712ea", version: "0.2.0-rc.2" },
  ]);
  assert.match(
    await readFile(join(fixture.destination, "INSTALL.md"), "utf8"),
    /0\.2\.0-rc\.2.*0\.2\.1-alpha\.1/,
  );
});
test("version and fixed SHA must select the same Core before output is created", async (t) => {
  const fixture = await requestFixture(t);
  const request = JSON.parse(await readFile(fixture.input, "utf8"));
  request.core.version = "0.2.0-rc.2";
  await writeFile(fixture.input, JSON.stringify(request));
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_CORE_INCOMPATIBLE/);
  await assert.rejects(access(fixture.destination));
});

test("three-package delivery validates peer ranges instead of requiring version-string equality", async (t) => {
  const fixture = await requestFixture(t, {
    successfulPackageManager: true,
    geaCompanionRange: "^1.0.0-candidate.installable.1",
  });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(await readFile(join(fixture.destination, "manifest.json"), "utf8")).status,
    "packaged",
  );
});
test("three-package delivery rejects a retained exact companion constraint that the resulting graph breaks", async (t) => {
  const fixture = await requestFixture(t, {
    successfulPackageManager: true,
    geaCompanionRange: "2.0.0",
  });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_THREE_PACKAGE_GRAPH_MISMATCH/);
  await assert.rejects(access(join(fixture.destination, "manifest.json")));
});

test("delivery refuses a requested version that would relabel compiled owner outputs", async (t) => {
  const fixture = await requestFixture(t);
  const request = JSON.parse(await readFile(fixture.input, "utf8"));
  request.versions["@cleverc2200/gea-dsh-prototype"] = "9.9.9";
  await writeFile(fixture.input, JSON.stringify(request));
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_COMPILED_VERSION_MISMATCH/);
  await assert.rejects(access(fixture.destination));
});
