import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, writeFile, rm, symlink, readFile, realpath } from "node:fs/promises";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./core-cache.mjs", import.meta.url));
async function fixture(t, built = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "delivery-core-cache-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["apps/desktop", "apps/cli", "packages/boot/app-boot"])
    await mkdir(join(root, path), { recursive: true });
  for (const path of [
    "package.json",
    "apps/desktop/package.json",
    "apps/cli/package.json",
    "packages/boot/app-boot/package.json",
  ])
    await writeFile(join(root, path), JSON.stringify({ packageManager: "pnpm@11.7.0" }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['apps/*']\n");
  await writeFile(
    join(root, ".gitignore"),
    "lib/\n.dsh-build/\n.desktop-build/\nprofiles/\ndist/\n",
  );
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
  async function build() {
    for (const path of [
      "apps/desktop/lib/main.js",
      "apps/cli/lib/bin.js",
      "packages/boot/app-boot/lib/index.js",
    ]) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), "export default 'built';\n");
    }
  }
  if (built) await build();
  const run = (operation, extra = {}, profile = "host") =>
    spawnSync(process.execPath, [cli, operation, root, profile], {
      encoding: "utf8",
      env: { ...process.env, ...extra },
    });
  return { root, run, build };
}

test("delivery Core CLI reuses a complete sealed host build without caching profiles", async (t) => {
  const { root, run, build } = await fixture(t, false);
  let result = run("plan");
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.ok(plan.paths.some((path) => normalize(path) === join(root, "apps/desktop/lib")));
  assert.ok(plan.paths.every((path) => !/node_modules|profiles|seed|install/.test(path)));
  result = run("verify");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hit, false);
  await build();
  result = run("seal");
  assert.equal(result.status, 0, result.stderr);
  await mkdir(join(root, "profiles"));
  await writeFile(join(root, "profiles", "user.json"), "private");
  result = run("verify");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hit, true);
});

test("delivery refuses missing cold packaging tools before Core compilation", async (t) => {
  const { run } = await fixture(t);
  const result = run("preflight");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_TOOLS_MISSING/);
});

test("delivery refuses untracked source before assigning a reusable Core key", async (t) => {
  const { root, run } = await fixture(t);
  await writeFile(join(root, "unexpected-source.mjs"), "export default true;\n");
  const result = run("plan");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_CACHE_SOURCE_CHANGED/);
});

for (const change of ["changed", "missing", "extra", "linked"]) {
  test(`delivery rejects ${change} Core output after sealing`, async (t) => {
    const { root, run } = await fixture(t);
    assert.equal(run("seal").status, 0);
    const path = join(root, "packages/boot/app-boot/lib");
    if (change === "changed") await writeFile(join(path, "index.js"), "tampered");
    if (change === "missing") await rm(join(path, "index.js"));
    if (change === "extra") await writeFile(join(path, "unexpected.js"), "injected");
    if (change === "linked") {
      await rm(path, { recursive: true });
      await symlink(join(root, "apps/cli/lib"), path, "junction");
    }
    const result = run("verify");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DELIVERY_CACHE_(?:OUTPUT_CHANGED|ARTIFACT_TYPE|SOURCE_CHANGED)/);
  });
}

test("delivery invalidates Core reuse for target image and public client inputs", async (t) => {
  const { run } = await fixture(t);
  assert.equal(run("seal").status, 0);
  const initial = JSON.parse(run("plan").stdout).key;
  for (const env of [
    { DSH_DESKTOP_TARGET_ARCH: "different" },
    { DSH_DESKTOP_TARGET_PLATFORM: "different" },
    { DSH_CLIENT_TITLE: "different" },
    { ImageVersion: "different" },
  ]) {
    const plan = run("plan", env);
    assert.equal(plan.status, 0, plan.stderr);
    assert.notEqual(JSON.parse(plan.stdout).key, initial);
    const result = run("verify", env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DELIVERY_CACHE_IDENTITY_MISMATCH/);
  }
});

test("delivery invalidates Core reuse when committed lock and source change", async (t) => {
  const { root, run } = await fixture(t);
  assert.equal(run("seal").status, 0);
  const initial = JSON.parse(run("plan").stdout).key;
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nsettings: {}\n");
  execFileSync("git", ["add", "pnpm-lock.yaml"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "change lock",
    ],
    { cwd: root },
  );
  const result = run("verify");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_CACHE_IDENTITY_MISMATCH/);
  assert.notEqual(JSON.parse(run("plan").stdout).key, initial);
});

test(
  "delivery rejects a linked cache receipt",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, run } = await fixture(t);
    assert.equal(run("seal").status, 0);
    const receipt = join(root, ".dsh-build/delivery-core-cache.json");
    const other = join(root, "profiles/receipt.json");
    await mkdir(join(root, "profiles"));
    await writeFile(other, await readFile(receipt));
    await rm(receipt);
    await symlink(other, receipt);
    const result = run("verify");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DELIVERY_CACHE_ARTIFACT_TYPE/);
  },
);

test("official delivery requires web outputs and the public client build record", async (t) => {
  const { root, run } = await fixture(t);
  let result = run("seal", {}, "official");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_CACHE_OUTPUTS_INCOMPLETE/);
  await mkdir(join(root, "apps/web/dist"), { recursive: true });
  await mkdir(join(root, ".dsh-build"), { recursive: true });
  await writeFile(join(root, "apps/web/dist/index.html"), "<html>built</html>");
  await writeFile(join(root, ".dsh-build/client-build-environment.json"), "{}");
  result = run("seal", {}, "official");
  assert.equal(result.status, 0, result.stderr);
  result = run("verify", {}, "official");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hit, true);
  const hostKey = JSON.parse(run("plan").stdout).key;
  assert.notEqual(JSON.parse(result.stdout).key, hostKey);
  await writeFile(join(root, "apps/web/dist/index.html"), "<html>changed</html>");
  result = run("verify", {}, "official");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_CACHE_OUTPUT_CHANGED/);
});

test("delivery CLI emits a verified hit and exact output paths for Actions", async (t) => {
  const { root, run } = await fixture(t);
  assert.equal(run("seal").status, 0);
  const output = join(root, ".dsh-build/actions-output");
  const result = run("verify", { GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(output, "utf8");
  assert.match(
    text,
    /^key=delivery-core-[a-f0-9]{64}\nhit=true\nintegrity=verified\npaths<<DELIVERY_CORE_PATHS\n/,
  );
  assert.ok(text.split("\n").some((path) => normalize(path) === join(root, "apps/desktop/lib")));
  assert.ok(text.endsWith("\nDELIVERY_CORE_PATHS\n"));
});

test("delivery rejects orphaned cached output when its receipt is missing", async (t) => {
  const { run } = await fixture(t);
  const result = run("verify");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DELIVERY_CACHE_RECEIPT_MISSING/);
});

test("a failed wrapper leaves independently verified Core reusable without caching wrapper evidence", async (t) => {
  const { root, run } = await fixture(t);
  assert.equal(run("seal").status, 0);
  const wrapperEvidence = join(root, ".dsh-build/wrapper-failure.json");
  const wrapper = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[1], "wrapper failed"); process.exit(23);',
    wrapperEvidence,
  ]);
  assert.equal(wrapper.status, 23);
  const verified = run("verify");
  assert.equal(verified.status, 0, verified.stderr);
  const result = JSON.parse(verified.stdout);
  assert.equal(result.hit, true);
  assert.ok(!result.paths.includes(wrapperEvidence));
  assert.ok(result.paths.every((path) => !/profiles|seed|install/.test(path)));
});

async function prepareWindowsRuntime(root) {
  const target = join(root, "apps/desktop/.desktop-build/targets/win-x64");
  for (const path of [
    "electron/electron.exe",
    "runtime/versions.json",
    "runtime/pnpm/bin/pnpm.mjs",
    "runtime/cli/command-manager.js",
    "dsh/package.json",
    "dsh/desktop-runtime.json",
    "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js",
  ]) {
    await mkdir(join(target, path, ".."), { recursive: true });
    await writeFile(join(target, path), "prepared Core runtime");
  }
  return target;
}

test("prepared Windows runtime restores into another checkout without reusing company state", async (t) => {
  const { root, run } = await fixture(t);
  assert.equal(run("seal").status, 0);
  assert.equal(JSON.parse(run("verify", {}, "windows-runtime").stdout).hit, false);
  const target = await prepareWindowsRuntime(root);
  await mkdir(join(target, "company-seed"));
  await writeFile(join(target, "company-seed/manifest.json"), "old company packages");
  let result = run("seal", {}, "windows-runtime");
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(run("plan", {}, "windows-runtime").stdout);
  assert.deepEqual(
    plan.paths.slice(0, 3).map((path) => path.slice(target.length + 1)),
    ["dsh", "electron", "runtime"],
  );
  assert.ok(plan.paths.every((path) => !/company-seed|seed-home|packed|profiles/.test(path)));
  const copy = await realpath(await mkdtemp(join(tmpdir(), "restored-delivery-")));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(root, copy, { recursive: true });
  await rm(join(copy, "apps/desktop/.desktop-build/targets/win-x64/company-seed"), {
    recursive: true,
  });
  result = spawnSync(process.execPath, [cli, "verify", copy, "windows-runtime"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hit, true);
  assert.equal(JSON.parse(run("verify").stdout).hit, true);
});

test("Windows runtime key survives company releases but changes for preparation inputs", async (t) => {
  const { root, run } = await fixture(t);
  await prepareWindowsRuntime(root);
  assert.equal(run("seal", {}, "windows-runtime").status, 0);
  const key = JSON.parse(run("plan", {}, "windows-runtime").stdout).key;
  const release = {
    GEA_COMPLETE_SOURCE_SHA: "b".repeat(40),
    DSH_DESKTOP_BUILD_VERSION: "0.2.0-rc.2.20261022.2",
  };
  assert.equal(JSON.parse(run("plan", release, "windows-runtime").stdout).key, key);
  assert.equal(JSON.parse(run("verify", release, "windows-runtime").stdout).hit, true);
  assert.notEqual(
    JSON.parse(run("plan", { DSH_DESKTOP_APP_ID: "changed" }, "windows-runtime").stdout).key,
    key,
  );
  assert.match(
    run("verify", { DSH_DESKTOP_APP_ID: "changed" }, "windows-runtime").stderr,
    /DELIVERY_CACHE_IDENTITY_MISMATCH/,
  );
  assert.notEqual(
    JSON.parse(
      run("plan", { DSH_DESKTOP_NPM_REGISTRY: "https://mirror.example" }, "windows-runtime").stdout,
    ).key,
    key,
  );
});

test("Windows runtime rejects missing required files and altered restored production dependencies", async (t) => {
  const { root, run } = await fixture(t);
  const target = await prepareWindowsRuntime(root);
  await rm(join(target, "electron/electron.exe"));
  assert.match(run("seal", {}, "windows-runtime").stderr, /DELIVERY_CACHE_OUTPUTS_INCOMPLETE/);
  await prepareWindowsRuntime(root);
  assert.equal(run("seal", {}, "windows-runtime").status, 0);
  await writeFile(
    join(target, "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js"),
    "changed Host",
  );
  assert.match(run("verify", {}, "windows-runtime").stderr, /DELIVERY_CACHE_OUTPUT_CHANGED/);
});

test("macOS baseline cache is limited to its fixed DMG and refuses incorrect bytes", async (t) => {
  const { root, run } = await fixture(t);
  const plan = JSON.parse(run("plan", {}, "mac-baseline").stdout);
  assert.equal(plan.paths.length, 2);
  assert.equal(
    JSON.parse(
      run(
        "plan",
        { ImageVersion: "another-image", DSH_DESKTOP_BUILD_VERSION: "another-release" },
        "mac-baseline",
      ).stdout,
    ).key,
    plan.key,
  );
  assert.equal(
    normalize(plan.paths[0]),
    join(root, "apps/desktop/.desktop-build/baseline/mac-arm64.dmg"),
  );
  assert.equal(JSON.parse(run("verify", {}, "mac-baseline").stdout).hit, false);
  await mkdir(join(plan.paths[0], ".."), { recursive: true });
  await writeFile(plan.paths[0], "wrong baseline");
  assert.match(run("seal", {}, "mac-baseline").stderr, /DELIVERY_CACHE_BASELINE_CHANGED/);
});

test("Windows runtime reuse follows preparation implementation instead of final packaging", async (t) => {
  const { root } = await fixture(t, false);
  const tooling = await realpath(await mkdtemp(join(tmpdir(), "delivery-preparation-tooling-")));
  t.after(() => rm(tooling, { recursive: true, force: true }));
  await mkdir(join(tooling, "windows-complete-local"));
  await mkdir(join(tooling, "mac-complete-local"));
  await cp(cli, join(tooling, "windows-complete-local/core-cache.mjs"));
  await cp(
    fileURLToPath(new URL("../mac-complete-local/baseline.mjs", import.meta.url)),
    join(tooling, "mac-complete-local/baseline.mjs"),
  );
  const finalBuild = join(tooling, "windows-complete-local/build.mjs");
  const preparation = join(tooling, "windows-complete-local/prepare.mjs");
  const compilation = join(tooling, "windows-complete-local/compile.mjs");
  await writeFile(finalBuild, "final packaging v1");
  await writeFile(preparation, "prepare runtime v1");
  await writeFile(compilation, "compile Core v1");
  const plan = (profile = "windows-runtime") => {
    const result = spawnSync(
      process.execPath,
      [join(tooling, "windows-complete-local/core-cache.mjs"), "plan", root, profile],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).key;
  };
  const original = plan();
  const originalCore = plan("official");
  await writeFile(finalBuild, "final packaging and reporting v2");
  assert.equal(plan(), original);
  await writeFile(preparation, "prepare runtime v2");
  assert.notEqual(plan(), original);
  assert.equal(plan("official"), originalCore);
  const preparedRuntime = plan();
  await writeFile(compilation, "compile Core v2");
  assert.notEqual(plan("official"), originalCore);
  assert.notEqual(plan(), preparedRuntime);
});

test("cache verification reports its sealed source and distinguishes disabled reuse from a miss", async (t) => {
  const { run } = await fixture(t, false);
  let result = JSON.parse(run("verify").stdout);
  assert.equal(result.reason, "readable-scope-empty");
  result = JSON.parse(run("verify", { DSH_DELIVERY_REUSE_INPUTS: "false" }).stdout);
  assert.equal(result.reason, "reuse-disabled");
  const prepared = await fixture(t);
  assert.equal(
    prepared.run("seal", {
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
    }).status,
    0,
  );
  result = JSON.parse(prepared.run("verify", { GITHUB_REF: "refs/tags/release" }).stdout);
  assert.equal(result.sourceRef, "refs/heads/main");
  assert.equal(result.sourceSha, "a".repeat(40));
  assert.equal(result.integrity, "verified");
  assert.equal(result.reason, "verified-hit");
});

test("release preflight prepares missing default-ref caches and confirms the requested keys", async (t) => {
  const { root, run } = await fixture(t, false);
  const keys = ["official", "windows-runtime"].map(
    (profile) => JSON.parse(run("plan", {}, profile).stdout).key,
  );
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  let prepared = false;
  let dispatch;
  let unavailable = false;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const url = new URL(request.url, "http://localhost");
    if (unavailable) {
      response.writeHead(503).end("{}");
      return;
    }
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      dispatch = JSON.parse(body);
      prepared = true;
      response.end(JSON.stringify({ workflow_run_id: 91 }));
    } else if (url.pathname.endsWith("/runs/91")) {
      response.end(
        JSON.stringify({
          id: 91,
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
        }),
      );
    } else {
      assert.equal(url.searchParams.get("ref"), "refs/heads/main");
      const key = url.searchParams.get("key");
      response.end(
        JSON.stringify({ actions_caches: prepared ? [{ key, ref: "refs/heads/main" }] : [] }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const output = join(root, ".dsh-build/preflight.json");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./shared-cache.mjs", import.meta.url)), "preflight", root, output],
    {
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_REPOSITORY: "fixture/gea",
        GITHUB_DEFAULT_BRANCH: "main",
        GITHUB_REF: "refs/tags/new",
        GITHUB_TOKEN: "fixture",
        GITHUB_RUN_ID: "100",
        GITHUB_RUN_ATTEMPT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(dispatch.ref, "main");
  assert.equal(dispatch.inputs.prepare_windows_cache, "true");
  assert.deepEqual(JSON.parse(dispatch.inputs.cache_request).keys, keys);
  const receipt = JSON.parse(await readFile(output, "utf8"));
  assert.equal(receipt.reason, "default-ref-prepared");
  assert.ok(
    receipt.layers.every((layer) => layer.available && layer.sourceRef === "refs/heads/main"),
  );
  unavailable = true;
  const fallback = spawn(
    process.execPath,
    [fileURLToPath(new URL("./shared-cache.mjs", import.meta.url)), "preflight", root, output],
    {
      env: {
        ...process.env,
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_REPOSITORY: "fixture/gea",
        GITHUB_DEFAULT_BRANCH: "main",
        GITHUB_REF: "refs/tags/new",
        GITHUB_TOKEN: "fixture",
      },
      stdio: "ignore",
    },
  );
  assert.equal(await new Promise((resolve) => fallback.on("close", resolve)), 0);
  const failure = JSON.parse(await readFile(output, "utf8"));
  assert.equal(failure.reason, "cache-api-503");
  assert.equal(failure.fallback, "cold-preparation");
});

test("shared cache producer rejects nondefault events and mismatched preparation requests", async (t) => {
  const { root, run } = await fixture(t, false);
  const keys = ["official", "windows-runtime"].map(
    (profile) => JSON.parse(run("plan", {}, profile).stdout).key,
  );
  const producer = (env) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./shared-cache.mjs", import.meta.url)), "check-request", root],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF: "refs/heads/main",
          GITHUB_DEFAULT_BRANCH: "main",
          CACHE_REQUEST: JSON.stringify({ keys }),
          ...env,
        },
      },
    );
  const accepted = producer({});
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(
    producer({ GITHUB_REF: "refs/heads/feature" }).stderr,
    /DELIVERY_CACHE_DEFAULT_REF_REQUIRED/,
  );
  assert.match(
    producer({ GITHUB_EVENT_NAME: "pull_request" }).stderr,
    /DELIVERY_CACHE_DEFAULT_REF_REQUIRED/,
  );
  assert.match(
    producer({ CACHE_REQUEST: JSON.stringify({ keys: ["different"] }) }).stderr,
    /DELIVERY_CACHE_PREPARATION_INPUT_CHANGED/,
  );
});
