import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gea-workbench-check-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const consumer = join(root, "dsh-gea-plugin");
  const cli = join(consumer, "scripts/check-workbench.mjs");
  mkdirSync(dirname(cli), { recursive: true });
  copyFileSync(resolve("scripts/check-workbench.mjs"), cli);
  const prepare = (workbench, code = "console.log(JSON.stringify(process.argv.slice(2)));") => {
    mkdirSync(join(workbench, "scripts"), { recursive: true });
    for (const file of [
      "check-source-comments.mjs",
      "check-agent-knowledge.mjs",
      "verify-official-input.mjs",
    ])
      writeFileSync(
        join(workbench, "scripts", file),
        file === "verify-official-input.mjs"
          ? 'const args=process.argv.slice(2);console.log(JSON.stringify({status:"passed",consumer:args[1],registry:args[3],args}));'
          : code,
      );
  };
  const run = (args, workbench) => {
    const env = { ...process.env };
    delete env.DSH_WORKBENCH_CHECKOUT;
    if (workbench) env.DSH_WORKBENCH_CHECKOUT = workbench;
    return spawnSync(process.execPath, [cli, ...args], { cwd: consumer, env, encoding: "utf8" });
  };
  return { root, consumer, prepare, run };
}

test("all public shared checks select the same explicit Workbench and the current consumer", (t) => {
  const f = fixture(t);
  const workbench = join(f.root, "separate tools/workbench");
  f.prepare(workbench);
  for (const name of ["comments", "knowledge", "official-input"]) {
    const result = f.run([name], workbench);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    const args = name === "official-input" ? receipt.args : receipt;
    assert.deepEqual(args.slice(0, 2), ["--root", f.consumer]);
    if (name === "knowledge")
      assert.deepEqual(args.slice(2), ["--config", "docs/agent-knowledge.json"]);
    if (name === "official-input")
      assert.deepEqual(args.slice(2), [
        "--registry",
        join(f.consumer, "scripts/supported-cores.json"),
      ]);
  }
  assert.notEqual(f.run(["official-input", "--root", f.root], workbench).status, 0);
});

test("adjacent tools remain usable and failed checks preserve their exit status", (t) => {
  const f = fixture(t);
  const workbench = join(f.root, "dsh-agent-workbench");
  f.prepare(workbench);
  const result = f.run(["comments", "--report", "report.json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).slice(2), ["--report", "report.json"]);
  f.prepare(workbench, "process.exitCode = 7;");
  assert.equal(f.run(["comments"]).status, 7);
});

test("a missing explicit tool reports its selected path without falling back to an adjacent checkout", (t) => {
  const f = fixture(t);
  f.prepare(join(f.root, "dsh-agent-workbench"));
  const selected = join(f.root, "missing");
  const result = f.run(["comments"], selected);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_TOOL_REQUIRED/);
  assert.ok(result.stderr.includes(selected));
});

test("an older tool that silently ignores consumer arguments cannot pass official verification", (t) => {
  const f = fixture(t);
  const workbench = join(f.root, "dsh-agent-workbench");
  f.prepare(workbench);
  writeFileSync(
    join(workbench, "scripts/verify-official-input.mjs"),
    'console.log("Official input: old SDK, tracked source clean");',
  );
  const result = f.run(["official-input"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WORKBENCH_CONSUMER_RECEIPT_REQUIRED/);
});

test("the public official typecheck rejects an unregistered Core and mixed declarations before tsc", (t) => {
  const f = fixture(t);
  const root = new URL("../", import.meta.url);
  const workbench = join(f.root, "dsh-agent-workbench");
  f.prepare(workbench);
  copyFileSync(
    new URL("../dsh-agent-workbench/scripts/verify-official-input.mjs", root),
    join(workbench, "scripts/verify-official-input.mjs"),
  );
  const core = join(f.root, "official");
  const cordis = join(core, "vendor/cordis/lib/types/index.d.ts");
  mkdirSync(dirname(cordis), { recursive: true });
  writeFileSync(cordis, "export {};\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: core, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const config = { compilerOptions: { paths: { "@deepseek-ai/cordis": [cordis] } } };
  writeFileSync(join(f.consumer, "tsconfig.official.json"), JSON.stringify(config));
  const registry = join(f.consumer, "scripts/supported-cores.json");
  copyFileSync(new URL("scripts/supported-cores.json", root), registry);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root)));
  const run = () =>
    spawnSync("sh", ["-c", manifest.scripts["typecheck:official"]], {
      cwd: f.consumer,
      encoding: "utf8",
      env: { ...process.env, DSH_WORKBENCH_CHECKOUT: workbench },
    });
  const unregistered = run();
  assert.notEqual(unregistered.status, 0);
  assert.match(unregistered.stderr, /OFFICIAL_INPUT_REQUIRED/);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: core, encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  writeFileSync(registry, JSON.stringify([{ head: head.stdout.trim() }]));
  const foreign = join(f.root, "foreign-sdk.d.ts");
  writeFileSync(foreign, "export {};\n");
  config.compilerOptions.paths["@deepseek-ai/dsh-sdk-client"] = [foreign];
  writeFileSync(join(f.consumer, "tsconfig.official.json"), JSON.stringify(config));
  const mixed = run();
  assert.notEqual(mixed.status, 0);
  assert.match(mixed.stderr, /OFFICIAL_SOURCE_MISMATCH/);
});
