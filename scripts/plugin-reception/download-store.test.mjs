import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "reception-store-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pnpm = join(root, "pnpm.mjs");
  await writeFile(
    pnpm,
    `if (process.argv.slice(2).join(' ') !== 'store path') process.exit(2); console.log(process.env.RECEPTION_FIXTURE_STORE);`,
  );
  const home = join(root, "home");
  const receipt = join(root, "receipt.json");
  const env = {
    ...process.env,
    RECEPTION_FIXTURE_STORE: join(root, "public-store"),
    npm_config_token: "PRIVATE_TEST_TOKEN",
  };
  const run = (options = []) =>
    spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "empty-profile.mjs"),
        "--mode",
        "install",
        "--core",
        root,
        "--home",
        home,
        "--profile",
        join(home, "profiles/reception"),
        "--pnpm",
        pnpm,
        "--receipt",
        receipt,
        ...options,
      ],
      { env, encoding: "utf8" },
    );
  return { root, home, receipt, pnpm, env, run };
}

test("direct reception resolves the caller's public store before Core admission and records its selection", async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.notEqual(result.status, 0);
  const receipt = JSON.parse(await readFile(f.receipt, "utf8"));
  assert.deepEqual(receipt.downloadStore, { mode: "shared", path: join(f.root, "public-store") });
  await assert.rejects(access(f.home));
});

test("direct reception supports explicit shared and cold stores and rejects invalid configuration before creating Home", async (t) => {
  for (const [name, options, expected] of [
    [
      "explicit",
      (f) => ["--store", join(f.root, "chosen-store")],
      (f) => ({ mode: "shared", path: join(f.root, "chosen-store") }),
    ],
    [
      "cold",
      () => ["--cold-download"],
      (f) => ({ mode: "cold", path: join(f.home, "pnpm-store") }),
    ],
    [
      "relative",
      () => ["--store", "relative?token=PRIVATE_TEST_TOKEN"],
      "RECEPTION_STORE_ABSOLUTE_REQUIRED",
    ],
    ["file", (f) => ["--store", f.pnpm], "RECEPTION_STORE_DIRECTORY_REQUIRED"],
    [
      "conflict",
      (f) => ["--cold-download", "--store", join(f.root, "store")],
      "RECEPTION_STORE_OPTIONS_CONFLICT",
    ],
    ["bad-default", () => [], "RECEPTION_STORE_ABSOLUTE_REQUIRED"],
  ])
    await t.test(name, async (t) => {
      const f = await fixture(t);
      if (name === "bad-default") f.env.RECEPTION_FIXTURE_STORE = "relative";
      const result = f.run(options(f));
      assert.notEqual(result.status, 0);
      const receipt = JSON.parse(await readFile(f.receipt, "utf8"));
      if (typeof expected === "function") assert.deepEqual(receipt.downloadStore, expected(f));
      else assert.equal(receipt.failure, expected);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TEST_TOKEN/);
      await assert.rejects(access(f.home));
    });
});

test("public reception preserves the selected store while installing with a private Home and empty credentials", async (t) => {
  const f = await fixture(t);
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { pathToFileURL } = await import("node:url");
  const put = async (file, contents) => {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, contents);
  };
  const cli = join(f.root, "dsh-gea-plugin/scripts");
  await mkdir(join(cli, "plugin-reception"), { recursive: true });
  for (const file of [
    "plugin-reception.mjs",
    "supported-cores.mjs",
    "plugin-reception/contract.mjs",
    "plugin-reception/empty-profile.mjs",
    "plugin-reception/install-worker.mjs",
    "plugin-reception/download-store.mjs",
  ]) {
    const original = join(import.meta.dirname, "..", file);
    const runtime = pathToFileURL(join(import.meta.dirname, "../runtime-environment.mjs")).href;
    await put(
      join(cli, file),
      (await readFile(original, "utf8")).replace(
        /(?:\.\/|\.\.\/)runtime-environment\.mjs/g,
        runtime,
      ),
    );
  }
  const core = join(f.root, "core");
  await put(join(core, "package.json"), JSON.stringify({ type: "module" }));
  await put(join(core, "apps/cli/package.json"), JSON.stringify({ version: "0.2.0-rc.2" }));
  await put(join(core, "apps/cli/lib/profile-boot.js"), "export const runProfile = () => {}; ");
  await put(
    join(core, "packages/boot/app-boot/lib/index.js"),
    "import {mkdirSync} from 'node:fs'; export const initProfile = dir => mkdirSync(dir);",
  );
  await put(
    join(core, "node_modules/@deepseek-ai/dsh-atomic-write/package.json"),
    JSON.stringify({ type: "module", exports: "./index.js" }),
  );
  await put(
    join(core, "node_modules/@deepseek-ai/dsh-atomic-write/index.js"),
    "export const withFileLock = (_file, run) => run();",
  );
  await put(
    join(core, "packages/boot/plugin-manager/lib/types/operations.js"),
    `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export async function runProfilePnpm(context,args,options) {writeFileSync(join(context.home,'operation.json'), JSON.stringify({context,args,env:options.env})); return {exitCode:7};}`,
  );
  execFileSync("git", ["init", "-q", core]);
  execFileSync("git", ["-C", core, "add", "."]);
  execFileSync("git", [
    "-C",
    core,
    "-c",
    "user.name=Reception fixture",
    "-c",
    "user.email=reception@example.invalid",
    "commit",
    "-qm",
    "fixture Core",
  ]);
  const registered = JSON.parse(
    await readFile(join(import.meta.dirname, "../supported-cores.json"), "utf8"),
  );
  registered[0].head = execFileSync("git", ["-C", core, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  await put(join(cli, "supported-cores.json"), JSON.stringify(registered));
  await put(
    join(f.root, "dsh-agent-manage/scripts/prepare-official-sdk.mjs"),
    "export const verifyOfficialSource = core => ({root:core});",
  );
  const delivery = join(f.root, "delivery");
  const packages = [];
  for (const [index, name] of [
    "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage",
    "@cleverc2200/gea-dsh-prototype",
  ].entries()) {
    const source = join(f.root, "artifact-" + index);
    await put(join(source, "package/package.json"), JSON.stringify({ name, version: "1.0.0" }));
    await mkdir(join(delivery, "packages"), { recursive: true });
    const filename = index + ".tgz";
    const archive = join(delivery, "packages", filename);
    execFileSync("tar", ["-czf", archive, "-C", source, "package"]);
    packages.push({
      name,
      version: "1.0.0",
      filename,
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    });
  }
  const manifest = join(delivery, "manifest.json");
  await put(
    manifest,
    JSON.stringify({
      status: "packaged",
      core: registered[0],
      supportedCores: registered,
      packages,
    }),
  );
  for (const mode of ["shared", "explicit", "cold"])
    await t.test(mode, async () => {
      const home = join(f.root, mode + "-home");
      const evidence = join(f.root, mode + "-evidence");
      const result = spawnSync(
        process.execPath,
        [
          join(cli, "plugin-reception.mjs"),
          "--manifest",
          manifest,
          "--core",
          core,
          "--pnpm",
          f.pnpm,
          "--home",
          home,
          "--evidence",
          evidence,
          ...(mode === "cold"
            ? ["--cold-download"]
            : mode === "explicit"
              ? ["--store", join(f.root, "explicit-store")]
              : []),
        ],
        { env: f.env, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /RECEPTION_INSTALL_FAILED/);
      const selection = {
        mode: mode === "cold" ? "cold" : "shared",
        path:
          mode === "cold"
            ? join(home, "pnpm-store")
            : mode === "explicit"
              ? join(f.root, "explicit-store")
              : f.env.RECEPTION_FIXTURE_STORE,
      };
      for (const name of ["result.json", "install.json", "install.json.installation.json"])
        assert.deepEqual(
          JSON.parse(await readFile(join(evidence, name), "utf8")).downloadStore,
          selection,
        );
      const operation = JSON.parse(await readFile(join(home, "operation.json"), "utf8"));
      assert(operation.args.includes("--store-dir=" + selection.path));
      assert(operation.args.includes("--config.enable-global-virtual-store=false"));
      assert.equal(operation.env.HOME, home);
      assert.equal(operation.env.DSH_HOME, home);
      assert.equal(operation.env.XDG_CONFIG_HOME, join(home, "config"));
      assert.equal(operation.env.npm_config_userconfig, join(home, "empty.npmrc"));
      assert.equal(operation.env.npm_config_globalconfig, join(home, "empty.npmrc"));
      assert.equal(await readFile(operation.env.npm_config_userconfig, "utf8"), "");
      assert.equal(operation.env.npm_config_token, undefined);
      assert.equal(operation.env.RECEPTION_FIXTURE_STORE, undefined);
      assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_TEST_TOKEN/);
    });
});
