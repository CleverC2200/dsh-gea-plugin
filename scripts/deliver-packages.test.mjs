import test from "node:test";
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
  stat,
  rename,
  symlink,
  realpath,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { builtArchive } from "./package-source-integrity.mjs";

const entry = join(import.meta.dirname, "deliver-packages.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function requestFixture(
  t,
  {
    missingClient = false,
    manageRepository = false,
    runtimeDependency,
    successfulPackageManager = false,
    coreVersion = "0.2.1-alpha.1",
    geaCompanionRange,
    invalidHtmlCapability = false,
    hostSource = "module.exports = {};\n",
    tarOutputCRLF = false,
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
  let cliSource = await readFile(entry, "utf8");
  if (tarOutputCRLF)
    cliSource = cliSource.replace(
      "return result.stdout;",
      'return file === "tar" && ["-tzf", "-tvzf"].includes(args[0]) ? result.stdout.replace(/\\r?\\n/g, "\\r\\n") : result.stdout;',
    );
  await writeFile(
    join(copiedScripts, "package-source-integrity.mjs"),
    (await readFile(join(import.meta.dirname, "package-source-integrity.mjs"), "utf8"))
      .replace(
        "../src/capability/html-mcp.mjs",
        new URL("../src/capability/html-mcp.mjs", import.meta.url).href,
      )
      .replace('from "tar"', `from ${JSON.stringify(import.meta.resolve("tar"))}`),
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
    await writeFile(join(path, "lib/host.js"), hostSource);
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
    if (invalidHtmlCapability && repo === "dsh-agent-workbench") {
      const directory = join(path, "lib/static/mps");
      await mkdir(directory, { recursive: true });
      for (const [file, data] of Object.entries({
        "plugin.json": {
          id: "inventory-mps",
          mcp: "mcp.json",
          gea: { consumerCode: "mps", contract: "gea-html-v2" },
        },
        "mcp.json": {
          provider: "gea",
          transport: "host-provided",
          contract: "gea-html-v2",
          consumer: { consumerCode: "mps", consumerType: "AGENT" },
          capabilities: ["governed-sql-read", "unsupported-capability"],
        },
      })) {
        const output = "lib/static/mps/" + file;
        const bytes = JSON.stringify(data);
        await writeFile(join(path, output), bytes);
        outputs.push({ path: output, sha256: hash(bytes) });
      }
    }
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
        execFileSync(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["pack", "--json", "--ignore-scripts", "--pack-destination", work],
          {
            cwd: path,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            shell: process.platform === "win32",
          },
        ),
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
  return {
    work,
    input,
    destination,
    entry: fixtureEntry,
    env: { ...process.env, TMPDIR: work, TEMP: work, TMP: work, DSH_BUILD_ADMISSION: undefined },
  };
}

async function developmentDeliveryFixture(t, options) {
  const fixture = await requestFixture(t, options);
  const tools = join(fixture.work, "versioned-tools");
  await mkdir(tools);
  const scripts = join(tools, "scripts");
  await rename(join(fixture.work, "cli"), scripts);
  await copyFile(new URL("../package.json", import.meta.url), join(tools, "package.json"));
  for (const file of ["plugin-split-development.mjs", "development-outputs.mjs"])
    await copyFile(join(import.meta.dirname, file), join(scripts, file));
  await copyFile(
    join(import.meta.dirname, "delivery-package-runtime.mjs"),
    join(scripts, "delivery-package-runtime.mjs"),
  );
  await cp(join(import.meta.dirname, "delivery-runtime"), join(scripts, "delivery-runtime"), {
    recursive: true,
  });
  for (const file of ["shared/plugin-release.mjs", "capability/html-mcp.mjs"]) {
    await mkdir(join(tools, "src", file.split("/")[0]), { recursive: true });
    await writeFile(
      join(tools, "src", file),
      await readFile(new URL("../src/" + file, import.meta.url), "utf8"),
    );
  }
  for (const [file, local] of [
    ["deliver-packages.mjs", "shared/plugin-release.mjs"],
    ["package-source-integrity.mjs", "capability/html-mcp.mjs"],
  ])
    await writeFile(
      join(scripts, file),
      (await readFile(join(scripts, file), "utf8"))
        .replace(new URL("../src/" + local, import.meta.url).href, "../src/" + local)
        .replace(`from ${JSON.stringify(import.meta.resolve("tar"))}`, 'from "tar"'),
    );
  const runtime = options?.runtime ?? join(fixture.work, "runtime");
  if (!options?.runtime) {
    await cp(join(import.meta.dirname, "delivery-runtime"), runtime, { recursive: true });
    const pending = ["tar", "semver"].map((name) => [
      name,
      createRequire(import.meta.resolve(name)),
    ]);
    const copied = new Set();
    while (pending.length) {
      const [name, require] = pending.pop();
      if (copied.has(name)) continue;
      const source = require.resolve(name + "/package.json");
      const manifest = JSON.parse(await readFile(source, "utf8"));
      await cp(dirname(source), join(runtime, "node_modules", name), { recursive: true });
      copied.add(name);
      for (const dependency of Object.keys(manifest.dependencies ?? {}))
        pending.push([dependency, createRequire(source)]);
    }
  }
  execFileSync("git", ["init", "-q", tools]);
  execFileSync("git", ["-C", tools, "add", "."]);
  execFileSync("git", [
    "-C",
    tools,
    "-c",
    "user.name=Delivery fixture",
    "-c",
    "user.email=delivery@example.invalid",
    "commit",
    "-qm",
    "fixture tools",
  ]);
  const toolHead = execFileSync("git", ["-C", tools, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const launcher = join(fixture.work, "development.mjs");
  await symlink(join(scripts, "plugin-split-development.mjs"), launcher);
  const invoke = (args = []) =>
    spawnSync(
      process.execPath,
      [
        launcher,
        "deliver",
        "--input",
        fixture.input,
        "--destination",
        fixture.destination,
        "--tool-head",
        toolHead,
        "--runtime",
        runtime,
        ...args,
      ],
      { cwd: fixture.work, env: { ...fixture.env, NODE_OPTIONS: undefined }, encoding: "utf8" },
    );
  return { ...fixture, tools, toolHead, runtime, invoke };
}

test("the project delivery launcher uses committed tools once while preserving package bodies and bounded logs", async (t) => {
  const marker = "PROJECT_DELIVERY_BODY_";
  const fixture = await developmentDeliveryFixture(t, {
    runtime: process.env.DSH_DELIVERY_TEST_RUNTIME,
    successfulPackageManager: true,
    hostSource: `module.exports = ${JSON.stringify(marker.repeat(4096))};\n`,
  });
  const input = await readFile(fixture.input, "utf8");
  const result = fixture.invoke();
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.filter((row) => row.status === "packaged").length, 1);
  assert.deepEqual(records.find((row) => row.toolSource).toolSource, {
    path: await realpath(fixture.tools),
    head: fixture.toolHead,
  });
  assert.ok(!result.stdout.includes(marker));
  assert.equal(await readFile(fixture.input, "utf8"), input);
  const manifest = JSON.parse(await readFile(join(fixture.destination, "manifest.json"), "utf8"));
  const gea = manifest.packages.find((row) => row.repo === "dsh-gea-plugin");
  assert.match(
    execFileSync(
      "tar",
      ["-xOf", join(fixture.destination, "packages", gea.filename), "package/lib/host.js"],
      { encoding: "utf8" },
    ),
    /PROJECT_DELIVERY_BODY_/,
  );
  const evidence = join(fixture.destination, "evidence");
  assert.deepEqual(
    (await readdir(evidence)).filter((name) => /^commands?(?:-\d+)?\.log$/.test(name)),
    ["commands.log"],
  );
  const logs = await readFile(join(evidence, "commands.log"), "utf8");
  assert.ok(!logs.includes(marker));
  assert.ok(Buffer.byteLength(logs) < 16384);
});

test("the project delivery launcher rejects an unpinned or different tool commit before writing delivery output", async (t) => {
  const fixture = await developmentDeliveryFixture(t, { successfulPackageManager: true });
  for (const head of ["", "0".repeat(40)]) {
    const result = fixture.invoke(["--tool-head", head]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DEVELOPMENT_TOOL_HEAD_MISMATCH/);
    await assert.rejects(access(fixture.destination));
  }
});

test("the project delivery launcher rejects changes to its delivery runner and local execution contracts", async (t) => {
  const fixture = await developmentDeliveryFixture(t, { successfulPackageManager: true });
  for (const file of [
    "package.json",
    "scripts/deliver-packages.mjs",
    "scripts/delivery-package-runtime.mjs",
    "scripts/delivery-runtime/package.json",
    "scripts/delivery-runtime/pnpm-lock.yaml",
    "scripts/build-admission.mjs",
    "scripts/development-repositories.mjs",
    "scripts/supported-cores.mjs",
    "scripts/supported-cores.json",
    "scripts/package-source-integrity.mjs",
    "src/shared/plugin-release.mjs",
    "src/capability/html-mcp.mjs",
  ]) {
    const path = join(fixture.tools, file);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("\n")]));
    const result = fixture.invoke();
    assert.notEqual(result.status, 0, file);
    assert.match(result.stderr, /DEVELOPMENT_TOOL_SOURCE_MISMATCH/, file);
    await assert.rejects(access(fixture.destination));
    await writeFile(path, original);
  }
});

test("the project delivery launcher preserves request Core, source and build-receipt rejection", async (t) => {
  const fixture = await developmentDeliveryFixture(t, { successfulPackageManager: true });
  const input = JSON.parse(await readFile(fixture.input, "utf8"));
  const originalBuild = JSON.parse(await readFile(input.repositories[0].buildReceipt, "utf8"));
  const invalidBuild = join(fixture.work, "invalid-build.json");
  await writeFile(invalidBuild, JSON.stringify({ ...originalBuild, sourceHead: "0".repeat(40) }));
  for (const [code, change] of [
    [
      "DELIVERY_CORE_INCOMPATIBLE",
      (request) => {
        request.core.head = "0".repeat(40);
      },
    ],
    [
      "DELIVERY_SOURCE_HEAD_MISMATCH",
      (request) => {
        request.repositories[0].head = "0".repeat(40);
      },
    ],
    [
      "DELIVERY_BUILD_RECEIPT_INVALID",
      (request) => {
        request.repositories[0].buildReceipt = invalidBuild;
      },
    ],
  ]) {
    const request = structuredClone(input);
    change(request);
    await writeFile(fixture.input, JSON.stringify(request));
    const result = fixture.invoke();
    assert.notEqual(result.status, 0, code);
    assert.match(result.stderr, new RegExp(code));
    assert.ok(!result.stdout.includes('"status":"packaged"'));
    await assert.rejects(access(fixture.destination));
  }
});

test("the project delivery launcher requires its fixed independent runtime before creating delivery output", async (t) => {
  const fixture = await developmentDeliveryFixture(t, { successfulPackageManager: true });
  const result = fixture.invoke(["--runtime", fixture.work]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEVELOPMENT_DELIVERY_RUNTIME_INVALID/);
  await assert.rejects(access(fixture.destination));
  for (const file of ["package.json", "pnpm-lock.yaml"]) {
    const path = join(fixture.runtime, file);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("\n")]));
    const changed = fixture.invoke();
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /DEVELOPMENT_DELIVERY_RUNTIME_INVALID/);
    await assert.rejects(access(fixture.destination));
    await writeFile(path, original);
  }
  const installed = join(fixture.runtime, "node_modules/tar");
  const outside = join(fixture.work, "external-tar");
  await rename(installed, outside);
  await symlink(outside, installed);
  const linked = fixture.invoke();
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /DEVELOPMENT_DELIVERY_RUNTIME_INVALID/);
  await assert.rejects(access(fixture.destination));
});

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

test("unsupported HTML capabilities reject before production preparation or installation", async (t) => {
  const fixture = await requestFixture(t, { invalidHtmlCapability: true });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_HTML_CAPABILITY_INVALID/);
  assert.match(result.stderr, /"repo":"dsh-agent-workbench"/);
  assert.match(result.stderr, /"file":"lib\/static\/mps\/plugin.json"/);
  await assert.rejects(access(fixture.destination));
});

test("capacity rejection precedes expensive archive and public-export checks", async (t) => {
  const fixture = await requestFixture(t, { missingClient: true });
  await writeFile(
    join(fixture.work, "cli/build-admission.mjs"),
    'export function holdBuildAdmission() { throw Error("BUILD_CAPACITY_INSUFFICIENT"); }',
  );
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.match(result.stderr, /BUILD_CAPACITY_INSUFFICIENT/);
  await assert.rejects(access(fixture.destination));
});

test("a missing archived build output has a specific preflight diagnostic", async (t) => {
  const fixture = await requestFixture(t);
  const request = JSON.parse(await readFile(fixture.input, "utf8"));
  const owner = request.repositories.find((row) => row.repo === "dsh-agent-workbench");
  const bytes = "{}\n";
  await writeFile(join(owner.path, "lib/provenance.json"), bytes);
  const build = JSON.parse(await readFile(owner.buildReceipt, "utf8"));
  build.outputs.push({ path: "lib/provenance.json", sha256: hash(bytes) });
  await writeFile(owner.buildReceipt, JSON.stringify(build));
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.match(result.stderr, /DELIVERY_BUILD_OUTPUT_MISSING_IN_ARCHIVE/);
  assert.match(result.stderr, /"repo":"dsh-agent-workbench","stage":"raw-archive"/);
  await assert.rejects(access(fixture.destination));
});

test("the real Manage git repository metadata survives ordinary three-package delivery", async (t) => {
  const fixture = await requestFixture(t, {
    manageRepository: true,
    successfulPackageManager: true,
  });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
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

test("delivery accepts CRLF archive listings and still rejects missing public exports", async (t) => {
  const fixture = await requestFixture(t, {
    tarOutputCRLF: true,
    successfulPackageManager: true,
  });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(fixture.destination, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "packaged");
  assert.equal(manifest.packages.length, 3);

  const missing = await requestFixture(t, { tarOutputCRLF: true, missingClient: true });
  const rejected = spawnSync(
    process.execPath,
    [missing.entry, "--input", missing.input, "--destination", missing.destination],
    { cwd: "/", encoding: "utf8", env: missing.env },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /DELIVERY_PUBLIC_EXPORT_MISSING/);
  await assert.rejects(access(missing.destination));
});

test("successful delivery keeps package bodies out of bounded command diagnostics", async (t) => {
  const marker = "DELIVERY_PACKAGE_BODY_";
  const hostSource = `module.exports = ${JSON.stringify(marker.repeat(4096))};\n`;
  const fixture = await requestFixture(t, {
    successfulPackageManager: true,
    hostSource,
  });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(await readFile(join(fixture.destination, "manifest.json"), "utf8"));
  assert.equal(receipt.status, "packaged");
  for (const row of receipt.packages) {
    assert.equal(
      execFileSync(
        "tar",
        ["-xOf", join(fixture.destination, "packages", row.filename), "package/lib/host.js"],
        { encoding: "utf8" },
      ),
      hostSource,
    );
  }
  const evidence = join(fixture.destination, "evidence");
  const logs = (await readdir(evidence)).filter((name) => /^commands?(?:-\d+)?\.log$/.test(name));
  assert.deepEqual(logs, ["commands.log"]);
  const bytes = await readFile(join(evidence, logs[0]));
  assert.ok(!bytes.includes(marker));
  const summaries = bytes
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(summaries.length > 1);
  for (const [index, summary] of summaries.entries()) {
    assert.equal(summary.command, index + 1);
    assert.equal(summary.exit, 0);
    assert.equal(typeof summary.stdoutBytes, "number");
    assert.match(summary.stdoutSha256, /^[a-f0-9]{64}$/);
  }
  const info = await stat(join(evidence, logs[0]));
  const files = await Promise.all(
    (await readdir(evidence)).map((name) => stat(join(evidence, name))),
  );
  t.diagnostic(
    JSON.stringify({
      commandLogFiles: logs.length,
      commands: summaries.length,
      bytes: info.size,
      allocatedBytes: info.blocks * 512,
      evidenceFiles: files.filter((file) => file.isFile()).length,
      evidenceBytes: files.reduce((sum, file) => sum + file.size, 0),
      evidenceAllocatedBytes: files.reduce((sum, file) => sum + file.blocks * 512, 0),
    }),
  );
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
      { cwd: "/", encoding: "utf8", env: fixture.env },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DELIVERY_SOURCE_DEPENDENCY_IN_PACKAGE/);
    await assert.rejects(access(join(fixture.destination, "manifest.json")));
    await assert.rejects(access(join(fixture.destination, "packages")));
  }
});

test("delivery still rejects sensitive package content beyond the diagnostic limit", async (t) => {
  const fixture = await requestFixture(t, {
    successfulPackageManager: true,
    hostSource: `module.exports = ${JSON.stringify("retained-content".repeat(4096) + "?token=private-package-token")};\n`,
  });
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_LOCAL_STATE_IN_PACKAGE/);
  assert.ok(!result.stderr.includes("private-package-token"));
  await assert.rejects(access(join(fixture.destination, "manifest.json")));
  await assert.rejects(access(join(fixture.destination, "packages")));
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
      { cwd: "/", encoding: "utf8", env: fixture.env },
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
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_PUBLIC_EXPORT_MISSING/);
  await assert.rejects(access(fixture.destination));
});

test("a failing production dependency command cannot publish success or expose its secrets", async (t) => {
  const fixture = await requestFixture(t);
  const input = JSON.parse(await readFile(fixture.input, "utf8"));
  await writeFile(
    input.pnpm,
    `process.stdout.write('fixture stdout context\\npassword=private-stdout-token\\n' + 'OUT'.repeat(16384) + '\\nsecret=private-trailing-token\\n');
process.stderr.write('fixture stderr context\\nhttp://localhost:1234/?token=private-command-token Authorization: Bearer private-bearer-token\\n' + 'ERR'.repeat(16384));
process.exit(7);\n`,
  );
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", fixture.destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_COMMAND_FAILED/);
  assert.ok(!result.stderr.includes("private-command-token"));
  assert.ok(!result.stderr.includes("private-bearer-token"));
  const diagnostic = await readFile(join(fixture.destination, "evidence/command-1.log"), "utf8");
  assert.deepEqual(
    (await readdir(join(fixture.destination, "evidence"))).filter((name) =>
      /^commands?(?:-\d+)?\.log$/.test(name),
    ),
    ["command-1.log"],
  );
  assert.match(diagnostic, /^exit=[1-9]\d*\n/);
  assert.match(diagnostic, /redacted sensitive command output/);
  assert.ok(!diagnostic.includes("private-command-token"));
  assert.ok(!diagnostic.includes("private-bearer-token"));
  assert.ok(!diagnostic.includes("private-stdout-token"));
  assert.ok(!diagnostic.includes("private-trailing-token"));
  assert.ok(Buffer.byteLength(diagnostic) <= 8704);
  assert.match(diagnostic, /fixture stdout context/);
  assert.match(diagnostic, /fixture stderr context/);
  assert.match(diagnostic, /\[truncated\]/);
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
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_STALE_BUILD_ARCHIVE/);
  await assert.rejects(access(fixture.destination));
});

test("companion curation excludes machine-bound build provenance while retaining public code and page assets", async (t) => {
  const fixture = await requestFixture(t, { successfulPackageManager: true });
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
  const build = JSON.parse(await readFile(owner.buildReceipt, "utf8"));
  for (const file of ["build-inputs.json", "index.html"])
    build.outputs.push({
      path: "lib/business/inventory-customer/" + file,
      sha256: hash(await readFile(join(business, file))),
    });
  await writeFile(owner.buildReceipt, JSON.stringify(build));
  const destination = join(fixture.work, "full-delivery");
  const result = spawnSync(
    process.execPath,
    [fixture.entry, "--input", fixture.input, "--destination", destination],
    { cwd: "/", encoding: "utf8", env: fixture.env },
  );
  assert.equal(result.status, 0, result.stderr);
  const delivered = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
  const published = delivered.packages.find((row) => row.repo === owner.repo);
  assert.deepEqual(published.excludedProvenanceFiles, receipt.excludedProvenanceFiles);
  const publishedFiles = execFileSync(
    "tar",
    ["-tzf", join(destination, "packages", published.filename)],
    {
      encoding: "utf8",
    },
  );
  assert.ok(!publishedFiles.includes("build-inputs.json"));
  assert.ok(publishedFiles.includes("package/lib/business/inventory-customer/index.html"));
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
    { encoding: "utf8", env: fixture.env },
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
    { head: "6f88c3ea2d266ba1825d88bab10d92479a6ffde8", version: "0.2.0-rc.2" },
    { head: "0337d907d0c1305edfa0c915886a203e5e55539d", version: "0.2.0-rc.2" },
    { head: "a0c0d2ff884b1808eccb9bb254a1659281364d7d", version: "0.2.0-rc.2" },
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
    { encoding: "utf8", env: fixture.env },
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
    { encoding: "utf8", env: fixture.env },
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
    { encoding: "utf8", env: fixture.env },
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
    { encoding: "utf8", env: fixture.env },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_COMPILED_VERSION_MISMATCH/);
  await assert.rejects(access(fixture.destination));
});

test("one-pass archive validation retains binary hashes, missing output and link rejection", async (t) => {
  const work = await mkdtemp(join(tmpdir(), "archive-integrity-"));
  t.after(() => rm(work, { recursive: true, force: true }));
  await mkdir(join(work, "package/lib"), { recursive: true });
  const bytes = Buffer.from([0, 255, 13, 10, 7]);
  await writeFile(join(work, "package/lib/host.js"), bytes);
  await writeFile(join(work, "package/lib/client.js"), "client");
  const manifest = { exports: { ".": "./lib/host.js", "./client": "./lib/client.js" } };
  const outputs = [
    { path: "lib/host.js", sha256: hash(bytes) },
    { path: "lib/client.js", sha256: hash("client") },
  ];
  const archive = join(work, "package.tgz");
  const pack = () => execFileSync("tar", ["-czf", archive, "-C", work, "package"]);
  pack();
  assert.doesNotThrow(() => builtArchive(archive, manifest, outputs));
  assert.throws(
    () =>
      builtArchive(archive, manifest, [...outputs, { path: "lib/missing.js", sha256: hash("") }]),
    /DELIVERY_BUILD_OUTPUT_MISSING_IN_ARCHIVE/,
  );
  const duplicate = join(work, "duplicate.tar");
  execFileSync("tar", ["-cf", duplicate, "-C", work, "package"]);
  execFileSync("tar", ["-rf", duplicate, "-C", work, "package/lib/host.js"]);
  assert.throws(() => builtArchive(duplicate, manifest, outputs), /DELIVERY_ARCHIVE_INVALID/);
  await writeFile(join(work, "package/lib/host.js"), "changed");
  pack();
  assert.throws(() => builtArchive(archive, manifest, outputs), /DELIVERY_STALE_BUILD_ARCHIVE/);
  await rm(join(work, "package/lib/host.js"));
  const { symlink } = await import("node:fs/promises");
  await symlink("client.js", join(work, "package/lib/host.js"));
  pack();
  assert.throws(() => builtArchive(archive, manifest, outputs), /DELIVERY_ARCHIVE_INVALID/);
});
