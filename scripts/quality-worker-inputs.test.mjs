import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  existsSync,
  chmodSync,
  statSync,
  symlinkSync,
  watch,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { createWorkerBinding } from "./quality-worker-inputs.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const own = resolve(import.meta.dirname, "..");
const workbenchSource =
  process.env.GEA_FINAL_GROUP_WORKBENCH_SOURCE ?? resolve(own, "../dsh-agent-workbench");
const manageSource =
  process.env.GEA_FINAL_GROUP_MANAGE_SOURCE ?? resolve(own, "../dsh-agent-manage");
function fixture(
  t,
  {
    runtime = false,
    browser = false,
    withShards = false,
    concurrency = 2,
    publicQuality = false,
    actualPnpmConfig = false,
    earlyManagePlaywright = "1.58.2",
  } = {},
) {
  const testFiles = [
    "scripts/fixture.test.mjs",
    ...(publicQuality && withShards ? ["scripts/second.test.mjs"] : []),
  ];
  const coreManager = actualPnpmConfig ? "pnpm@11.7.0" : "pnpm@11.11.0";
  const pnpmConfigCli = actualPnpmConfig
    ? (process.env.GEA_TEST_PNPM_CONFIG_CLI ?? join(own, "node_modules/pnpm/bin/pnpm.cjs"))
    : null;
  if (actualPnpmConfig)
    assert.equal(
      JSON.parse(readFileSync(join(dirname(dirname(pnpmConfigCli)), "package.json"))).version,
      "11.7.0",
    );
  const platform = browser ? "linux" : process.platform;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quality-worker-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gea = join(root, "candidate/dsh-gea-plugin"),
    manage = join(root, "candidate/dsh-agent-manage"),
    wb = join(root, "source/dsh-agent-workbench"),
    coreSource = join(root, "source/official-core"),
    core = join(root, "official-latest-standard");
  const put = (file, bytes) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), bytes);
  };
  const json = (file, value) => put(file, JSON.stringify(value, null, 2) + "\n");
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (cwd) => {
    git(cwd, "init", "-q");
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "Fixed source",
    );
    return git(cwd, "rev-parse", "HEAD");
  };
  for (const file of [
    "quality-worker-inputs.mjs",
    "quality-runner-environment.mjs",
    "quality-system-chrome.mjs",
    "quality-prepared-inputs.mjs",
    "quality-prepared-tar.py",
    "quality-upstreams.mjs",
    "quality-workbench.mjs",
    "source-combination-integrity.mjs",
    "quality-test-execution.mjs",
    "source-check-shards.mjs",
    "quality-test-timings.mjs",
    "quality-hosted-budget.mjs",
    "quality-worker-control.mjs",
    "quality-ci-stages.mjs",
    "build-admission.mjs",
    "development-dependencies.mjs",
    "development-repositories.mjs",
  ])
    put("candidate/dsh-gea-plugin/scripts/" + file, readFileSync(join(own, "scripts", file)));
  if (publicQuality) {
    for (const file of [
      "run-quality-ci.mjs",
      "run-quality-checks.mjs",
      "source-profile.mjs",
      "source-composition.mjs",
      "supported-cores.mjs",
      "ci-platform-tests.mjs",
      "quality-test-reporter.mjs",
      "fixtures/delivery-history/navigation-r7-setup-failure.json.raw",
    ])
      put("candidate/dsh-gea-plugin/scripts/" + file, readFileSync(join(own, "scripts", file)));
    put("candidate/dsh-gea-plugin/tests/profile.mjs", "export {};\n");
    if (withShards)
      put(
        "candidate/dsh-gea-plugin/scripts/second.test.mjs",
        "import test from 'node:test'; test('second assigned file', () => {});\n",
      );
    put(
      "candidate/dsh-gea-plugin/scripts/fixture.test.mjs",
      `import '../tests/profile.mjs';import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';test('original CLI admitted all five public entries',()=>{const records=JSON.parse(readFileSync(process.env.GEA_TEST_SOURCE_INPUTS));assert.equal(records.length,5);const manage=records.find(x=>x.repo==='dsh-agent-manage');assert.equal(readFileSync(manage.source+'/client/client.js','utf8'),'fixed public client');writeFileSync(${JSON.stringify(join(root, "tests-executed"))},'actual Node test');});`,
    );
    json("candidate/dsh-gea-plugin/scripts/ci-test-policy.json", {
      schemaVersion: 1,
      required: testFiles,
      tests: testFiles,
      rules: [],
    });
  }
  if (withShards) {
    const source = process.env.GEA_QUALITY_SHARDS_SOURCE ?? join(own, "scripts/quality-shards.mjs");
    const bytes = readFileSync(source);
    put("candidate/dsh-gea-plugin/scripts/quality-shards.mjs", bytes);
    t.diagnostic(JSON.stringify({ callerSource: source, sha256: hash(bytes) }));
  }
  for (const file of ["prepare-official-sdk.mjs", "sdk-artifact-cache.mjs"])
    put(
      "candidate/dsh-agent-manage/scripts/" + file,
      readFileSync(join(manageSource, "scripts", file)),
    );
  for (const file of ["candidate-input.mjs", "ci-test-plan.mjs"])
    put(
      "source/dsh-agent-workbench/scripts/" + file,
      readFileSync(join(workbenchSource, "scripts", file)),
    );
  if (publicQuality) {
    for (const file of [
      "verify-candidate-input.mjs",
      "verify-official-input.mjs",
      "check-agent-knowledge.mjs",
    ])
      put(
        "source/dsh-agent-workbench/scripts/" + file,
        readFileSync(join(workbenchSource, "scripts", file)),
      );
    json("source/dsh-agent-workbench/agent-knowledge.json", {
      entries: [],
      paths: ["package.json", "package-lock.json"],
      scripts: [],
    });
  }
  const packages = [
    ["source/official-core", "official-core", coreManager, "pnpm-lock.yaml"],
    [
      "source/dsh-agent-workbench",
      "@cleverc2200/dsh-agent-workbench",
      "npm@11.11.0",
      "package-lock.json",
    ],
    ["candidate/dsh-agent-manage", "dsh-agent-manage", "pnpm@11.17.0", "pnpm-lock.yaml"],
    [
      "candidate/dsh-gea-plugin",
      "@cleverc2200/gea-dsh-prototype",
      "pnpm@11.27.0",
      "pnpm-lock.yaml",
    ],
  ];
  for (const [path, name, packageManager, lock] of packages) {
    json(path + "/package.json", {
      name,
      packageManager,
      type: "module",
      ...(browser && /dsh-agent-manage|dsh-gea-plugin/.test(path)
        ? {
            devDependencies: {
              "@playwright/test": path.endsWith("dsh-agent-manage")
                ? earlyManagePlaywright
                : "1.58.2",
            },
          }
        : {}),
      main: "lib/host.js",
      exports: {
        "./client": path.endsWith("dsh-agent-manage") ? "./client/client.js" : "./lib/client.js",
      },
    });
    put(path + "/cordis.patch.yml", "# fixed patch\n");
    put(path + "/" + lock, "fixed " + name + " lock\n");
    put(path + "/.gitignore", "node_modules/\nlib/\nclient/\napps/web/dist/\nnative/**/*.node\n");
  }
  json("source/official-core/packages/core/test/package.json", {
    name: "@fixture/core",
    main: "lib/index.js",
  });
  if (publicQuality)
    json("source/official-core/vendor/cordis/package.json", {
      name: "@deepseek-ai/cordis",
      types: "lib/types/index.d.ts",
    });
  json("candidate/dsh-gea-plugin/tsconfig.official.json", {
    compilerOptions: {
      paths: {
        "@fixture/core": ["../../official-latest-standard/packages/core/test/lib/index.js"],
      },
    },
  });
  json("source/dsh-agent-workbench/tsconfig.official.json", {
    compilerOptions: {
      paths: {
        "@deepseek-ai/cordis": [
          "../../official-latest-standard/vendor/cordis/lib/types/index.d.ts",
        ],
      },
    },
  });
  json("source/dsh-agent-workbench/business/inventory-apsplan/source/package.json", {
    name: "inventory",
  });
  put(
    "source/dsh-agent-workbench/business/inventory-apsplan/source/package-lock.json",
    "fixed inventory lock",
  );
  if (runtime) {
    put(
      "candidate/dsh-agent-manage/business-resources/inventory-aqkc/skills/inventory-policy/SKILL.md",
      "Only admitted inventory rows may be read.\n",
    );
    put(
      "source/dsh-agent-workbench/.gitignore",
      "node_modules/\nlib/*\n!lib/business/\nlib/business/*\n!lib/business/inventory-aqkc/\nlib/business/inventory-aqkc/*\n!lib/business/inventory-aqkc/skills/\n",
    );
  }
  const coreHead = commit(coreSource),
    wbHead = commit(wb),
    manageHead = commit(manage);
  git(wb, "remote", "add", "source", "https://github.com/CleverC2200/dsh-agent-workbench.git");
  const registry = [
    {
      head: coreHead,
      nodeMajor: 24,
      lockSha256: hash(readFileSync(join(coreSource, "pnpm-lock.yaml"))),
      packageManager: coreManager,
    },
  ];
  json("candidate/dsh-gea-plugin/scripts/supported-cores.json", registry);
  const fixed = { genui: { files: { "package.json": hash("{}\n") } }, sidebar: {} };
  for (const name of ["dsh-genui", "dsh-better-sidebar"]) {
    const original = "original/" + name;
    json(original + "/package.json", {
      name: name === "dsh-genui" ? "@changfenhuang/dsh-genui" : name,
      version: "0.11.3",
      packageManager: "pnpm@11.8.0",
      main: "lib/index.js",
      types: "lib/types/index.d.ts",
      exports: { "./client": "./lib/client.js" },
    });
    for (const file of [
      "cordis.patch.yml",
      "SKILL.md",
      "locale/en.json",
      "locale/zh.json",
      "icon.svg",
    ])
      put(original + "/" + file, "fixed tracked resource");
    put(original + "/pnpm-lock.yaml", "fixed sidebar lock");
    put(original + "/.gitignore", "lib/\nnode_modules/\n");
    const head = commit(join(root, original));
    const entry = name === "dsh-genui" ? fixed.genui : fixed.sidebar;
    Object.assign(entry, { repository: join(root, original), head });
    if (name === "dsh-better-sidebar")
      Object.assign(entry, {
        lockSha256: hash(readFileSync(join(root, original, "pnpm-lock.yaml"))),
        packageManager: "pnpm@11.8.0",
      });
    mkdirSync(join(root, "quality-upstreams/upstream-reference"), { recursive: true });
    git(
      join(root, "quality-upstreams/upstream-reference"),
      "clone",
      "--origin",
      "source",
      join(root, original),
      join(root, "quality-upstreams/upstream-reference", name),
    );
    if (name === "dsh-better-sidebar")
      git(
        join(root, "quality-upstreams/upstream-reference", name),
        "config",
        "--local",
        "dsh.qualityUpstream",
        "independent-fixed-sidebar",
      );
  }
  json("candidate/dsh-gea-plugin/scripts/quality-upstreams.json", fixed);
  if (publicQuality)
    json("candidate/dsh-gea-plugin/scripts/quality-peer-baseline.json", {
      repositories: [
        { repo: "dsh-agent-workbench", head: wbHead },
        { repo: "dsh-agent-manage", head: manageHead },
        { repo: "dsh-gea-plugin", head: "a".repeat(40) },
      ],
    });
  if (publicQuality) {
    for (const file of [
      "client.js",
      "invariant.js",
      "client-registry.js",
      "client-editor.js",
      "client-locale.js",
      "client-mermaid.js",
      "types/index.d.ts",
      "types/client/service.d.ts",
    ])
      put("quality-upstreams/upstream-reference/dsh-better-sidebar/lib/" + file, "fixed sidebar");
    const sourceManifest = JSON.parse(readFileSync(join(root, "original/dsh-genui/package.json")));
    const genui = {
      "package.json": JSON.stringify(sourceManifest) + "\n",
      "lib/index.js": "fixed genui",
      "lib/client.js": "fixed client",
      "cordis.patch.yml": "fixed patch",
      "SKILL.md": "fixed skill",
    };
    fixed.genui.files = {};
    for (const [file, bytes] of Object.entries(genui)) {
      put("quality-upstreams/upstream-assets/genui-0.11.3/" + file, bytes);
      fixed.genui.files[file] = hash(bytes);
    }
    json("candidate/dsh-gea-plugin/scripts/quality-upstreams.json", fixed);
    // The complete generated inventory is frozen at the producer; Git source declarations are already fixed.
  }
  const geaHead = commit(gea);
  for (const path of [manage, gea])
    git(
      path,
      "remote",
      "add",
      "source",
      "https://github.com/CleverC2200/" + path.split("/").at(-1) + ".git",
    );
  const candidate = {
    core: coreHead,
    repositories: [
      { repo: "dsh-agent-workbench", path: wb, head: wbHead },
      { repo: "dsh-agent-manage", path: manage, head: manageHead },
      { repo: "dsh-gea-plugin", path: gea, head: geaHead },
    ],
  };
  json("candidate-input.json", candidate);
  json("candidate-group.json", { groupId: "fixture" });
  let plan = { runtime, browser, files: testFiles };
  json("quality-test-plan.json", plan);
  const binding = {
    inputSha256: hash(readFileSync(join(root, "candidate-input.json"))),
    manifest: candidate,
    phase: "quality",
    coreSource,
    runId: "123",
    runAttempt: "1",
    node: process.versions.node,
    platform,
    arch: process.arch,
  };
  const contents = {
    schemaVersion: 1,
    binding,
    files: plan.files,
    selected: plan.files,
    shards: [{ id: "1", files: plan.files }],
    concurrency,
  };
  let executionPlan = { ...contents, planSha256: hash(JSON.stringify(contents)) };
  json("quality-test-execution-plan.json", executionPlan);
  for (const repo of ["dsh-gea-plugin", "dsh-agent-manage"]) {
    put("candidate/" + repo + "/lib/host.js", "fixed " + repo + " output");
    if (publicQuality && repo === "dsh-gea-plugin")
      put("candidate/" + repo + "/lib/client.js", "fixed lib client");
  }
  put("candidate/dsh-agent-manage/client/client.js", "fixed public client");
  put("candidate/dsh-agent-manage/client/client.js.map", "fixed public sourcemap");
  const stages = {
    binding: { inputSha256: binding.inputSha256, plan, executionPlan },
    stages: {
      prepare: { status: "passed" },
      build: { status: "passed" },
      checks: { status: "passed" },
    },
    checks: [],
    artifacts: Object.fromEntries(
      ["dsh-gea-plugin", "dsh-agent-manage"].map((repo) => [
        join(root, "candidate", repo, "lib"),
        { "host.js": hash("fixed " + repo + " output") },
      ]),
    ),
  };
  stages.artifacts[join(manage, "client")] = {
    "client.js": hash("fixed public client"),
    "client.js.map": hash("fixed public sourcemap"),
  };
  json("quality-stages.json", stages);
  git(root, "clone", "--no-hardlinks", coreSource, core);
  git(core, "config", "--local", "dsh.sdkPreparation", "independent-fixed-core");
  git(wb, "worktree", "add", "--detach", join(root, "candidate/dsh-agent-workbench"), wbHead);
  if (!runtime) {
    put("candidate/dsh-agent-workbench/lib/types/host.d.ts", "fixed Workbench declarations");
    stages.artifacts[join(root, "candidate/dsh-agent-workbench/lib")] = {
      "types/host.d.ts": hash("fixed Workbench declarations"),
    };
    json("quality-stages.json", stages);
  }
  put("official-latest-standard/packages/core/test/lib/index.js", "fixed SDK");
  const sdkIdentity = {
    coreCommit: coreHead,
    coreLock: registry[0].lockSha256,
    packageManager: registry[0].packageManager,
    nodeMajor: 24,
    node: process.version,
    platform,
    arch: process.arch,
    builder: hash(readFileSync(join(manage, "scripts/prepare-official-sdk.mjs"))),
  };
  json("official-latest-standard/.git/dsh-sdk-artifacts.json", {
    identity: sdkIdentity,
    artifacts: { "packages/core/test/lib/index.js": hash("fixed SDK") },
  });
  if (publicQuality) {
    put("official-latest-standard/vendor/cordis/lib/types/index.d.ts", "fixed Cordis declaration");
    const sdk = JSON.parse(readFileSync(join(core, ".git/dsh-sdk-artifacts.json")));
    sdk.artifacts["vendor/cordis/lib/types/index.d.ts"] = hash("fixed Cordis declaration");
    json("official-latest-standard/.git/dsh-sdk-artifacts.json", sdk);
  }
  if (runtime) {
    put(
      "candidate/dsh-agent-workbench/lib/business/inventory-aqkc/skills/inventory-policy/SKILL.md",
      "Only admitted inventory rows may be read.\n",
    );
    for (const file of ["host.js", "client.js", "types/host.d.ts", "types/client.d.ts"])
      put("candidate/dsh-agent-workbench/lib/" + file, "fixed Workbench");
    put("official-latest-standard/apps/web/dist/index.html", "fixed Web");
    json("official-latest-standard/.git/dsh-sdk-web.json", {
      artifacts: [{ path: "apps/web/dist/index.html", sha256: hash("fixed Web") }],
    });
    const native = "native/system/packages/" + platform + "-" + process.arch + "/flock.node";
    put("official-latest-standard/" + native, "fixed native");
    json("official-latest-standard/.git/dsh-sdk-flock.json", {
      artifact: { path: native, sha256: hash("fixed native") },
    });
  }
  if (!publicQuality) put("quality-upstreams/upstream-assets/genui-0.11.3/package.json", "{}\n");
  put("quality-upstreams/upstream-reference/dsh-better-sidebar/lib/index.js", "fixed sidebar");
  if (browser) {
    const directories = ["chromium", "headless", "ffmpeg"].map((name) =>
      join(root, ".quality-browser", name),
    );
    const files = {};
    for (const directory of directories) {
      const file = join(directory, "executable");
      put(file.slice(root.length + 1), "fixed browser executable");
      chmodSync(file, 0o755);
      files[file] = hash("fixed browser executable");
    }
    put("system/chrome", "producer Chrome bytes");
    chmodSync(join(root, "system/chrome"), 0o755);
    put("system/resources.pak", "Chrome resources");
    mkdirSync(join(root, "system/empty-locale"));
    chmodSync(join(root, "system"), 0o775);
    chmodSync(join(root, "system/empty-locale"), 0o770);
    json("package-files.json", [
      "/opt/google/chrome",
      "/opt/google/chrome/chrome",
      "/opt/google/chrome/resources.pak",
      "/opt/google/chrome/empty-locale",
    ]);
    json("browser-preparation.json", {
      root: join(root, ".quality-browser"),
      executable: join(directories[0], "executable"),
      directories,
      playwright: "1.58.2",
      lockSha256: hash(readFileSync(join(gea, "pnpm-lock.yaml"))),
      files,
    });
    json("candidate/dsh-gea-plugin/node_modules/@playwright/test/package.json", {
      type: "commonjs",
      version: "1.58.2",
      exports: { require: "./index.cjs", import: "./index.mjs" },
    });
    put(
      "fake-playwright.cjs",
      `const {appendFileSync}=require('node:fs');const chromium={executablePath:()=>${JSON.stringify(join(directories[0], "executable"))},launch:async options=>{if(process.env.FAIL_BROWSER==='1')throw Error('browser unavailable');appendFileSync(${JSON.stringify(join(root, "browser-launches.jsonl"))},JSON.stringify(options)+'\\n');return {version:()=>options.channel?'154.0.8037.97':'downloaded Chromium fixture',close:async()=>{}}}};Object.assign(module.exports,{chromium});`,
    );
  }
  if (browser)
    put(
      "candidate/dsh-gea-plugin/node_modules/@playwright/test/api.cjs",
      readFileSync(join(root, "fake-playwright.cjs")),
    );
  if (browser)
    put(
      "candidate/dsh-gea-plugin/node_modules/@playwright/test/index.cjs",
      "module.exports = require('./api.cjs');",
    );
  if (browser)
    put(
      "candidate/dsh-gea-plugin/node_modules/@playwright/test/index.mjs",
      "import api from './index.cjs';export const chromium=api.chromium;",
    );
  put(
    "browser-process.cjs",
    readFileSync(join(own, "scripts/fixtures/quality-browser-install.cjs")),
  );
  put(
    "install-process.mjs",
    String.raw`
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync, existsSync, watch } from 'node:fs';
import { join, basename } from 'node:path';
const [command, encoded] = process.argv.slice(2), args = JSON.parse(encoded);
const root = process.env.FIXTURE_PROCESS_ROOT, cwd = process.cwd();
if(args.includes('install-deps')&&process.env.BROWSER_SCENARIO){await import(join(root,'browser-process.cjs'));if(process.env.BROWSER_SCENARIO==='hang')await new Promise(()=>{});}
const install = args.includes('ci') || args.includes('install');
const trace = event => appendFileSync(join(root,'install-processes.jsonl'),JSON.stringify({event,pid:process.pid,cwd})+'\n');
if ((install || (process.env.INSTALL_SCENARIO==='cancel-path'&&args.includes('root'))) && process.env.PROCESS_INSTALLS === '1') {
  trace('start');
  writeFileSync(join(root,'started-'+basename(cwd)),String(process.pid));
  if (process.env.FIXTURE_ASYNC_INSTALL === '1' && process.env.PAIR_BARRIER === '1' && ['official-latest-standard','dsh-better-sidebar'].includes(basename(cwd))) {
    const other = basename(cwd)==='official-latest-standard'?'dsh-better-sidebar':'official-latest-standard';
    const file=join(root,'started-'+other);
    if (!existsSync(file)) await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{watcher.close();reject(Error('fixture pair never started'));},5000);
      const done=()=>{if(existsSync(file)){clearTimeout(timer);watcher.close();resolve();}};
      const watcher=watch(root,done);done();
    });
  }
}
process.env.FIXTURE_INSTALL_CHILD='1';
if ((install || (process.env.INSTALL_SCENARIO==='cancel-path'&&args.includes('root'))) && process.env.INSTALL_SCENARIO && basename(cwd)==='official-latest-standard') {
  process.on('SIGTERM',()=>{});
  const grandchild=spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.FIXTURE_PROCESS_ROOT+'/grandchild-ready',String(process.pid));fs.watch(process.env.FIXTURE_PROCESS_ROOT,()=>{if(fs.existsSync(process.env.FIXTURE_PROCESS_ROOT+'/release-grandchild'))fs.writeFileSync(process.env.FIXTURE_PROCESS_ROOT+'/late-write','escaped');});"],{stdio:'inherit'});
  if(process.env.INSTALL_SCENARIO==='leader-exit') {
    const file=join(root,'grandchild-ready');
    if(!existsSync(file))await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{watcher.close();reject(Error('grandchild not ready'))},5000);const done=()=>{if(existsSync(file)){clearTimeout(timer);watcher.close();resolve()}};const watcher=watch(root,done);done()});
    trace('leader-exit-zero');process.exit(0);
  }
  await new Promise(()=>{});
}
if (install && ['cancel','leader-exit'].includes(process.env.INSTALL_SCENARIO) && basename(cwd)==='dsh-better-sidebar') {writeFileSync(join(root,'second-install-ready'),'ready');watch(root,()=>{});await new Promise(()=>{});}
if (install && process.env.INSTALL_SCENARIO==='fail-second' && basename(cwd)==='dsh-better-sidebar') {
  const file=join(root,'grandchild-ready');
  if(!existsSync(file))await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{watcher.close();reject(Error('grandchild not ready'))},5000);const done=()=>{if(existsSync(file)){clearTimeout(timer);watcher.close();resolve()}};const watcher=watch(root,done);done()});
  writeFileSync(join(root,'second-install-ready'),'ready');
  process.stderr.write('controlled second install failure');process.exit(23);
}
const r=spawnSync(command,args,{cwd,encoding:'utf8',env:process.env});
if (install && process.env.PROCESS_INSTALLS === '1') trace('end');
process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');process.exitCode=r.status??1;
`,
  );
  const boundary = join(root, "commands.mjs");
  put(
    "commands.mjs",
    `import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
const fixtureTemp=${JSON.stringify(join(root, "build-admission-tmp"))};mkdirSync(fixtureTemp,{recursive:true});os.tmpdir=()=>fixtureTemp;
const statfs=fs.statfsSync;fs.statfsSync=(path,...args)=>{const value=statfs(path,...args);return relative(${JSON.stringify(root)},String(path)).startsWith('..')?value:{...value,bavail:128*1024**3/Number(value.bsize)}};
${browser ? "Object.defineProperty(process,'platform',{value:process.env.FIXTURE_PLATFORM??'linux'});if(process.env.FIXTURE_ARCH)Object.defineProperty(process,'arch',{value:process.env.FIXTURE_ARCH});" : ""}
if(${browser}){for(const [name,key] of [['modules','FIXTURE_MODULES'],['napi','FIXTURE_NAPI']])if(process.env[key]!==undefined)Object.defineProperty(process.versions,name,{value:process.env[key]});const report=process.report.getReport.bind(process.report);process.report.getReport=()=>{const value=report();value.header.glibcVersionRuntime=process.env.FIXTURE_GLIBC??'2.39';return value};const read=fs.readFileSync;fs.readFileSync=(file,...args)=>{if(file==='/etc/os-release'){if(process.env.FIXTURE_OS_RELEASE==='MISSING')throw Object.assign(Error('missing os-release'),{code:'ENOENT'});const value=process.env.FIXTURE_OS_RELEASE??'ID=ubuntu\\nVERSION_ID="24.04"\\nPRETTY_NAME="Ubuntu 24.04.5 LTS"\\n';return args[0]==='utf8'?value:Buffer.from(value)}return read(file,...args)}}
if(process.env.FIXTURE_NODE)Object.defineProperty(process.versions,'node',{value:process.env.FIXTURE_NODE});
const realExec=cp.execFileSync;cp.execFileSync=(command,args,options={})=>{if(${publicQuality}&&command==='corepack'){if(args.includes('--dry-run'))return ${JSON.stringify(["chromium", "headless", "ffmpeg"].map((name) => "Install location: " + join(root, ".quality-browser", name)).join("\n"))};return '11.27.0\\n';}return realExec(command,args,options)};
const realSpawn=cp.spawn;
cp.spawn=(command,args,options={})=>{
 if(${JSON.stringify(pnpmConfigCli)}&&command==='corepack'&&(args.includes('config')||args.includes('root'))&&options.cwd===${JSON.stringify(core)}){
   return realSpawn(process.execPath,[${JSON.stringify(pnpmConfigCli)},...args.slice(1)],{...options,env:{...options.env,NODE_OPTIONS:''}});
 }
 if(['npm','corepack'].includes(command)){
  const child=realSpawn(process.execPath,[${JSON.stringify(join(root, "install-process.mjs"))},command,JSON.stringify(args)],{...options,env:{...options.env,FIXTURE_PROCESS_ROOT:${JSON.stringify(root)},FIXTURE_ASYNC_INSTALL:'1'}});
  if((process.env.MUTATE_AFTER_MANAGERS==='1'||process.env.MUTATE_INSTALL_CONFIG==='1')&&(args.includes('install')||args.includes('ci')))appendFileSync(${JSON.stringify(join(root, "install-created.jsonl"))},JSON.stringify({pid:child.pid,cwd:options.cwd})+'\\n');
  return child;
 }
 return realSpawn(command,args,options);
};
const real=cp.spawnSync;
const realKill=process.kill.bind(process);
if(process.env.FIXTURE_REQUIRE_SUDO==='1')process.kill=(pid,signal)=>{if(pid<0&&signal!==0)throw Object.assign(Error('controlled root-owned group'),{code:'EPERM'});return realKill(pid,signal)};
cp.spawnSync=(command,args,options={})=>{
 if(command==='sudo'){appendFileSync(${JSON.stringify(join(root, "commands.jsonl"))},JSON.stringify({command,args,cwd:options.cwd})+'\\n');try{realKill(Number(args.at(-1)),args[3]);return {status:0,stdout:'',stderr:''}}catch(error){if(error.code!=='ESRCH')throw error;return {status:1,stdout:'',stderr:'No such process'}}}
 if(${publicQuality}&&command===process.execPath&&args[0]?.endsWith('/prepare-official-sdk.mjs')&&args.includes('--with-web')){appendFileSync(${JSON.stringify(join(root, "commands.jsonl"))},JSON.stringify({command:'sdk-consumer',args})+'\\n');return {status:0,stdout:'',stderr:''};}
 if(command==='/opt/google/chrome/chrome')return {status:0,stdout:(process.env.CHROME_VERSION??'Chrome fixture 1')+'\\n',stderr:''};
 if(['npm','corepack'].includes(command)){
  if(args.includes('install-deps')&&process.env.BROWSER_SCENARIO)return real(process.execPath,[${JSON.stringify(join(root, "install-process.mjs"))},command,JSON.stringify(args)],{...options,env:{...options.env,FIXTURE_PROCESS_ROOT:${JSON.stringify(root)}}});
  if(process.env.PROCESS_INSTALLS==='1'&&!process.env.FIXTURE_INSTALL_CHILD&&(args.includes('ci')||args.includes('install')))return real(process.execPath,[${JSON.stringify(join(root, "install-process.mjs"))},command,JSON.stringify(args)],{...options,env:{...options.env,FIXTURE_PROCESS_ROOT:${JSON.stringify(root)}}});
  appendFileSync(${JSON.stringify(join(root, "commands.jsonl"))},JSON.stringify({command,args,cwd:options.cwd})+'\\n');
  if(args.includes('config')&&args.includes('get'))return {status:0,stdout:(args.includes('globalconfig')?JSON.stringify(${JSON.stringify(join(root, "fixture-global-config.yaml"))}):'undefined')+'\\n',stderr:''};
  if(args.includes('root'))return {status:0,stdout:join(options.cwd,'node_modules')+'\\n',stderr:''};
  if(args.includes('--version')){
   let at=options.cwd,definition;
   while(!definition){try{definition=JSON.parse(readFileSync(join(at,'package.json'))).packageManager}catch{}if(!definition){const parent=dirname(at);if(parent===at)throw Error('manager not found');at=parent}}
   if(process.env.MUTATE_AFTER_MANAGERS==='1'&&options.cwd===${JSON.stringify(gea)})mkdirSync(${JSON.stringify(join(root, "official-latest-standard/node_modules"))},{recursive:true});
   if(process.env.MUTATE_INSTALL_CONFIG==='1'&&options.cwd===${JSON.stringify(gea)})writeFileSync(${JSON.stringify(join(root, "candidate/dsh-agent-workbench/.npmrc"))},'prefix=/unexpected-install-target');
   if(process.env.WRONG_MANAGER==='1'&&options.cwd===${JSON.stringify(manage)})return {status:0,stdout:'99.0.0\\n',stderr:''};
   return {status:0,stdout:definition.split('@')[1]+'\\n',stderr:''};
  }
  if(args.includes('install-deps'))return {status:process.env.FAIL_SYSTEM_LIBS==='1'?1:0,stdout:'',stderr:'system libraries unavailable'};
  if(args.includes('ci')||args.includes('install')){
   if(process.env.FAIL_INSTALL==='1')return {status:1,stdout:'',stderr:'controlled install failure'};
   mkdirSync(join(options.cwd,'node_modules'),{recursive:true});writeFileSync(join(options.cwd,'node_modules/fixture'),'independent');writeFileSync(join(options.cwd,'node_modules/.modules.yaml'),'fixture install metadata');
   if(${browser}&&process.env.EARLY_BROWSER_CLOSURE==='1'&&[${JSON.stringify(gea)},${JSON.stringify(manage)}].includes(options.cwd)){
    const packageRoots=Object.fromEntries(['@playwright/test','playwright','playwright-core'].map(name=>[name,join(options.cwd,'node_modules/.pnpm',name.replace('/','+')+'@1.58.2','node_modules',name)]));
    for(const name of ['@playwright/test','playwright','playwright-core']){const target=packageRoots[name];mkdirSync(target,{recursive:true});const metadata={name,type:'commonjs',version:'1.58.2',bin:{[name==='playwright-core'?'playwright-core':'playwright']:'cli.js'},dependencies:name==='@playwright/test'?{playwright:'1.58.2'}:name==='playwright'?{'playwright-core':'1.58.2'}:{},...(name==='playwright'?{optionalDependencies:{fsevents:'2.3.2'}}:{}),...(name==='@playwright/test'?{exports:{'.':{require:'./index.cjs',import:'./index.mjs'},'./package.json':'./package.json'}}:{})};writeFileSync(join(target,'package.json'),JSON.stringify(metadata));writeFileSync(join(target,'shipped.txt'),process.env.MUTATE_LATE_BROWSER==='1'&&options.cwd===${JSON.stringify(gea)}?'late changed bytes':'same shipped bytes');writeFileSync(join(target,'cli.js'),"const fs=require('node:fs'),p=require('node:path');if(process.env.BROWSER_SCENARIO)require(process.env.GITHUB_WORKSPACE+'/browser-process.cjs');fs.writeFileSync(p.join(process.env.GITHUB_WORKSPACE,'early-apt-executed'),'actual Node CLI');if(process.env.MUTATE_EARLY_BROWSER==='1')fs.writeFileSync(p.join(__dirname,'shipped.txt'),'during CLI');if(process.env.MUTATE_EARLY_WIRING==='1')fs.writeFileSync(p.join(__dirname,'node_modules/.bin/playwright'),'mutated generated shim');if(process.env.FAIL_EARLY_APT==='1')process.exit(19);");if(name==='@playwright/test'){writeFileSync(join(target,'index.cjs'),"module.exports = require('./api.cjs');");writeFileSync(join(target,'index.mjs'),"import api from './index.cjs';export const chromium=api.chromium;");writeFileSync(join(target,'api.cjs'),readFileSync(${JSON.stringify(join(root, "fake-playwright.cjs"))}))}}
    fs.mkdirSync(join(options.cwd,'node_modules/@playwright'),{recursive:true});
    for(const [link,target] of [[join(options.cwd,'node_modules/@playwright/test'),packageRoots['@playwright/test']],[join(dirname(dirname(packageRoots['@playwright/test'])),'playwright'),packageRoots.playwright],[join(dirname(packageRoots.playwright),'playwright-core'),packageRoots['playwright-core']]])fs.symlinkSync(relative(dirname(link),target),link);
    for(const name of ['@playwright/test','playwright','playwright-core']){const target=packageRoots[name];fs.mkdirSync(join(target,'lib/node_modules/vendor'),{recursive:true});fs.writeFileSync(join(target,'lib/node_modules/vendor/resource.js'),'shipped vendor bytes');if(name!=='playwright-core'){fs.mkdirSync(join(target,'node_modules/.bin'),{recursive:true});const bin=join(target,'node_modules/.bin',name==='@playwright/test'?'playwright':'playwright-core');fs.writeFileSync(bin,'# generated manager shim for '+options.cwd);fs.chmodSync(bin,0o755)}}
   }else if(${browser}&&options.cwd===${JSON.stringify(gea)}){const target=join(options.cwd,'node_modules/@playwright/test');mkdirSync(target,{recursive:true});writeFileSync(join(target,'package.json'),JSON.stringify({type:'commonjs',version:'1.58.2',exports:{require:'./index.cjs',import:'./index.mjs'}}));writeFileSync(join(target,'index.cjs'),"module.exports = require('./api.cjs');");writeFileSync(join(target,'index.mjs'),"import api from './index.cjs';export const chromium=api.chromium;");writeFileSync(join(target,'api.cjs'),readFileSync(${JSON.stringify(join(root, "fake-playwright.cjs"))}))}
   if(process.env.MUTATE_SOURCE==='1')writeFileSync(${JSON.stringify(join(gea, "README.md"))},'source changed during install');
   return {status:0,stdout:'',stderr:''};
  }
  throw Error('unexpected compiler/download command '+args.join(' '));
 }
 return real(command,args,options);
};syncBuiltinESMExports();if(${browser}){const {installChromeCommands}=await import(${JSON.stringify(join(own, "scripts/fixtures/quality-system-chrome-commands.mjs"))});installChromeCommands({root:${JSON.stringify(root)}})}`,
  );
  const env = {
    ...process.env,
    NODE_OPTIONS: "--import=" + boundary,
    GITHUB_WORKSPACE: root,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    ImageOS: "fixture-os",
    ImageVersion: "fixture-image",
    QUALITY_EXPECTED_SHA: geaHead,
    QUALITY_BASE_SHA: geaHead,
  };
  delete env.CI;
  delete env.NODE_TEST_CONTEXT;
  put(
    "produce.mjs",
    `import {createWorkerBinding} from ${JSON.stringify(join(gea, "scripts/quality-worker-inputs.mjs"))};import {readPreparedWorkbench} from ${JSON.stringify(join(gea, "scripts/quality-workbench.mjs"))};import {readFileSync,writeFileSync} from 'node:fs';const read=f=>JSON.parse(readFileSync(f));if(${runtime})writeFileSync(${JSON.stringify(join(root, "prepared-workbench.json"))},JSON.stringify(await readPreparedWorkbench({source:${JSON.stringify(wb)},prepared:${JSON.stringify(join(root, "candidate/dsh-agent-workbench"))},head:${JSON.stringify(wbHead)},manage:{path:${JSON.stringify(manage)},head:${JSON.stringify(manageHead)}}})));writeFileSync(${JSON.stringify(join(root, "binding.json"))},JSON.stringify(createWorkerBinding({root:${JSON.stringify(root)},executionPlan:read(${JSON.stringify(join(root, "quality-test-execution-plan.json"))}),stages:read(${JSON.stringify(join(root, "quality-stages.json"))})})));`,
  );
  const run = (file, args = [], extra = {}) =>
    spawnSync(process.execPath, [file, ...args], {
      cwd: gea,
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  const quality = (stage, extraArgs = []) =>
    run("scripts/run-quality-ci.mjs", [
      "--stage",
      stage,
      "--input",
      join(root, "candidate-input.json"),
      "--final-group-sha256",
      binding.inputSha256,
      "--final-group-workbench",
      wb,
      "--core-source",
      coreSource,
      "--test-file-concurrency",
      String(concurrency),
      "--test-shards",
      withShards ? "2" : "1",
      ...extraArgs,
    ]);
  if (publicQuality) {
    const selected = quality("plan");
    assert.equal(selected.status, 0, selected.stdout + selected.stderr);
    executionPlan = JSON.parse(selected.stdout);
    json("quality-test-execution-plan.json", executionPlan);
    // Selection output is bound by its own SHA; obtain the original CLI's actual selection using the same reader.
    const selection = run("--input-type=module", [
      "-e",
      `import {selectCiTests} from ${JSON.stringify(join(wb, "scripts/ci-test-plan.mjs"))};import {selectPlatformTests} from ${JSON.stringify(join(gea, "scripts/ci-platform-tests.mjs"))};console.log(JSON.stringify(selectPlatformTests(selectCiTests({repositories:${JSON.stringify(candidate.repositories)},repo:'dsh-gea-plugin',base:${JSON.stringify(geaHead)}}))));`,
    ]);
    assert.equal(selection.status, 0, selection.stderr);
    plan = JSON.parse(selection.stdout);
    json("quality-test-plan.json", plan);
    stages.schemaVersion = 1;
    stages.binding = {
      input: join(root, "candidate-input.json"),
      inputSha256: binding.inputSha256,
      phase: "quality",
      manifest: candidate,
      plan,
      executionPlan,
      coreSource,
    };
    stages.artifacts[join(gea, "lib")] = {
      "client.js": hash("fixed lib client"),
      ...stages.artifacts[join(gea, "lib")],
    };
    json("quality-stages.json", stages);
  }
  const produce = () => {
    if (browser && !existsSync(join(root, "system-chrome-preparation.json"))) {
      const r = run("scripts/quality-system-chrome.mjs", ["prepare", "--root", root]);
      if (r.status !== 0) return r;
    }
    return run(join(root, "produce.mjs"));
  };
  const exportBundle = () =>
    run("scripts/quality-prepared-inputs.mjs", [
      "export",
      "--root",
      root,
      "--binding",
      join(root, "binding.json"),
      "--manifest",
      join(root, "transport.json"),
      "--bundle",
      join(root, "transport.tar"),
    ]);
  const clear = () => {
    for (const name of [
      "official-latest-standard",
      "quality-upstreams",
      "prepared-workbench-assets",
      ".quality-browser",
      ".quality-system-chrome",
      "system-chrome-preparation.json",
    ])
      rmSync(join(root, name), { recursive: true, force: true });
    git(wb, "worktree", "remove", "--force", join(root, "candidate/dsh-agent-workbench"));
    for (const name of ["dsh-agent-manage", "dsh-gea-plugin"])
      rmSync(join(root, "candidate", name, "lib"), { recursive: true });
    rmSync(join(manage, "client"), { recursive: true, force: true });
    rmSync(join(gea, "node_modules"), { recursive: true, force: true });
    for (const name of [
      "candidate-input.json",
      "candidate-group.json",
      "quality-stages.json",
      "quality-test-plan.json",
      "quality-test-execution-plan.json",
    ])
      rmSync(join(root, name));
    rmSync(join(root, "commands.jsonl"), { force: true });
  };
  const receive = (extra = {}) =>
    run(
      "scripts/quality-worker-inputs.mjs",
      [
        "--root",
        root,
        "--binding",
        join(root, "binding.json"),
        "--manifest",
        join(root, "transport.json"),
        "--bundle",
        join(root, "transport.tar"),
        "--manifest-sha256",
        hash(readFileSync(join(root, "transport.json"))),
      ],
      extra,
    );
  const receiveAsync = (extra = {}, earlyArgs, extraArgs = []) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/quality-worker-inputs.mjs",
        ...(earlyArgs ?? [
          "--root",
          root,
          "--binding",
          join(root, "binding.json"),
          "--manifest",
          join(root, "transport.json"),
          "--bundle",
          join(root, "transport.tar"),
          "--manifest-sha256",
          hash(readFileSync(join(root, "transport.json"))),
        ]),
        ...extraArgs,
      ],
      { cwd: gea, env: { ...env, ...extra }, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    return { child, closed };
  };
  return {
    root,
    gea,
    manage,
    wb,
    coreSource,
    put,
    json,
    git,
    commit,
    produce,
    exportBundle,
    clear,
    receive,
    receiveAsync,
    earlyReceiveAsync: (apiBase, extra = {}, extraArgs = []) =>
      receiveAsync(
        {
          GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin",
          GITHUB_API_URL: apiBase,
          PATH: join(root, "bin") + ":" + process.env.PATH,
          ...extra,
        },
        [
          "--root",
          root,
          "--early-control",
          join(root, "early.json"),
          "--early-sha256",
          hash(readFileSync(join(root, "early.json"))),
        ],
        extraArgs,
      ),
    run,
    quality,
    bindingEnvironment: Object.fromEntries(
      ["GITHUB_WORKSPACE", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "ImageOS", "ImageVersion"].map(
        (key) => [key, env[key]],
      ),
    ),
    read: (f) => JSON.parse(readFileSync(join(root, f))),
    commands: () =>
      readFileSync(join(root, "commands.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
  };
}

test("the early control freezes original public source-plan bytes without claiming built or installed inputs", (t) => {
  const f = fixture(t, { publicQuality: true, withShards: true, runtime: true, browser: true });
  const plan = f.quality("plan", ["--root", f.root]);
  assert.equal(plan.status, 0, plan.stderr);
  const result = f.run(
    "scripts/quality-worker-control.mjs",
    ["--mode", "freeze", "--root", f.root, "--output", join(f.root, "early.json")],
    { GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin" },
  );
  assert.equal(result.status, 0, result.stderr);
  const control = f.read("early.json");
  assert.equal(control.scope, "source-plan-only");
  assert.deepEqual(control.plan, JSON.parse(plan.stdout));
  assert.equal(control.candidateBytes, readFileSync(join(f.root, "candidate-input.json"), "utf8"));
  assert.equal(control.metadata.sources.length, 4);
  assert.equal(control.runtime, true);
  assert.equal(control.buildSha256, undefined);
  assert.equal(control.installedDependencies, undefined);
});

async function earlyWorkerFixture(
  t,
  { producerState = "completed", earlyManagePlaywright, concurrency = 2 } = {},
) {
  const f = fixture(t, {
    publicQuality: true,
    withShards: true,
    runtime: true,
    browser: true,
    earlyManagePlaywright,
    concurrency,
  });
  assert.equal(f.quality("plan", ["--root", f.root]).status, 0);
  const frozen = f.run(
    "scripts/quality-worker-control.mjs",
    ["--mode", "freeze", "--root", f.root, "--output", join(f.root, "early.json")],
    { GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin" },
  );
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.equal(f.produce().status, 0);
  const exported = f.exportBundle();
  assert.equal(exported.status, 0, exported.stderr);
  f.put("quality-worker-binding.json", readFileSync(join(f.root, "binding.json")));
  f.put("transport-export.json", exported.stdout);
  const indexed = f.run("scripts/quality-shards.mjs", [
    "--mode",
    "index",
    "--root",
    f.root,
    "--transport",
    join(f.root, "transport-export.json"),
    "--bundle",
    join(f.root, "transport.tar"),
    "--artifact-id",
    "42",
    "--output",
    join(f.root, "producer-index.json"),
  ]);
  assert.equal(indexed.status, 0, indexed.stderr);
  const control = f.read("early.json"),
    core = control.plan.binding.manifest.core;
  const expectedHead = control.plan.binding.manifest.repositories.find(
    (x) => x.repo === "dsh-gea-plugin",
  ).head;
  const server = createServer((request, response) => {
    f.put("api-polled", "actual worker HTTP read");
    const body = request.url.endsWith("/attempts/1")
      ? { id: 123, run_attempt: 1, head_sha: expectedHead, status: "in_progress" }
      : request.url.includes("/jobs?")
        ? {
            total_count: 1,
            jobs: [
              {
                id: 7,
                run_id: 123,
                head_sha: expectedHead,
                name: "prepare-" + core,
                status: producerState,
                conclusion: producerState === "completed" ? "success" : null,
              },
            ],
          }
        : {
            total_count: 2,
            artifacts: ["index", "bundle"].map((kind, i) => ({
              id: i + 41,
              name: `quality-a1-${kind}-${core}`,
              expired: false,
              workflow_run: { id: 123, head_sha: expectedHead },
            })),
          };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  f.put(
    "bin/gh",
    `#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
const root=${JSON.stringify(f.root)},args=process.argv.slice(2),name=args[args.indexOf('--name')+1],out=args[args.indexOf('--dir')+1];
for(const path of ['official-latest-standard','quality-upstreams/upstream-reference/dsh-better-sidebar','candidate/dsh-agent-workbench','candidate/dsh-agent-workbench/business/inventory-apsplan/source','candidate/dsh-agent-manage'])if(!existsSync(join(root,path,'node_modules/fixture')))throw Error('five locks not prepared before receive');
if(existsSync(join(root,'candidate/dsh-gea-plugin/node_modules')))throw Error('GEA installed before GenUI transport');
mkdirSync(out,{recursive:true});if(name.includes('-index-'))copyFileSync(join(root,'producer-index.json'),join(out,'quality-index.json'));else{copyFileSync(join(root,'transport.json'),join(out,'manifest.json'));copyFileSync(join(root,'transport.tar'),join(out,'prepared.tar'))}
writeFileSync(join(root,'download-'+(name.includes('-index-')?'index':'bundle')),'actual fixture gh command');
`,
  );
  chmodSync(join(f.root, "bin/gh"), 0o755);
  f.clear();
  return { f, apiBase: "http://127.0.0.1:" + server.address().port };
}

test("early worker browser installation times out before producer wait and leaves no owned descendants", async (t) => {
  const { f, apiBase } = await earlyWorkerFixture(t);
  const run = f.earlyReceiveAsync(
    apiBase,
    { EARLY_BROWSER_CLOSURE: "1", BROWSER_SCENARIO: "hang", FIXTURE_REQUIRE_SUDO: "1" },
    ["--browser-preparation-timeout-ms", "500"],
  );
  try {
    await fileReady(join(f.root, "browser-grandchild-ready"), 15000);
    const observation = f.run(join(own, "scripts/run-quality-ci.mjs"), [
      "--stage",
      "observe",
      "--root",
      f.root,
    ]);
    assert.equal(observation.status, 0, observation.stderr);
    assert.equal(JSON.parse(observation.stdout).lastConfirmedStage, "prepare");
    assert.equal(
      JSON.parse(observation.stdout).lastConfirmedStep,
      "early-browser-system-libraries",
    );
    const result = await deadline(run.closed);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /browser.*timed out.*500/);
    const receipt = f.read("quality-worker-inputs.json");
    assert.equal(receipt.status, "failed");
    const step = receipt.steps.find((x) => x.name === "early-browser-system-libraries");
    assert.equal(step.status, "failed");
    assert.equal(step.budgetMs, 500);
    assert.equal(receipt.tests, "not-run");
    assert.equal(
      receipt.steps.some((x) => x.name === "producer-wait"),
      false,
    );
    assert.equal(existsSync(join(f.root, "api-polled")), false);
    assert.ok(
      f.commands().some((entry) => entry.command === "sudo" && entry.args.includes("SIGKILL")),
    );
    assert.equal(existsSync(join(f.root, "tests-executed")), false);
    for (const name of ["browser-leader-ready", "browser-grandchild-ready"])
      assert.throws(() => process.kill(Number(readFileSync(join(f.root, name), "utf8")), 0), {
        code: "ESRCH",
      });
  } finally {
    cleanupInstallFixture(f, run.child);
    await run.closed;
  }
});

test("one live three-file worker prepares five independent locks before receiving this run then reaches the original tests CLI", async (t) => {
  const { f, apiBase } = await earlyWorkerFixture(t, { concurrency: 3 });
  assert.equal(f.read("early.json").plan.concurrency, 3);
  assert.equal(f.read("producer-index.json").plan.concurrency, 3);
  assert.equal(
    f.read("producer-index.json").stages.stages.checks.status,
    "passed",
    "an executable producer has passed source checks",
  );
  const started = f.earlyReceiveAsync(apiBase, { EARLY_BROWSER_CLOSURE: "1" });
  const received = await started.closed;
  assert.equal(received.code, 0, received.stdout + received.stderr);
  const record = f.read("quality-worker-inputs.json");
  assert.equal(record.status, "worker-inputs-ready");
  assert.equal(record.quality, "not-observed");
  assert.equal(record.tests, "not-run");
  assert.equal(record.steps.filter((x) => x.name.startsWith("install:")).length, 6);
  assert.ok(
    record.steps.findIndex((x) => x.name === "early-browser-system-libraries") <
      record.steps.findIndex((x) => x.name === "producer-wait"),
  );
  assert.equal(
    record.steps.find((x) => x.name === "early-browser-system-libraries").result.status,
    "executed",
  );
  assert.equal(readFileSync(join(f.root, "early-apt-executed"), "utf8"), "actual Node CLI");
  const checked = f.read("quality-stages.json");
  f.json("quality-stages.json", {
    ...checked,
    stages: { ...checked.stages, checks: { ...checked.stages.checks, status: "failed" } },
  });
  const blocked = f.quality("tests");
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stderr, /QUALITY_STAGE_DEPENDENCY: checks/);
  assert.equal(existsSync(join(f.root, "tests-executed")), false);
  assert.equal(f.read("quality-stages.json").stages.checks.status, "failed");
  f.json("quality-stages.json", checked);
  const quality = f.quality("tests");
  assert.equal(quality.status, 0, quality.stdout + quality.stderr);
  assert.equal(readFileSync(join(f.root, "tests-executed"), "utf8"), "actual Node test");
  const execution = f.read("quality-test-execution.json");
  assert.equal(execution.capacity.concurrency, 3);
  assert.equal(execution.capacity.status, "passed");
  assert.equal(execution.status, "passed");
  assert.equal(
    f.read("quality-stages.json").stages.checks.status,
    "passed",
    "running tests must retain the passed source checks",
  );
  const cleaned = f.run("scripts/quality-system-chrome.mjs", ["cleanup", "--root", f.root]);
  assert.equal(cleaned.status, 0, cleaned.stderr);
});

test("early wait cancellation fails within the same invocation without transport or an accepted resume token", async (t) => {
  const { f, apiBase } = await earlyWorkerFixture(t, { producerState: "in_progress" });
  const run = f.earlyReceiveAsync(apiBase, { EARLY_BROWSER_CLOSURE: "1" });
  try {
    await deadline(fileReady(join(f.root, "api-polled")));
    run.child.kill("SIGTERM");
    const result = await deadline(run.closed);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /cancelled by SIGTERM/);
    const receipt = f.read("quality-worker-inputs.json");
    assert.equal(receipt.status, "failed");
    assert.equal(
      receipt.steps.some((x) => x.name === "transport"),
      false,
    );
    assert.equal(receipt.tests, "not-run");
  } finally {
    cleanupInstallFixture(f, run.child);
    await run.closed;
  }
});

test("cancelling an actual early artifact download drains its owned descendant before failure", async (t) => {
  const { f, apiBase } = await earlyWorkerFixture(t);
  f.put(
    "bin/gh",
    `#!/usr/bin/env node
import {spawn} from 'node:child_process';import {watch} from 'node:fs';
process.on('SIGTERM',()=>{});
spawn(process.execPath,['-e',${JSON.stringify("const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.GITHUB_WORKSPACE+'/download-descendant',String(process.pid));fs.watch(process.env.GITHUB_WORKSPACE,()=>{if(fs.existsSync(process.env.GITHUB_WORKSPACE+'/release-download'))fs.writeFileSync(process.env.GITHUB_WORKSPACE+'/late-download','escaped');});")}],{stdio:'inherit'});
watch(process.env.GITHUB_WORKSPACE,()=>{});await new Promise(()=>{});
`,
  );
  chmodSync(join(f.root, "bin/gh"), 0o755);
  const run = f.earlyReceiveAsync(apiBase, { EARLY_BROWSER_CLOSURE: "1" });
  try {
    await fileReady(join(f.root, "download-descendant"), 15000);
    run.child.kill("SIGINT");
    const result = await deadline(run.closed);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /cancelled by SIGINT/);
    const pid = Number(readFileSync(join(f.root, "download-descendant"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    f.put("release-download", "release");
    assert.equal(existsSync(join(f.root, "late-download")), false);
    assert.equal(f.read("quality-worker-inputs.json").status, "failed");
  } finally {
    cleanupInstallFixture(f, run.child);
    await run.closed;
  }
});

test("the public source planner and final catalog reconcile original producer indexes and reject altered allocation or missing Core", async (t) => {
  const { f } = await earlyWorkerFixture(t, { concurrency: 3 });
  const control = f.read("early.json"),
    candidate = control.plan.binding.manifest;
  const expected = {
    repository: control.repository,
    cores: [candidate.core],
    runId: control.plan.binding.runId,
    runAttempt: control.plan.binding.runAttempt,
    node: control.plan.binding.node,
    groupId: JSON.parse(control.groupBytes).groupId,
    sources: candidate.repositories.map(({ repo, head }) => ({ repo, head })),
  };
  f.put("controls/one/control.json", readFileSync(join(f.root, "early.json")));
  const failedChecks = f.read("producer-index.json");
  failedChecks.stages.stages.checks.status = "failed";
  f.json("indexes/one/quality-index.json", failedChecks);
  f.put("expected.json", JSON.stringify(expected));
  const planArgs = [
    "--mode",
    "plan",
    "--controls",
    join(f.root, "controls"),
    "--expected",
    join(f.root, "expected.json"),
  ];
  const planned = f.run("scripts/quality-worker-control.mjs", [
    ...planArgs,
    "--output",
    join(f.root, "allocation.json"),
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const allocation = f.read("allocation.json");
  assert.equal(allocation.matrix.include.length, control.plan.shards.length);
  assert.ok(
    allocation.matrix.include.every(
      (x) => x.controlSha256 === hash(readFileSync(join(f.root, "early.json"))),
    ),
  );
  const catalogArgs = [
    "--mode",
    "catalog",
    "--controls",
    join(f.root, "controls"),
    "--indexes",
    join(f.root, "indexes"),
    "--allocation",
    join(f.root, "allocation.json"),
  ];
  const catalog = f.run("scripts/quality-worker-control.mjs", [
    ...catalogArgs,
    "--output",
    join(f.root, "catalog.json"),
  ]);
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.ok(f.read("catalog.json").requiredJobs.includes("source-plan-" + candidate.core));
  assert.equal(f.read("catalog.json").indexes[0].plan.concurrency, 3);
  assert.equal(
    f.read("catalog.json").producerChecks,
    "failed",
    "catalog cannot promote failed checks after transport success",
  );
  allocation.matrix.include[0].shard = "forged";
  f.put("allocation.json", JSON.stringify(allocation));
  const changed = f.run("scripts/quality-worker-control.mjs", [
    ...catalogArgs,
    "--output",
    join(f.root, "changed-catalog.json"),
  ]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /early allocation changed/);
  f.put("expected.json", JSON.stringify({ ...expected, cores: ["a".repeat(40)] }));
  const missing = f.run("scripts/quality-worker-control.mjs", [
    ...planArgs,
    "--output",
    join(f.root, "missing.json"),
  ]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Core control missing/);
});

test("only known declared incompatibility defers early APT to the original late command", async (t) => {
  const { f, apiBase } = await earlyWorkerFixture(t, { earlyManagePlaywright: "1.58.3" });
  const result = await f.earlyReceiveAsync(apiBase, { EARLY_BROWSER_CLOSURE: "1" }).closed;
  assert.equal(result.code, 0, result.stderr);
  const record = f.read("quality-worker-inputs.json");
  assert.equal(
    record.steps.find((x) => x.name === "early-browser-system-libraries").result.status,
    "deferred",
  );
  assert.equal(existsSync(join(f.root, "early-apt-executed")), false);
  assert.ok(f.commands().some((x) => x.args.includes("install-deps")));
  assert.equal(record.steps.find((x) => x.name === "browser-availability").status, "passed");
  assert.equal(f.run("scripts/quality-system-chrome.mjs", ["cleanup", "--root", f.root]).status, 0);
});

test("early APT failures and before/after package drift cannot fall back to a late successful command", async (t) => {
  for (const [variable, expected] of [
    ["FAIL_EARLY_APT", /19/],
    ["MUTATE_EARLY_BROWSER", /changed its shipped packages/],
    ["MUTATE_EARLY_WIRING", /changed its shipped packages/],
    ["MUTATE_LATE_BROWSER", /differs from executed early CLI/],
    ["EARLY_GROUP_DRIFT", /received plan\/group bytes differ/],
  ]) {
    await t.test(variable, async (t) => {
      const { f, apiBase } = await earlyWorkerFixture(t);
      if (variable === "EARLY_GROUP_DRIFT") {
        const control = f.read("early.json");
        control.groupBytes = JSON.stringify({ ...JSON.parse(control.groupBytes), foreign: true });
        f.json("early.json", control);
      }
      const result = await f.earlyReceiveAsync(apiBase, {
        EARLY_BROWSER_CLOSURE: "1",
        [variable]: "1",
      }).closed;
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stderr, expected);
      const record = f.read("quality-worker-inputs.json");
      assert.equal(record.status, "failed");
      assert.equal(record.tests, "not-run");
      assert.equal(
        record.steps.some((x) => x.name === "browser-availability"),
        false,
      );
      assert.equal(
        record.steps.some((x) => x.name === "browser-system-libraries"),
        false,
      );
    });
  }
});

test("the producer binding fixes actual sources, SDK builder and original execution inputs while retaining failed checks", (t) => {
  const f = fixture(t);
  const stages = f.read("quality-stages.json");
  stages.stages.checks.status = "failed";
  f.json("quality-stages.json", stages);
  const result = f.produce();
  assert.equal(result.status, 0, result.stderr);
  const original = readFileSync(join(f.root, "binding.json"));
  const second = f.produce();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(
    readFileSync(join(f.root, "binding.json")),
    original,
    "binding must remain byte-stable for producer export and later index creation",
  );
  const b = f.read("binding.json");
  const prior = Object.fromEntries(
    Object.keys(f.bindingEnvironment).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, f.bindingEnvironment);
    assert.deepEqual(
      createWorkerBinding({
        root: f.root,
        executionPlan: f.read("quality-test-execution-plan.json"),
        stages: f.read("quality-stages.json"),
      }),
      b,
    );
  } finally {
    for (const [key, value] of Object.entries(prior))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  assert.equal(b.planSha256, f.read("quality-test-execution-plan.json").planSha256);
  assert.equal(
    b.worker.sdkIdentity.builder,
    hash(readFileSync(join(f.manage, "scripts/prepare-official-sdk.mjs"))),
  );
  assert.equal(b.worker.environment.imageVersion, "fixture-image");
  assert.equal(f.read("quality-stages.json").stages.checks.status, "failed");
  assert.ok(b.worker.sources.some((x) => x.packageManager === "pnpm@11.17.0"));
});

test("the five-parameter worker CLI restores original bytes and installs every lock in an independent source-only worker without compiling", (t) => {
  const f = fixture(t);
  assert.equal(f.produce().status, 0);
  const exported = f.exportBundle();
  assert.equal(exported.status, 0, exported.stderr);
  const input = readFileSync(join(f.root, "candidate-input.json"));
  f.clear();
  const result = f.receive();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const receipt = f.read("quality-worker-inputs.json");
  assert.equal(receipt.status, "worker-inputs-ready");
  assert.equal(receipt.quality, "not-observed");
  assert.equal(receipt.tests, "not-run");
  assert.ok(receipt.resources.availableParallelism >= 1);
  assert.ok(receipt.resources.totalMemoryBytes > 0);
  assert.ok(receipt.bundleBytes > 0);
  assert.deepEqual(readFileSync(join(f.root, "candidate-input.json")), input);
  assert.ok(
    readFileSync(join(f.root, "candidate/dsh-agent-workbench/.git"), "utf8").includes(f.root),
  );
  const installs = f.commands().filter((x) => x.args.includes("ci") || x.args.includes("install"));
  assert.equal(installs.length, 5);
  assert.equal(new Set(installs.map((x) => realpathSync(join(x.cwd, "node_modules")))).size, 5);
  assert.ok(installs.every((x) => x.args.includes("--ignore-scripts")));
  assert.ok(installs.some((x) => x.cwd === f.manage && x.command === "corepack"));
  assert.ok(
    installs.some(
      (x) => x.cwd === join(f.root, "candidate/dsh-agent-workbench") && x.command === "npm",
    ),
  );
  assert.ok(
    receipt.steps.every(
      (x) => x.status === "passed" && x.durationMs >= 0 && x.finishedAt >= x.startedAt,
    ),
  );
});

test("source drift while dependencies install never becomes worker ready", (t) => {
  const f = fixture(t);
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive({ MUTATE_SOURCE: "1" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(f.read("quality-worker-inputs.json").status, "failed");
});

test("old run, image, Node, source head, original lock and SDK builder changes reject before any install", (t) => {
  for (const scenario of ["run", "image", "node", "head", "lock", "builder"]) {
    const f = fixture(t);
    assert.equal(f.produce().status, 0);
    assert.equal(f.exportBundle().status, 0);
    f.clear();
    const env = {};
    if (scenario === "run") env.GITHUB_RUN_ATTEMPT = "2";
    if (scenario === "image") env.ImageOS = "other-os-image";
    if (scenario === "node") env.FIXTURE_NODE = "24.0.0";
    if (scenario === "head") {
      f.put("source/dsh-agent-workbench/README.md", "new source");
      f.commit(f.wb);
    }
    if (scenario === "lock") f.put("candidate/dsh-agent-manage/pnpm-lock.yaml", "changed lock");
    if (scenario === "builder")
      f.put(
        "candidate/dsh-agent-manage/scripts/prepare-official-sdk.mjs",
        'throw Error("substituted builder")',
      );
    const r = f.receive(env);
    assert.equal(r.status, 1, scenario);
    assert.equal(f.read("quality-worker-inputs.json").status, "failed");
    assert.ok(
      !existsSync(join(f.root, "commands.jsonl")),
      scenario + " installed before rejecting",
    );
  }
});

test("a producer SDK receipt cannot self-authorize its builder and a missing output cannot trigger compilation", (t) => {
  for (const scenario of ["identity", "missing"]) {
    const f = fixture(t);
    assert.equal(f.produce().status, 0);
    if (scenario === "identity") {
      const receipt = f.read("official-latest-standard/.git/dsh-sdk-artifacts.json");
      receipt.identity.builder = "f".repeat(64);
      f.json("official-latest-standard/.git/dsh-sdk-artifacts.json", receipt);
    }
    assert.equal(f.exportBundle().status, 0);
    f.clear();
    if (scenario === "missing")
      f.put("transport.tar", readFileSync(join(f.root, "transport.tar")).subarray(0, 100));
    const r = f.receive();
    assert.equal(r.status, 1, scenario);
    assert.equal(f.read("quality-worker-inputs.json").status, "failed");
    if (scenario === "identity") assert.match(r.stderr, /SDK_CACHE_IDENTITY_MISMATCH/);
    else assert.match(r.stderr, /bundle hash changed/);
    assert.ok(!f.commands().some((x) => x.args.includes("build") || x.args.includes("--prepare")));
  }
});

test("an install failure is recorded and cannot be reported as worker ready", (t) => {
  const f = fixture(t);
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive({ FAIL_INSTALL: "1" });
  assert.equal(r.status, 1);
  const record = f.read("quality-worker-inputs.json");
  assert.equal(record.status, "failed");
  assert.equal(record.steps.find((x) => x.name === "install:official-core").status, "failed");
  assert.ok(!record.steps.some((x) => x.name === "sdk-cache"));
});

test("runtime workers install the inherited npm inventory lock separately and assemble frozen Workbench assets", (t) => {
  const f = fixture(t, { runtime: true });
  const made = f.produce();
  assert.equal(made.status, 0, made.stderr);
  const exported = f.exportBundle();
  assert.equal(exported.status, 0, exported.stderr);
  f.clear();
  const r = f.receive();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const record = f.read("quality-worker-inputs.json");
  assert.equal(record.status, "worker-inputs-ready");
  assert.equal(
    f.commands().filter((x) => x.args.includes("ci") || x.args.includes("install")).length,
    6,
  );
  assert.ok(existsSync(join(f.root, "prepared-workbench-assets/lib/host.js")));
  assert.ok(!existsSync(join(f.root, "prepared-workbench-assets/.git")));
  assert.equal(
    readFileSync(
      join(
        f.root,
        "prepared-workbench-assets/lib/business/inventory-aqkc/skills/inventory-policy/SKILL.md",
      ),
      "utf8",
    ),
    "Only admitted inventory rows may be read.\n",
  );
  assert.ok(record.steps.some((x) => x.name === "workbench-assets" && x.status === "passed"));
});

for (const signal of [null, "SIGTERM", "SIGINT"]) {
  test(
    "worker browser installation " +
      (signal ?? "timeout") +
      " reaps its owned descendants before readiness",
    async (t) => {
      const f = fixture(t, { browser: true });
      assert.equal(f.produce().status, 0);
      assert.equal(f.exportBundle().status, 0);
      f.clear();
      const browserLaunches = readFileSync(join(f.root, "browser-launches.jsonl"), "utf8");
      const run = f.receiveAsync(
        { BROWSER_SCENARIO: "hang", FIXTURE_REQUIRE_SUDO: "1" },
        undefined,
        ["--browser-preparation-timeout-ms", signal ? "5000" : "500"],
      );
      try {
        await fileReady(join(f.root, "browser-grandchild-ready"), 15000);
        const observation = f.run(join(own, "scripts/run-quality-ci.mjs"), [
          "--stage",
          "observe",
          "--root",
          f.root,
        ]);
        assert.equal(observation.status, 0, observation.stderr);
        assert.equal(JSON.parse(observation.stdout).lastConfirmedStage, "prepare");
        assert.equal(JSON.parse(observation.stdout).lastConfirmedStep, "browser-system-libraries");
        if (signal) run.child.kill(signal);
        const r = await deadline(run.closed);
        assert.equal(r.code, 1, r.stderr);
        assert.match(
          r.stderr,
          signal ? new RegExp("cancelled by " + signal) : /browser.*timed out.*500/,
        );
        assert.match(r.stdout, /browser install output/);
        assert.match(r.stderr, /browser install diagnostic/);
        const receipt = f.read("quality-worker-inputs.json");
        assert.equal(receipt.status, "failed");
        assert.equal(receipt.tests, "not-run");
        const cleanup = f.commands().filter((entry) => entry.command === "sudo");
        assert.ok(cleanup.some((entry) => entry.args.includes("SIGKILL")));
        for (const command of cleanup)
          assert.equal(
            command.args.at(-1),
            "-" + readFileSync(join(f.root, "browser-leader-ready"), "utf8"),
          );
        assert.equal(
          receipt.steps.find((x) => x.name === "browser-system-libraries").status,
          "failed",
        );
        assert.equal(readFileSync(join(f.root, "browser-launches.jsonl"), "utf8"), browserLaunches);
        for (const name of ["browser-leader-ready", "browser-grandchild-ready"]) {
          const pid = Number(readFileSync(join(f.root, name), "utf8"));
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        }
      } finally {
        cleanupInstallFixture(f, run.child);
        await run.closed;
      }
    },
  );
}

test("each browser worker prepares system libraries and probes both system Chrome and received Chromium before readiness", (t) => {
  const f = fixture(t, { browser: true });
  const made = f.produce();
  assert.equal(made.status, 0, made.stderr);
  const exported = f.exportBundle();
  assert.equal(exported.status, 0, exported.stderr);
  f.clear();
  const r = f.receive();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    existsSync(join(f.root, "browser-launches.jsonl")),
    "worker did not probe its actual browser boundary",
  );
  const launches = readFileSync(join(f.root, "browser-launches.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(launches.length, 3);
  launches.shift();
  assert.equal(launches[0].channel, "chrome");
  assert.equal(launches[1].channel, undefined);
  assert.ok(f.commands().some((x) => x.args.includes("install-deps")));
  const record = f.read("quality-worker-inputs.json");
  assert.ok(
    record.steps.some((x) => x.name === "browser-system-libraries" && x.status === "passed"),
  );
  assert.equal(
    record.steps.find((x) => x.name === "browser-availability").result.chromeVersion,
    "Google Chrome 154.0.8037.97",
  );
});

test("missing VM browser libraries, unavailable browsers and system Chrome drift cannot become ready", (t) => {
  for (const extra of [
    { FAIL_SYSTEM_LIBS: "1" },
    { FAIL_BROWSER: "1" },
    { CHROME_VERSION: "Chrome other version" },
  ]) {
    const f = fixture(t, { browser: true });
    assert.equal(f.produce().status, 0);
    assert.equal(f.exportBundle().status, 0);
    f.clear();
    const r = f.receive(extra);
    assert.equal(r.status, 1, JSON.stringify(extra));
    const receipt = f.read("quality-worker-inputs.json");
    assert.equal(receipt.status, "failed");
    assert.ok(
      receipt.steps.some(
        (x) =>
          (x.name.startsWith("browser-") || x.name === "system-chrome-mount") &&
          x.status === "failed",
      ),
    );
    assert.ok(!f.commands().some((x) => x.args.includes("install") && x.args.includes("chromium")));
  }
});

test("the real selector maps the shared worker implementation to both public CLI contracts", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-policy-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const put = (cwd, file, body) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), body);
  };
  const commit = (cwd) => {
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git(cwd, "rev-parse", "HEAD");
  };
  const repositories = ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"].map((repo) => {
    const path = join(root, repo);
    mkdirSync(path);
    git(path, "init", "-q");
    put(path, "README.md", "fixture");
    return { repo, path, head: commit(path) };
  });
  const ownRepo = repositories[2];
  const policy = JSON.parse(readFileSync(join(own, "scripts/ci-test-policy.json")));
  policy.tests = policy.tests.filter((file) => !file.startsWith("desktop/"));
  delete policy.testOwners;
  policy.required = ["tests/required.test.mjs"];
  put(ownRepo.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(ownRepo.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  for (const file of [
    "tests/required.test.mjs",
    ...policy.versionTests,
    ...policy.browserFixtures,
    "scripts/quality-worker-inputs.test.mjs",
    "scripts/quality-prepared-inputs.test.mjs",
    "scripts/windows-complete-local/input.test.mjs",
    "scripts/windows-complete-local/core-cache.test.mjs",
    "tests/unrelated.test.mjs",
    "tests/unrelated.contract.mjs",
    "tests/unrelated.browser.mjs",
  ])
    put(ownRepo.path, file, "export const fixture=true;");
  ownRepo.head = commit(ownRepo.path);
  const base = ownRepo.head;
  put(ownRepo.path, "scripts/quality-worker-inputs.mjs", "export const worker=true;");
  ownRepo.head = commit(ownRepo.path);
  const { selectCiTests } = await import(
    pathToFileURL(join(workbenchSource, "scripts/ci-test-plan.mjs"))
  );
  const plan = selectCiTests({ repositories, repo: ownRepo.repo, base });
  assert.deepEqual(plan.reasons[ownRepo.repo + "/scripts/quality-worker-inputs.mjs"], [
    "scripts/quality-worker-inputs.test.mjs",
    "scripts/run-quality-ci-stages.test.mjs",
    "scripts/run-quality-ci.test.mjs",
  ]);
  assert.ok(plan.files.includes("scripts/quality-worker-inputs.test.mjs"));
  assert.ok(!plan.files.includes("tests/unrelated.test.mjs"));
  assert.ok(!plan.files.includes("tests/unrelated.browser.mjs"));
  put(ownRepo.path, "scripts/quality-runner-environment.mjs", "export const environment=true;");
  ownRepo.head = commit(ownRepo.path);
  const environmentPlan = selectCiTests({ repositories, repo: ownRepo.repo, base });
  assert.deepEqual(
    environmentPlan.reasons[ownRepo.repo + "/scripts/quality-runner-environment.mjs"],
    ["scripts/quality-prepared-inputs.test.mjs", "scripts/quality-worker-inputs.test.mjs"],
  );
  put(ownRepo.path, "scripts/unknown-worker.py", "# not mapped");
  ownRepo.head = commit(ownRepo.path);
  assert.throws(
    () => selectCiTests({ repositories, repo: ownRepo.repo, base }),
    /CI_TEST_IMPACT_UNMAPPED/,
  );
});

test("a transported execution plan cannot drift from the opaque producer binding even with a valid tar", (t) => {
  const f = fixture(t);
  assert.equal(f.produce().status, 0);
  const plan = f.read("quality-test-execution-plan.json");
  plan.planSha256 = "f".repeat(64);
  f.json("quality-test-execution-plan.json", plan);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(f.read("quality-worker-inputs.json").status, "failed");
  assert.ok(!f.commands().some((x) => x.args.includes("install") || x.args.includes("ci")));
});

test("the actual producer binding and index CLI preserve the exact bytes consumed by a source-only worker", (t) => {
  const f = fixture(t, { withShards: true, browser: true, runtime: true, publicQuality: true });
  const prepared = f.run("scripts/quality-shards.mjs", [
    "--mode",
    "prepare-browser",
    "--root",
    f.root,
  ]);
  assert.equal(prepared.status, 0, prepared.stderr);
  const made = f.produce();
  assert.equal(made.status, 0, made.stderr);
  const bound = f.run("scripts/quality-shards.mjs", [
    "--mode",
    "binding",
    "--root",
    f.root,
    "--output",
    join(f.root, "quality-worker-binding.json"),
  ]);
  assert.equal(bound.status, 0, bound.stderr);
  const original = readFileSync(join(f.root, "quality-worker-binding.json"));
  f.put("binding.json", original);
  const exported = f.exportBundle();
  assert.equal(exported.status, 0, exported.stderr);
  f.put("transport-export.json", exported.stdout);
  const admit = f.run("--input-type=module", [
    "-e",
    `import {readFinalGroup} from ${JSON.stringify(join(f.wb, "scripts/candidate-input.mjs"))};import {writeFileSync} from 'node:fs';const group=await readFinalGroup({input:${JSON.stringify(join(f.root, "candidate-input.json"))},sha256:${JSON.stringify(hash(readFileSync(join(f.root, "candidate-input.json"))))},checkout:${JSON.stringify(f.gea)},repo:'dsh-gea-plugin',coreSource:${JSON.stringify(f.coreSource)}});writeFileSync(${JSON.stringify(join(f.root, "quality-source-admission.json"))},JSON.stringify(group.receipt));`,
  ]);
  assert.equal(admit.status, 0, admit.stderr);
  const indexed = f.run("scripts/quality-shards.mjs", [
    "--mode",
    "index",
    "--root",
    f.root,
    "--transport",
    join(f.root, "transport-export.json"),
    "--bundle",
    join(f.root, "transport.tar"),
    "--artifact-id",
    "42",
    "--output",
    join(f.root, "quality-index.json"),
  ]);
  assert.equal(indexed.status, 0, indexed.stderr);
  const index = f.read("quality-index.json");
  assert.deepEqual(Buffer.from(index.bindingBytes), original);
  assert.deepEqual(index.binding, JSON.parse(original));
  assert.equal(index.bundleBytes, statSync(join(f.root, "transport.tar")).size);
  f.clear();
  rmSync(join(f.root, "binding.json"));
  f.put("binding.json", index.bindingBytes);
  const received = f.receive({
    ImageVersion: "fixture-image-next",
    SYSTEM_CHROME_VERSION: "155.0.8059.39",
  });
  assert.equal(received.status, 0, received.stderr);
  const record = f.read("quality-worker-inputs.json");
  assert.equal(record.bindingSha256, hash(Buffer.from(index.bindingBytes)));
  assert.equal(record.bundleBytes, index.bundleBytes);
  assert.equal(record.status, "worker-inputs-ready");
  assert.equal(record.chromeObservation.version, "Google Chrome 155.0.8059.39");
  assert.equal(
    record.steps.find((x) => x.name === "browser-availability").result.chromeVersion,
    "Google Chrome 154.0.8037.97",
  );
  assert.equal(f.read("mount-state.json").readonly, true);
  assert.equal(index.binding.worker.browser.systemChrome.sourceRootMode, 0o775);
  assert.equal(statSync(join(f.root, ".quality-system-chrome")).mode & 0o7777, 0o755);
  assert.equal(statSync(join(f.root, ".quality-system-chrome/empty-locale")).mode & 0o7777, 0o755);
  assert.equal(record.environment.producer.imageVersion, "fixture-image");
  assert.equal(record.environment.consumer.imageVersion, "fixture-image-next");
  const consumer = f.run(join(f.manage, "scripts/prepare-official-sdk.mjs"), [
    "--core",
    join(f.root, "official-latest-standard"),
    "--core-head",
    index.candidate.core,
    "--consumer",
    f.gea,
  ]);
  assert.equal(consumer.status, 0, consumer.stderr);
  assert.equal(JSON.parse(consumer.stdout).status, "prepared");
  assert.ok(JSON.parse(consumer.stdout).artifacts.length > 0);
  // Root-local lib combination metadata remains excluded by the existing general digest contract.
  f.put("candidate/dsh-gea-plugin/lib/combination.json", "GEA lib metadata");
  f.put("candidate/dsh-agent-manage/lib/combination.json", "Manage lib metadata");
  const tested = f.quality("tests", [
    "--execution-plan",
    join(f.root, "quality-test-execution-plan.json"),
    "--test-shard",
    "1",
  ]);
  assert.equal(tested.status, 0, tested.stdout + tested.stderr);
  assert.equal(readFileSync(join(f.root, "tests-executed"), "utf8"), "actual Node test");
  assert.equal(f.read("quality-test-execution.json").status, "passed");
  const sdk = f.commands().find((x) => x.command === "sdk-consumer");
  assert.ok(sdk.args.includes("--with-web"));
  assert.ok(sdk.args.includes("--with-flock"));
  assert.ok(!sdk.args.includes("--prepare"));
  // Even after transport and worker readiness, the original CLI rechecks exact output bytes.
  rmSync(join(f.root, "tests-executed"));
  f.json("quality-stages.json", index.stages);
  f.put("candidate/dsh-agent-manage/client/client.js.map", "changed after worker readiness");
  const changed = f.quality("tests", [
    "--execution-plan",
    join(f.root, "quality-test-execution-plan.json"),
    "--test-shard",
    "1",
  ]);
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.match(changed.stderr, /QUALITY_STAGE_ARTIFACT_CHANGED.*dsh-agent-manage\/client/);
  assert.equal(existsSync(join(f.root, "tests-executed")), false);
  f.json("quality-stages.json", index.stages);
  f.put("candidate/dsh-agent-manage/client/client.js.map", "fixed public sourcemap");
  f.put("candidate/dsh-agent-manage/client/combination.json", "unexpected client metadata");
  const extra = f.quality("tests", [
    "--execution-plan",
    join(f.root, "quality-test-execution-plan.json"),
    "--test-shard",
    "1",
  ]);
  assert.equal(extra.status, 1, extra.stdout + extra.stderr);
  assert.match(extra.stderr, /QUALITY_STAGE_ARTIFACT_REQUIRED: exact Manage client outputs/);
  assert.equal(existsSync(join(f.root, "tests-executed")), false);
  const cleanup = f.run("scripts/quality-system-chrome.mjs", ["cleanup", "--root", f.root]);
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("worker independently reads Linux OS and ABI and rejects drift or missing facts before source preparation or install", (t) => {
  const cases = [{ FIXTURE_OS_RELEASE: "MISSING" }, { FIXTURE_GLIBC: "2.40" }];
  for (const environment of cases) {
    const f = fixture(t, { browser: true });
    const producer = f.produce();
    assert.equal(producer.status, 0, producer.stderr);
    assert.equal(f.exportBundle().status, 0);
    f.clear();
    const r = f.receive(environment);
    assert.equal(r.status, 1, JSON.stringify(environment));
    const record = f.read("quality-worker-inputs.json");
    assert.equal(record.status, "failed");
    assert.ok(!record.steps.some((step) => step.name === "sdk-source"));
    assert.ok(!existsSync(join(f.root, "commands.jsonl")));
    if (environment.FIXTURE_GLIBC === "2.40") {
      assert.equal(record.environment.producer.glibc, "2.39");
      assert.equal(record.environment.consumer.glibc, "2.40");
      assert.equal(record.chromeObservation.version, "Google Chrome 154.0.8037.97");
      assert.equal(record.chromeObservation.status, "observed");
    }
  }
});

test("worker CLI overlaps two real installs while keeping nested Workbench inventory serial", (t) => {
  const f = fixture(t, { runtime: true });
  assert.equal(f.produce().status, 0);
  const exported = f.exportBundle();
  assert.equal(exported.status, 0, exported.stderr);
  f.clear();
  const r = f.receive({ PROCESS_INSTALLS: "1", PAIR_BARRIER: "1" });
  assert.equal(r.status, 0, r.stderr);
  const events = readFileSync(join(f.root, "install-processes.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  let active = 0,
    peak = 0;
  for (const e of events) {
    active += e.event === "start" ? 1 : -1;
    peak = Math.max(peak, active);
    assert.ok(active <= 2);
  }
  assert.equal(peak, 2, "two actual install processes must overlap");
  assert.equal(active, 0);
  assert.equal(events.filter((e) => e.event === "end").length, 6);
  const wbEnd = events.findIndex(
    (e) => e.event === "end" && e.cwd === join(f.root, "candidate/dsh-agent-workbench"),
  );
  const inventoryStart = events.findIndex(
    (e) => e.event === "start" && e.cwd.endsWith("business/inventory-apsplan/source"),
  );
  assert.ok(wbEnd < inventoryStart);
  const receipt = f.read("quality-worker-inputs.json");
  assert.equal(receipt.status, "worker-inputs-ready");
  const paths = receipt.steps.find((step) => step.name === "package-manager-paths");
  assert.equal(paths.result.queryCount, 18);
  assert.ok(
    f
      .commands()
      .filter((command) => command.command === "corepack" && command.args.includes("install"))
      .every((command) => command.args.includes("--config.enable-global-virtual-store=false")),
    "pnpm installs must explicitly keep their virtual stores local after effective configuration admission",
  );
  assert.equal(paths.result.facts.length, 6);
  assert.ok(paths.durationMs >= 0);
});

async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("worker did not close after install failure")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function cleanupInstallFixture(f, child) {
  const file = join(f.root, "install-processes.jsonl");
  const events = existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  const browserPids = ["browser-leader-ready", "browser-grandchild-ready"]
    .filter((name) => existsSync(join(f.root, name)))
    .map((name) => Number(readFileSync(join(f.root, name), "utf8")));
  for (const pid of [
    child.pid,
    ...events.filter((e) => e.event === "start").map((e) => e.pid),
    ...browserPids,
  ]) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    if (browserPids.includes(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
    }
  }
}
test("worker CLI reaps its owned install group and keeps the second failure before starting queued locks", async (t) => {
  const f = fixture(t, { runtime: true });
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const run = f.receiveAsync({ PROCESS_INSTALLS: "1", INSTALL_SCENARIO: "fail-second" });
  try {
    await installFixturesReady(f, run);
    const r = await deadline(run.closed);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /controlled second install failure/);
    const receipt = f.read("quality-worker-inputs.json");
    assert.equal(receipt.status, "failed");
    assert.ok(receipt.steps.every((x) => x.status !== "running" && x.finishedAt));
    const events = readFileSync(join(f.root, "install-processes.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      events.filter((e) => e.event === "start").length,
      2,
      "queued installs cannot start after failure",
    );
    for (const e of events.filter((e) => e.event === "start"))
      assert.throws(() => process.kill(-e.pid, 0), { code: "ESRCH" });
    assert.ok(!receipt.steps.some((x) => x.name === "sdk-cache"));
    writeFileSync(join(f.root, "release-grandchild"), "release");
    assert.ok(!existsSync(join(f.root, "late-write")));
  } finally {
    cleanupInstallFixture(f, run.child);
    await run.closed;
  }
});

test("worker CLI rechecks all fresh dependency roots after managers are ready before either install starts", (t) => {
  const f = fixture(t);
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive({ MUTATE_AFTER_MANAGERS: "1" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /independent fresh node_modules required: official-core/);
  assert.equal(
    f.commands().filter((x) => x.args.includes("ci") || x.args.includes("install")).length,
    0,
  );
  assert.ok(
    !existsSync(join(f.root, "install-created.jsonl")),
    "no install process may be created before the full preflight succeeds",
  );
  assert.equal(f.read("quality-worker-inputs.json").status, "failed");
});

function fileReady(file, timeoutMs = 5000, signal) {
  return new Promise((resolve, reject) => {
    let timer, watcher;
    const finish = (error) => {
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal.reason);
    if (signal?.aborted) return onAbort();
    timer = setTimeout(
      () => finish(Error("fixture process did not become ready: " + file)),
      timeoutMs,
    );
    const check = () => {
      if (existsSync(file)) finish();
    };
    watcher = watch(dirname(file), check);
    watcher.on("error", finish);
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

async function installFixturesReady(f, run) {
  const waiting = new AbortController();
  try {
    await Promise.race([
      Promise.all([
        fileReady(join(f.root, "grandchild-ready"), 15000, waiting.signal),
        fileReady(join(f.root, "second-install-ready"), 15000, waiting.signal),
      ]),
      run.closed.then((result) => {
        throw Error("worker exited before install fixtures became ready", { cause: result });
      }),
    ]);
  } finally {
    waiting.abort();
  }
}

test("worker readiness preserves an early CLI failure instead of masking it as a readiness timeout", async (t) => {
  const f = fixture(t, { runtime: true });
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const run = f.receiveAsync({
    PROCESS_INSTALLS: "1",
    INSTALL_SCENARIO: "cancel",
    WRONG_MANAGER: "1",
  });
  try {
    await assert.rejects(installFixturesReady(f, run), (error) => {
      assert.equal(error.message, "worker exited before install fixtures became ready");
      assert.equal(error.cause.code, 1);
      assert.equal(error.cause.signal, null);
      assert.match(error.cause.stderr, /actual package manager changed: dsh-agent-manage/);
      assert.equal(existsSync(join(f.root, "grandchild-ready")), false);
      assert.equal(existsSync(join(f.root, "second-install-ready")), false);
      return true;
    });
  } finally {
    cleanupInstallFixture(f, run.child);
    await run.closed;
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(
    "worker CLI cancellation by " +
      signal +
      " closes owned install descendants before returning failure",
    async (t) => {
      const f = fixture(t, { runtime: true });
      assert.equal(f.produce().status, 0);
      assert.equal(f.exportBundle().status, 0);
      f.clear();
      const run = f.receiveAsync({ PROCESS_INSTALLS: "1", INSTALL_SCENARIO: "cancel" });
      let failure;
      try {
        await installFixturesReady(f, run);
        run.child.kill(signal);
        const r = await deadline(run.closed);
        assert.equal(r.code, 1, r.stderr);
        assert.match(r.stderr, new RegExp("cancelled by " + signal));
        const receipt = f.read("quality-worker-inputs.json");
        assert.equal(receipt.status, "failed");
        assert.ok(receipt.steps.every((x) => x.status !== "running" && x.finishedAt));
        const events = readFileSync(join(f.root, "install-processes.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.equal(events.filter((e) => e.event === "start").length, 2);
        for (const e of events.filter((e) => e.event === "start"))
          assert.throws(() => process.kill(-e.pid, 0), { code: "ESRCH" });
        writeFileSync(join(f.root, "release-grandchild"), "release");
        assert.ok(!existsSync(join(f.root, "late-write")));
        assert.ok(!receipt.steps.some((x) => x.name === "sdk-cache"));
        assert.equal(
          f.commands().some((entry) => entry.command === "sudo"),
          false,
        );
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        cleanupInstallFixture(f, run.child);
        const worker = await run.closed;
        if (failure)
          t.diagnostic(
            JSON.stringify({
              signal,
              ready: Object.fromEntries(
                ["grandchild-ready", "second-install-ready"].map((name) => [
                  name,
                  existsSync(join(f.root, name)),
                ]),
              ),
              events: existsSync(join(f.root, "install-processes.jsonl"))
                ? readFileSync(join(f.root, "install-processes.jsonl"), "utf8")
                : "",
              worker,
            }),
          );
      }
    },
  );
}

test("worker CLI refuses installation path configuration introduced while managers become ready", (t) => {
  const f = fixture(t, { runtime: true });
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive({ MUTATE_INSTALL_CONFIG: "1" });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(
    !existsSync(join(f.root, "install-created.jsonl")),
    "path configuration must be rejected before creating an install process",
  );
  assert.match(r.stderr, /install configuration changed/);
  assert.equal(f.read("quality-worker-inputs.json").status, "failed");
});

test("worker CLI retains exact managers and rejects existing or shared dependency roots before installs", (t) => {
  for (const scenario of ["manager", "existing", "shared"]) {
    const f = fixture(t);
    assert.equal(f.produce().status, 0);
    assert.equal(f.exportBundle().status, 0);
    f.clear();
    if (scenario === "existing")
      f.put("candidate/dsh-agent-manage/node_modules/marker", "existing");
    if (scenario === "shared") {
      f.put("shared-dependencies/marker", "shared");
      symlinkSync(join(f.root, "shared-dependencies"), join(f.manage, "node_modules"), "dir");
    }
    const r = f.receive(scenario === "manager" ? { WRONG_MANAGER: "1" } : {});
    assert.equal(r.status, 1, r.stderr);
    assert.match(
      r.stderr,
      scenario === "manager"
        ? /actual package manager changed: dsh-agent-manage/
        : scenario === "shared"
          ? /clean full source required|independent fresh node_modules required: dsh-agent-manage/
          : /independent fresh node_modules required: dsh-agent-manage/,
    );
    assert.equal(
      (existsSync(join(f.root, "commands.jsonl")) ? f.commands() : []).filter(
        (x) => x.args.includes("install") || x.args.includes("ci"),
      ).length,
      0,
    );
    assert.equal(f.read("quality-worker-inputs.json").status, "failed");
  }
});

test("worker CLI reaps descendants holding stdio after a successful install leader exits", async (t) => {
  const f = fixture(t, { runtime: true });
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  // Establish both concurrent installs before the leader exits; scheduler speed is not a precondition.
  const run = f.receiveAsync({
    PROCESS_INSTALLS: "1",
    PAIR_BARRIER: "1",
    INSTALL_SCENARIO: "leader-exit",
  });
  try {
    const r = await deadline(run.closed);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /install left an owned process group/);
    const receipt = f.read("quality-worker-inputs.json");
    assert.equal(receipt.status, "failed");
    assert.ok(receipt.steps.every((step) => step.status !== "running" && step.finishedAt));
    assert.ok(!receipt.steps.some((step) => step.name === "sdk-cache"));
    const events = readFileSync(join(f.root, "install-processes.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(events.filter((event) => event.event === "leader-exit-zero").length, 1);
    assert.equal(
      events.filter((event) => event.event === "start").length,
      2,
      "no queued lock starts after leader leaves its group",
    );
    for (const event of events.filter((event) => event.event === "start"))
      assert.throws(() => process.kill(-event.pid, 0), { code: "ESRCH" });
    writeFileSync(join(f.root, "release-grandchild"), "release");
    assert.ok(!existsSync(join(f.root, "late-write")));
  } finally {
    cleanupInstallFixture(f, run.child);
    await run.closed;
  }
});

test("worker CLI rejects a real pnpm global virtual store before any independent install", (t) => {
  const external = realpathSync(mkdtempSync(join(tmpdir(), "quality-global-config-")));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  mkdirSync(join(external, "pnpm"));
  const shared = join(external, "shared-virtual-store"),
    sentinel = "do-not-print-auth-config";
  writeFileSync(
    join(external, "pnpm/config.yaml"),
    "virtualStoreDir: " +
      JSON.stringify(shared) +
      "\nregistries:\n  default:\n    authToken: " +
      sentinel +
      "\n",
  );
  const f = fixture(t, { runtime: true, actualPnpmConfig: true });
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive({ XDG_CONFIG_HOME: external });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /effective install path.*virtualStoreDir/);
  assert.equal(
    f.commands().filter((x) => x.args.includes("ci") || x.args.includes("install")).length,
    0,
  );
  assert.equal(f.read("quality-worker-inputs.json").status, "failed");
  assert.ok(!r.stdout.includes(sentinel) && !r.stderr.includes(sentinel));
  assert.ok(!existsSync(shared));
});

test("worker CLI rejects unverified external user and global npmrc entries before installing", (t) => {
  const external = realpathSync(mkdtempSync(join(tmpdir(), "quality-user-config-")));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  const file = join(external, "shared.npmrc"),
    shared = join(external, "shared-virtual-store");
  writeFileSync(file, "virtual-store-dir=" + shared + "\n");
  for (const key of [
    "npm_config_userconfig",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_globalconfig",
    "NPM_CONFIG_GLOBALCONFIG",
  ]) {
    const f = fixture(t, { runtime: true, actualPnpmConfig: true });
    assert.equal(f.produce().status, 0);
    assert.equal(f.exportBundle().status, 0);
    f.clear();
    const r = f.receive({ [key]: file, XDG_CONFIG_HOME: external });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /unverified install configuration entry/);
    assert.equal(
      f.commands().filter((x) => x.args.includes("ci") || x.args.includes("install")).length,
      0,
    );
    assert.equal(f.read("quality-worker-inputs.json").status, "failed");
    assert.ok(!existsSync(shared));
  }
});

test("worker CLI path query failures do not publish external configuration contents", (t) => {
  const external = realpathSync(mkdtempSync(join(tmpdir(), "quality-private-config-")));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  mkdirSync(join(external, "pnpm"));
  const sentinel = "do-not-print-private-configuration";
  writeFileSync(join(external, "pnpm/config.yaml"), "virtualStoreDir: [" + sentinel + "\n");
  const f = fixture(t, { actualPnpmConfig: true });
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive({ XDG_CONFIG_HOME: external });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(
    !r.stdout.includes(sentinel) && !r.stderr.includes(sentinel),
    "only path query status may be published, never config parser contents",
  );
  assert.ok(!readFileSync(join(f.root, "quality-worker-inputs.json"), "utf8").includes(sentinel));
  assert.equal(
    f.commands().filter((x) => x.args.includes("ci") || x.args.includes("install")).length,
    0,
  );
});

test("worker CLI keeps the original cancellation cause while reading effective manager paths", async (t) => {
  const f = fixture(t);
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const run = f.receiveAsync({ PROCESS_INSTALLS: "1", INSTALL_SCENARIO: "cancel-path" });
  try {
    await deadline(fileReady(join(f.root, "grandchild-ready")));
    run.child.kill("SIGINT");
    const r = await deadline(run.closed);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /installation cancelled by SIGINT/);
    const receipt = f.read("quality-worker-inputs.json");
    assert.equal(receipt.status, "failed");
    assert.ok(receipt.steps.every((step) => step.status !== "running" && step.finishedAt));
    assert.ok(!receipt.steps.some((step) => step.name.startsWith("install:")));
    const events = readFileSync(join(f.root, "install-processes.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    for (const event of events.filter((event) => event.event === "start"))
      assert.throws(() => process.kill(-event.pid, 0), { code: "ESRCH" });
  } finally {
    cleanupInstallFixture(f, run.child);
    await run.closed;
  }
});

test("worker CLI rejects an enabled global virtual store before its per-install isolation flag", (t) => {
  const external = realpathSync(mkdtempSync(join(tmpdir(), "quality-enabled-global-store-")));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  mkdirSync(join(external, "pnpm"));
  writeFileSync(join(external, "pnpm/config.yaml"), "enableGlobalVirtualStore: true\n");
  const f = fixture(t, { actualPnpmConfig: true });
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive({ XDG_CONFIG_HOME: external });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /effective install path.*enableGlobalVirtualStore/);
  assert.equal(
    f.commands().filter((x) => x.args.includes("ci") || x.args.includes("install")).length,
    0,
  );
  assert.equal(f.read("quality-worker-inputs.json").status, "failed");
});

test("worker CLI records real safe pnpm path facts without exposing its global config contents", (t) => {
  const external = realpathSync(mkdtempSync(join(tmpdir(), "quality-safe-global-config-")));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  mkdirSync(join(external, "pnpm"));
  const sentinel = "private-registry-setting-not-for-receipts";
  const config = join(external, "pnpm/config.yaml");
  writeFileSync(
    config,
    "virtualStoreDir: node_modules/.pnpm\nenableGlobalVirtualStore: false\nregistries:\n  default:\n    authToken: " +
      sentinel +
      "\n",
  );
  const f = fixture(t, { runtime: true, actualPnpmConfig: true });
  assert.equal(f.produce().status, 0);
  assert.equal(f.exportBundle().status, 0);
  f.clear();
  const r = f.receive({ XDG_CONFIG_HOME: external });
  assert.equal(r.status, 0, r.stderr);
  const receipt = f.read("quality-worker-inputs.json");
  assert.equal(receipt.status, "worker-inputs-ready");
  const paths = receipt.steps.find((step) => step.name === "package-manager-paths");
  assert.equal(paths.result.queryCount, 18);
  const core = paths.result.facts.find((fact) => fact.name === "official-core");
  assert.equal(core.modulesDir, join(f.root, "official-latest-standard/node_modules"));
  assert.equal(core.virtualStoreDir, join(core.modulesDir, ".pnpm"));
  assert.equal(core.globalConfigPath, config);
  assert.equal(core.globalVirtualStoreOrigin, "observed-false-and-enforced");
  assert.ok(!r.stdout.includes(sentinel) && !r.stderr.includes(sentinel));
});
