import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  statSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const cli = resolve(import.meta.dirname, "quality-prepared-inputs.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quality-transport-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, bytes) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), bytes);
  };
  const json = (file, value) => put(file, JSON.stringify(value, null, 2) + "\n");
  const repositories = ["dsh-agent-manage", "dsh-agent-workbench", "dsh-gea-plugin"].map(
    (repo) => ({
      repo,
      path: join(root, repo === "dsh-agent-workbench" ? "source" : "candidate", repo),
      head: "a".repeat(40),
    }),
  );
  const candidate = { core: "b".repeat(40), repositories };
  for (const entry of repositories) {
    fSource(
      entry.path,
      entry.repo === "dsh-agent-workbench" ? "package-lock.json" : "pnpm-lock.yaml",
      entry.repo,
    );
  }
  fSource(join(root, "official-latest-standard"), "pnpm-lock.yaml", "core");
  function fSource(directory, lock, name) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name,
        ...(name === "dsh-agent-manage" ? { exports: { "./client": "./client/client.js" } } : {}),
        packageManager: lock === "package-lock.json" ? "npm@11.11.0" : "pnpm@11.11.0",
      }),
    );
    writeFileSync(join(directory, lock), "fixed " + name + " lock\n");
  }
  json("candidate-input.json", candidate);
  json("candidate-group.json", { groupId: "fixture" });
  const inputSha256 = hash(readFileSync(join(root, "candidate-input.json")));
  const binding = {
    inputSha256,
    manifest: candidate,
    runId: "123",
    runAttempt: "1",
    platform: "linux",
    arch: process.arch,
    node: process.versions.node,
    planSha256: "c".repeat(64),
    buildSha256: "d".repeat(64),
  };
  json("binding.json", binding);
  const plan = { runtime: false, browser: false, files: ["tests/fixture.test.mjs"] };
  json("quality-test-plan.json", plan);
  put("candidate/dsh-gea-plugin/lib/host.js", "generated host\n");
  chmodSync(join(root, "candidate/dsh-gea-plugin/lib/host.js"), 0o755);
  put("candidate/dsh-agent-manage/lib/host.js", "generated manage\n");
  put("candidate/dsh-agent-workbench/lib/types/host.d.ts", "generated Workbench declarations\n");
  put("candidate/dsh-agent-manage/client/client.js", "fixed public client");
  put("candidate/dsh-agent-manage/client/client.js.map", "fixed public sourcemap");
  json("quality-stages.json", {
    binding: { inputSha256, plan },
    stages: { prepare: { status: "passed" }, build: { status: "passed" } },
    artifacts: {
      [join(root, "candidate/dsh-agent-workbench/lib")]: {
        "types/host.d.ts": hash("generated Workbench declarations\n"),
      },
      ...Object.fromEntries(
        ["dsh-gea-plugin", "dsh-agent-manage"].map((repo) => [
          join(root, "candidate", repo, "lib"),
          { "host.js": hash(readFileSync(join(root, "candidate", repo, "lib/host.js"))) },
        ]),
      ),
      [join(root, "candidate/dsh-agent-manage/client")]: {
        "client.js": hash("fixed public client"),
        "client.js.map": hash("fixed public sourcemap"),
      },
    },
  });
  put("official-latest-standard/packages/core/test/lib/index.js", "fixed sdk\n");
  json("official-latest-standard/.git/dsh-sdk-artifacts.json", {
    identity: {
      coreCommit: candidate.core,
      node: process.version,
      platform: "linux",
      arch: process.arch,
    },
    artifacts: { "packages/core/test/lib/index.js": hash("fixed sdk\n") },
  });
  put("quality-upstreams/upstream-assets/genui-0.11.3/lib/index.js", "fixed genui");
  put("quality-upstreams/upstream-reference/dsh-better-sidebar/lib/index.js", "fixed sidebar");
  json("candidate/dsh-gea-plugin/scripts/quality-upstreams.json", {
    genui: { files: { "lib/index.js": hash("fixed genui") } },
  });
  const manifest = join(root, "transport.json"),
    bundle = join(root, "transport.tar");
  put(
    "environment.mjs",
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';Object.defineProperty(process,'platform',{value:process.env.FIXTURE_PLATFORM??'linux'});if(process.env.FIXTURE_NODE)Object.defineProperty(process.versions,'node',{value:process.env.FIXTURE_NODE});if(process.env.FIXTURE_ARCH)Object.defineProperty(process,'arch',{value:process.env.FIXTURE_ARCH});for(const [name,key] of [['modules','FIXTURE_MODULES'],['napi','FIXTURE_NAPI']])if(process.env[key]!==undefined)Object.defineProperty(process.versions,name,{value:process.env[key]});const report=process.report.getReport.bind(process.report);process.report.getReport=()=>{const value=report();value.header.glibcVersionRuntime=process.env.FIXTURE_GLIBC??'2.39';return value};const read=fs.readFileSync;fs.readFileSync=(file,...args)=>{if(file==='/etc/os-release'){if(process.env.FIXTURE_OS_RELEASE==='MISSING')throw Object.assign(Error('missing os-release'),{code:'ENOENT'});const value=process.env.FIXTURE_OS_RELEASE??'ID=ubuntu\\nVERSION_ID="24.04"\\nPRETTY_NAME="Ubuntu 24.04.5 LTS"\\n';return args[0]==='utf8'?value:Buffer.from(value)}return read(file,...args)};syncBuiltinESMExports();`,
  );
  const run = (action, extra = [], environment = {}) =>
    spawnSync(
      process.execPath,
      [
        cli,
        action,
        "--root",
        root,
        "--binding",
        join(root, "binding.json"),
        "--manifest",
        manifest,
        "--bundle",
        bundle,
        ...extra,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: "--import=" + join(root, "environment.mjs"),
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          ImageOS: "ubuntu24",
          ImageVersion: "image-20261004",
          ...environment,
        },
      },
    );
  return {
    root,
    put,
    json,
    binding,
    manifest,
    bundle,
    run,
    clearOutputs() {
      for (const file of [
        "candidate/dsh-gea-plugin/lib",
        "candidate/dsh-agent-manage/lib",
        "candidate/dsh-agent-workbench/lib",
        "candidate/dsh-agent-manage/client",
        "official-latest-standard/packages/core/test/lib",
        "official-latest-standard/.git/dsh-sdk-artifacts.json",
        "quality-upstreams/upstream-assets/genui-0.11.3",
        "quality-upstreams/upstream-reference/dsh-better-sidebar/lib",
      ])
        rmSync(join(root, file), { recursive: true });
    },
  };
}

test("the prepared-input CLI transfers declared generated bytes and executable modes without claiming dependency or quality acceptance", (t) => {
  const f = fixture(t);
  const exported = f.run("export");
  assert.equal(exported.status, 0, exported.stderr);
  const manifestSha256 = hash(readFileSync(f.manifest));
  f.clearOutputs();
  const received = f.run("receive", ["--manifest-sha256", manifestSha256], {
    ImageVersion: "image-20261012",
  });
  assert.equal(received.status, 0, received.stderr);
  const result = JSON.parse(received.stdout);
  assert.equal(result.status, "transport-verified");
  assert.equal(result.dependencies, "requires-lock-install");
  assert.equal(result.quality, "not-observed");
  assert.equal(result.environment.producer.imageVersion, "image-20261004");
  assert.equal(result.environment.consumer.imageVersion, "image-20261012");
  assert.equal(result.environment.consumer.osId, "ubuntu");
  assert.equal(result.environment.consumer.osVersionId, "24.04");
  assert.equal(result.environment.consumer.glibc, "2.39");
  assert.equal(
    readFileSync(join(f.root, "candidate/dsh-gea-plugin/lib/host.js"), "utf8"),
    "generated host\n",
  );
  assert.equal(statSync(join(f.root, "candidate/dsh-gea-plugin/lib/host.js")).mode & 0o777, 0o755);
  assert.equal(
    readFileSync(
      join(f.root, "quality-upstreams/upstream-assets/genui-0.11.3/lib/index.js"),
      "utf8",
    ),
    "fixed genui",
  );
});

test("the CLI preserves internal generated symlinks and refuses an equally readable external target", (t) => {
  const f = fixture(t);
  const link = "candidate/dsh-gea-plugin/lib/entry.js";
  symlinkSync("host.js", join(f.root, link));
  const stages = JSON.parse(readFileSync(join(f.root, "quality-stages.json")));
  stages.artifacts[join(f.root, "candidate/dsh-gea-plugin/lib")]["entry.js"] =
    "link:" + join(f.root, "candidate/dsh-gea-plugin/lib/host.js");
  // Existing producer inventories compare maps by keys, not filesystem enumeration order.
  f.json("quality-stages.json", stages);
  assert.equal(f.run("export").status, 0);
  const digest = hash(readFileSync(f.manifest));
  f.clearOutputs();
  const received = f.run("receive", ["--manifest-sha256", digest]);
  assert.equal(received.status, 0, received.stderr);
  assert.equal(readlinkSync(join(f.root, link)), "host.js");
  rmSync(f.manifest);
  rmSync(f.bundle);
  rmSync(join(f.root, link));
  f.put("source/outside.js", "generated host\n");
  symlinkSync("../../../source/outside.js", join(f.root, link));
  assert.notEqual(f.run("export").status, 0);
});

test("runtime exports cover generated Workbench, upstream, native and browser bytes while retaining source-only checkout and lock-install obligations", (t) => {
  const f = fixture(t);
  const plan = { runtime: true, browser: true, files: ["tests/fixture.test.mjs"] };
  f.json("quality-test-plan.json", plan);
  const stages = JSON.parse(readFileSync(join(f.root, "quality-stages.json")));
  stages.binding.plan = plan;
  delete stages.artifacts[join(f.root, "candidate/dsh-agent-workbench/lib")];
  f.json("quality-stages.json", stages);
  const workbenchFiles = {};
  for (const file of [
    "lib/host.js",
    "lib/client.js",
    "lib/types/host.d.ts",
    "lib/types/client.d.ts",
    "static/category/index.html",
    "static/mps/index.html",
    "static/regional/index.html",
  ]) {
    f.put("candidate/dsh-agent-workbench/" + file, "workbench " + file);
    workbenchFiles[file] = hash("workbench " + file);
  }
  f.json("prepared-workbench.json", {
    source: join(f.root, "source/dsh-agent-workbench"),
    prepared: join(f.root, "candidate/dsh-agent-workbench"),
    head: "a".repeat(40),
    files: workbenchFiles,
  });
  f.put("quality-upstreams/upstream-assets/genui-0.11.3/lib/index.js", "fixed genui");
  f.put("quality-upstreams/upstream-reference/dsh-better-sidebar/lib/index.js", "fixed sidebar");
  f.json("candidate/dsh-gea-plugin/scripts/quality-upstreams.json", {
    genui: { files: { "lib/index.js": hash("fixed genui") } },
  });
  f.put("official-latest-standard/apps/web/dist/index.html", "fixed web");
  f.json("official-latest-standard/.git/dsh-sdk-web.json", {
    artifacts: [{ path: "apps/web/dist/index.html", sha256: hash("fixed web") }],
  });
  const native = `native/system/packages/${f.binding.platform}-${process.arch}/flock.node`;
  f.put("official-latest-standard/" + native, "fixed native");
  f.json("official-latest-standard/.git/dsh-sdk-flock.json", {
    artifact: { path: native, sha256: hash("fixed native") },
  });
  const directories = ["chromium-1", "chromium_headless_shell-1", "ffmpeg-1"];
  const browserFiles = {};
  for (const directory of directories) {
    const file = ".quality-browser/" + directory + "/binary";
    f.put(file, directory);
    chmodSync(join(f.root, file), 0o755);
    browserFiles[join(f.root, file)] = hash(directory);
  }
  f.json("browser-preparation.json", {
    root: join(f.root, ".quality-browser"),
    executable: join(f.root, ".quality-browser/chromium-1/binary"),
    directories: directories.map((d) => join(f.root, ".quality-browser", d)),
    files: browserFiles,
  });
  f.put(".quality-system-chrome/chrome", "fixed Chrome");
  chmodSync(join(f.root, ".quality-system-chrome/chrome"), 0o755);
  const chrome = {
    schemaVersion: 1,
    status: "system-chrome-prepared",
    root: f.root,
    source: "/opt/google/chrome",
    sourceRootMode: 0o755,
    prepared: join(f.root, ".quality-system-chrome"),
    version: "Google Chrome 154.0.8037.97",
    package: { name: "google-chrome-stable", version: "154.0.8037.97-1", arch: "amd64" },
    entries: [
      {
        path: "chrome",
        type: "file",
        mode: 0o755,
        sourceMode: 0o755,
        size: 12,
        sha256: hash("fixed Chrome"),
      },
    ],
  };
  chrome.snapshotSha256 = hash(
    JSON.stringify({
      source: chrome.source,
      sourceRootMode: chrome.sourceRootMode,
      prepared: chrome.prepared,
      version: chrome.version,
      package: chrome.package,
      entries: chrome.entries,
    }),
  );
  f.json("system-chrome-preparation.json", chrome);
  const exported = f.run("export");
  assert.equal(exported.status, 0, exported.stderr);
  f.clearOutputs();
  for (const file of [
    "candidate/dsh-agent-workbench/static",
    "quality-upstreams",
    "official-latest-standard/apps/web/dist",
    "official-latest-standard/native",
    ".quality-browser",
    ".quality-system-chrome",
    "system-chrome-preparation.json",
    "official-latest-standard/.git/dsh-sdk-web.json",
    "official-latest-standard/.git/dsh-sdk-flock.json",
  ])
    rmSync(join(f.root, file), { recursive: true });
  const received = f.run("receive", ["--manifest-sha256", hash(readFileSync(f.manifest))]);
  assert.equal(received.status, 0, received.stderr);
  assert.equal(
    readFileSync(join(f.root, "candidate/dsh-agent-workbench/lib/host.js"), "utf8"),
    "workbench lib/host.js",
  );
  assert.equal(
    readFileSync(join(f.root, "official-latest-standard/" + native), "utf8"),
    "fixed native",
  );
  assert.equal(statSync(join(f.root, ".quality-browser/chromium-1/binary")).mode & 0o777, 0o755);
});

test("export refuses a generated output root that redirects reads into another directory", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "candidate/dsh-gea-plugin/lib"), { recursive: true });
  f.put("unrelated/host.js", "generated host\n");
  chmodSync(join(f.root, "unrelated/host.js"), 0o755);
  symlinkSync(join(f.root, "unrelated"), join(f.root, "candidate/dsh-gea-plugin/lib"));
  assert.notEqual(f.run("export").status, 0);
});

test("selected desktop packaging receives its three generated tool outputs without running their builder", (t) => {
  const f = fixture(t),
    plan = { runtime: false, browser: false, files: ["scripts/package-desktop.test.mjs"] };
  f.json("quality-test-plan.json", plan);
  const stages = JSON.parse(readFileSync(join(f.root, "quality-stages.json")));
  stages.binding.plan = plan;
  f.json("quality-stages.json", stages);
  const files = [
    "download-differential.cjs",
    "core-asar-reader.cjs",
    "download-differential.LICENSE.txt",
  ];
  for (const file of files) f.put("candidate/dsh-gea-plugin/desktop/" + file, "built " + file);
  assert.equal(f.run("export").status, 0);
  const digest = hash(readFileSync(f.manifest));
  f.clearOutputs();
  rmSync(join(f.root, "candidate/dsh-gea-plugin/desktop"), { recursive: true });
  const result = f.run("receive", ["--manifest-sha256", digest]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(f.root, "candidate/dsh-gea-plugin/desktop/core-asar-reader.cjs"), "utf8"),
    "built core-asar-reader.cjs",
  );
});

test("receive may replace a declared clean Git build output but preserves an edited output", (t) => {
  for (const edited of [false, true]) {
    const f = fixture(t),
      repo = join(f.root, "candidate/dsh-gea-plugin");
    const git = (...args) => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-q");
    f.put("candidate/dsh-gea-plugin/lib/host.js", "checked-in build\n");
    git("add", "lib/host.js");
    git(
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid.test",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "fixture",
    );
    const candidate = JSON.parse(readFileSync(join(f.root, "candidate-input.json")));
    candidate.repositories.find((entry) => entry.repo === "dsh-gea-plugin").head = git(
      "rev-parse",
      "HEAD",
    );
    f.json("candidate-input.json", candidate);
    f.binding.manifest = candidate;
    f.binding.inputSha256 = hash(readFileSync(join(f.root, "candidate-input.json")));
    f.json("binding.json", f.binding);
    const stages = JSON.parse(readFileSync(join(f.root, "quality-stages.json")));
    stages.binding.inputSha256 = f.binding.inputSha256;
    f.json("quality-stages.json", stages);
    f.put("candidate/dsh-gea-plugin/lib/host.js", "generated host\n");
    chmodSync(join(repo, "lib/host.js"), 0o755);
    assert.equal(f.run("export").status, 0);
    const digest = hash(readFileSync(f.manifest));
    f.clearOutputs();
    f.put("candidate/dsh-gea-plugin/lib/host.js", edited ? "user edit\n" : "checked-in build\n");
    chmodSync(join(repo, "lib/host.js"), 0o755);
    const result = f.run("receive", ["--manifest-sha256", digest]);
    assert.equal(result.status, edited ? 1 : 0, result.stderr);
    assert.equal(
      readFileSync(join(repo, "lib/host.js"), "utf8"),
      edited ? "user edit\n" : "generated host\n",
    );
  }
});

test("receive rejects old run, attempt, candidate, platform, Node and opaque build bindings", (t) => {
  const changes = {
    runId: "124",
    runAttempt: "2",
    inputSha256: "e".repeat(64),
    platform: "other-os",
    arch: "other-arch",
    node: "v24.0.0",
    buildSha256: "e".repeat(64),
    planSha256: "e".repeat(64),
  };
  for (const [key, value] of Object.entries(changes)) {
    const f = fixture(t);
    assert.equal(f.run("export").status, 0);
    f.clearOutputs();
    f.json("binding.json", { ...f.binding, [key]: value });
    const result = f.run("receive", ["--manifest-sha256", hash(readFileSync(f.manifest))]);
    assert.equal(result.status, 1, key);
  }
});

test("receive rejects a changed source lock or declared package manager while preserving the opaque caller binding", (t) => {
  for (const file of [
    "candidate/dsh-gea-plugin/pnpm-lock.yaml",
    "source/dsh-agent-workbench/package-lock.json",
    "official-latest-standard/pnpm-lock.yaml",
    "candidate/dsh-agent-manage/package.json",
  ]) {
    const f = fixture(t);
    assert.equal(f.run("export").status, 0);
    const digest = hash(readFileSync(f.manifest));
    f.clearOutputs();
    f.put(file, file.endsWith(".json") ? '{"packageManager":"other"}' : "changed lock\n");
    const result = f.run("receive", ["--manifest-sha256", digest]);
    assert.equal(result.status, 1, file);
  }
});

test("export rejects changed pinned build, SDK, candidate bytes and missing required materials", (t) => {
  for (const file of [
    "candidate/dsh-gea-plugin/lib/host.js",
    "candidate/dsh-agent-workbench/lib/types/host.d.ts",
    "official-latest-standard/packages/core/test/lib/index.js",
    "candidate-input.json",
    "official-latest-standard/.git/dsh-sdk-artifacts.json",
  ]) {
    const f = fixture(t);
    f.put(file, "changed\n");
    assert.equal(f.run("export").status, 1, file);
  }
  const missing = fixture(t);
  rmSync(join(missing.root, "candidate/dsh-agent-manage/lib/host.js"));
  assert.equal(missing.run("export").status, 1);
});

test("receive validates the whole tar before publishing and refuses traversal, hardlinks, duplicates, bytes, modes and missing members", (t) => {
  for (const scenario of ["traversal", "hardlink", "duplicate", "bytes", "mode", "missing"]) {
    const f = fixture(t);
    assert.equal(f.run("export").status, 0);
    const changed = spawnSync(
      "python3",
      [
        "-c",
        `
import io,json,sys,tarfile
from pathlib import Path
root,manifest,bundle,scenario=sys.argv[1:]
entries=json.loads(Path(manifest).read_text())['entries']
with tarfile.open(bundle,'w') as archive:
 for index,entry in enumerate(entries):
  if scenario=='missing' and index==len(entries)-1: continue
  data=(Path(root)/entry['path']).read_bytes()
  member=tarfile.TarInfo(entry['path']);member.mode=entry['mode'];member.size=len(data)
  if index==len(entries)-1:
   if scenario=='hardlink': member.type=tarfile.LNKTYPE;member.linkname=entries[0]['path'];member.size=0
   if scenario=='bytes': data=b'x'*len(data)
   if scenario=='mode': member.mode^=0o100
  archive.addfile(member,io.BytesIO(data) if member.isfile() else None)
  if scenario=='duplicate' and index==0: archive.addfile(member,io.BytesIO(data))
 if scenario=='traversal':
  member=tarfile.TarInfo('../escaped');member.size=1;archive.addfile(member,io.BytesIO(b'x'))
`,
        f.root,
        f.manifest,
        f.bundle,
        scenario,
      ],
      { encoding: "utf8" },
    );
    assert.equal(changed.status, 0, changed.stderr);
    const manifest = JSON.parse(readFileSync(f.manifest));
    manifest.bundleSha256 = hash(readFileSync(f.bundle));
    f.json("transport.json", manifest);
    f.clearOutputs();
    const result = f.run("receive", ["--manifest-sha256", hash(readFileSync(f.manifest))]);
    assert.equal(result.status, 1, scenario);
    assert.throws(() => readFileSync(join(f.root, "candidate/dsh-gea-plugin/lib/host.js")), {
      code: "ENOENT",
    });
  }
});

test("receive refuses parent redirects, undeclared overwrites, archive tampering and a wrong manifest digest", (t) => {
  for (const scenario of ["parent", "overwrite", "bundle", "manifest"]) {
    const f = fixture(t);
    assert.equal(f.run("export").status, 0);
    const digest = hash(readFileSync(f.manifest));
    f.clearOutputs();
    if (scenario === "parent") {
      mkdirSync(join(f.root, "outside"));
      symlinkSync(join(f.root, "outside"), join(f.root, "candidate/dsh-gea-plugin/lib"));
    }
    if (scenario === "overwrite") f.put("candidate/dsh-gea-plugin/lib/host.js", "user bytes\n");
    if (scenario === "bundle") writeFileSync(f.bundle, "changed archive");
    const result = f.run("receive", [
      "--manifest-sha256",
      scenario === "manifest" ? "0".repeat(64) : digest,
    ]);
    assert.equal(result.status, 1, scenario);
    if (scenario === "overwrite")
      assert.equal(
        readFileSync(join(f.root, "candidate/dsh-gea-plugin/lib/host.js"), "utf8"),
        "user bytes\n",
      );
  }
});

test("the upstream CLI can prepare fixed source checkouts without downloading assets, installing dependencies or building", (t) => {
  const f = fixture(t),
    tools = join(f.root, "tools");
  mkdirSync(tools);
  for (const file of ["quality-upstreams.mjs", "source-combination-integrity.mjs"])
    writeFileSync(join(tools, file), readFileSync(join(import.meta.dirname, file)));
  const heads = {};
  for (const repo of ["genui", "sidebar"]) {
    const source = join(f.root, "origins", repo);
    mkdirSync(source, { recursive: true });
    f.json("origins/" + repo + "/package.json", {
      name: repo,
      packageManager: "pnpm@11.8.0",
      scripts: { build: "touch forbidden-build" },
    });
    f.put("origins/" + repo + "/pnpm-lock.yaml", "fixed fixture lock\n");
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@invalid.test",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "fixture",
      ],
    ])
      assert.equal(spawnSync("git", ["-C", source, ...args]).status, 0);
    heads[repo] = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
  }
  f.json("tools/quality-upstreams.json", {
    genui: { repository: join(f.root, "origins/genui"), head: heads.genui },
    sidebar: {
      repository: join(f.root, "origins/sidebar"),
      head: heads.sidebar,
      lockSha256: hash("fixed fixture lock\n"),
      packageManager: "pnpm@11.8.0",
    },
  });
  const output = join(f.root, "owned-upstreams");
  const result = spawnSync(
    process.execPath,
    [join(tools, "quality-upstreams.mjs"), "--root", output, "--source-only"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)).status, "source-only");
  for (const repo of ["dsh-genui", "dsh-better-sidebar"]) {
    assert.throws(() => statSync(join(output, "upstream-reference", repo, "node_modules")), {
      code: "ENOENT",
    });
    assert.throws(() => statSync(join(output, "upstream-reference", repo, "forbidden-build")), {
      code: "ENOENT",
    });
  }
  assert.throws(() => statSync(join(output, "upstream-assets")), { code: "ENOENT" });
});

test("transport reads its own Linux OS and runtime ABI, rejecting drift, missing values and old environment formats", (t) => {
  const cases = [
    { ImageOS: "other-image-os" },
    { FIXTURE_OS_RELEASE: 'ID=debian\nVERSION_ID="24.04"\n' },
    { FIXTURE_OS_RELEASE: 'ID=ubuntu\nVERSION_ID="24.10"\n' },
    { FIXTURE_PLATFORM: "other-os" },
    { FIXTURE_ARCH: "other-arch" },
    { FIXTURE_NODE: "24.0.0" },
    { FIXTURE_MODULES: String(Number(process.versions.modules) + 1) },
    { FIXTURE_NAPI: String(Number(process.versions.napi) + 1) },
    { FIXTURE_GLIBC: "2.40" },
    { ImageOS: "" },
    { ImageVersion: "" },
    { FIXTURE_MODULES: "" },
    { FIXTURE_NAPI: "" },
    { FIXTURE_GLIBC: "" },
    { FIXTURE_OS_RELEASE: "MISSING" },
    { FIXTURE_OS_RELEASE: 'VERSION_ID="24.04"\n' },
    { FIXTURE_OS_RELEASE: "ID=ubuntu\n" },
    { FIXTURE_OS_RELEASE: 'ID="ubuntu\nVERSION_ID=24.04\n' },
  ];
  for (const environment of cases) {
    const f = fixture(t);
    assert.equal(f.run("export").status, 0);
    const digest = hash(readFileSync(f.manifest));
    f.clearOutputs();
    const r = f.run("receive", ["--manifest-sha256", digest], environment);
    assert.equal(r.status, 1, JSON.stringify(environment));
    assert.match(r.stderr, /QUALITY_(?:PREPARED|RUNNER_ENVIRONMENT)_REJECTED/);
  }
  const old = fixture(t);
  assert.equal(old.run("export").status, 0);
  const manifest = JSON.parse(readFileSync(old.manifest));
  delete manifest.environment.modules;
  old.json("transport.json", manifest);
  old.clearOutputs();
  const r = old.run("receive", ["--manifest-sha256", hash(readFileSync(old.manifest))]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /modules/);
  for (const missing of [
    { FIXTURE_GLIBC: "" },
    { FIXTURE_OS_RELEASE: "MISSING" },
    { FIXTURE_NAPI: "" },
  ]) {
    const f = fixture(t);
    assert.equal(
      f.run("export", [], missing).status,
      1,
      "producer and worker cannot both omit required runtime facts",
    );
  }
});

test("the transport accepts exactly the declared Manage client and sourcemap and refuses missing, extra, unknown or redirected outputs", (t) => {
  for (const change of [
    "missing-map",
    "omitted-map",
    "extra-file",
    "extra-directory",
    "unknown-root",
    "changed-export",
  ]) {
    const f = fixture(t);
    const stages = JSON.parse(readFileSync(join(f.root, "quality-stages.json")));
    const client = join(f.root, "candidate/dsh-agent-manage/client");
    if (change === "missing-map" || change === "omitted-map") rmSync(join(client, "client.js.map"));
    if (change === "omitted-map") delete stages.artifacts[client]["client.js.map"];
    if (change === "extra-file") {
      f.put("candidate/dsh-agent-manage/client/other.js", "extra");
      stages.artifacts[client]["other.js"] = hash("extra");
    }
    if (change === "extra-directory") mkdirSync(join(client, "empty-extra"));
    if (change === "unknown-root")
      stages.artifacts[join(f.root, "candidate/dsh-agent-manage/src")] = {
        "index.ts": hash("source"),
      };
    if (change === "changed-export") {
      const manifest = JSON.parse(
        readFileSync(join(f.root, "candidate/dsh-agent-manage/package.json")),
      );
      manifest.exports["./client"] = "./client/other.js";
      f.json("candidate/dsh-agent-manage/package.json", manifest);
    }
    f.json("quality-stages.json", stages);
    const result = f.run("export");
    assert.equal(result.status, 1, change + ": " + result.stdout + result.stderr);
    assert.match(
      result.stderr,
      /QUALITY_STAGE_(ARTIFACT_REQUIRED|CLIENT_DECLARATION_CHANGED)|build bytes changed/,
      change,
    );
  }
});
