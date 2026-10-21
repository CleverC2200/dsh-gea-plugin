import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./core-cache.mjs", import.meta.url));
async function fixture(t, built = true) {
  const root = await mkdtemp(join(tmpdir(), "delivery-core-cache-"));
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
  await writeFile(join(root, ".gitignore"), "lib/\n.dsh-build/\nprofiles/\ndist/\n");
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
  assert.ok(plan.paths.some((path) => path.endsWith("apps/desktop/lib")));
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
  assert.match(text, /^key=delivery-core-[a-f0-9]{64}\nhit=true\npaths<<DELIVERY_CORE_PATHS\n/);
  assert.ok(text.includes(join(root, "apps/desktop/lib")));
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
  const wrapper = spawnSync(process.execPath, ["--input-type=module", "-e",
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
