import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  rmSync,
  readFileSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
test("the public upstream verifier refuses an omitted input root", () => {
  const result = spawnSync(process.execPath, ["scripts/quality-upstreams.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_UPSTREAM_REQUIRED/);
});

test("the public verifier rejects missing material and a changed original asset", () => {
  const directory = mkdtempSync(join(tmpdir(), "gea-upstream-input-"));
  try {
    const run = () =>
      spawnSync(process.execPath, ["scripts/quality-upstreams.mjs", "--root", directory], {
        encoding: "utf8",
      });
    assert.match(run().stderr, /QUALITY_UPSTREAM_MATERIAL_REQUIRED/);
    mkdirSync(join(directory, "upstream-assets/genui-0.11.3"), { recursive: true });
    mkdirSync(join(directory, "upstream-reference/dsh-better-sidebar"), { recursive: true });
    writeFileSync(join(directory, "upstream-assets/genui-0.11.3/package.json"), "{}");
    assert.match(run().stderr, /QUALITY_UPSTREAM_HASH/);
    assert.deepEqual(readdirSync(join(directory, "upstream-reference/dsh-better-sidebar")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("explicit preparation refuses a borrowed root before download or install", () => {
  const directory = mkdtempSync(join(tmpdir(), "gea-upstream-owned-"));
  try {
    mkdirSync(join(directory, "real"));
    symlinkSync(join(directory, "real"), join(directory, "borrowed"), "dir");
    const result = spawnSync(
      process.execPath,
      ["scripts/quality-upstreams.mjs", "--prepare", "--root", join(directory, "borrowed")],
      { encoding: "utf8" },
    );
    assert.match(result.stderr, /QUALITY_UPSTREAM_PRIVATE_ROOT_REQUIRED/);
    assert.deepEqual(readdirSync(join(directory, "real")), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the public verifier rejects substituted sources and binds only fixed upstream inputs", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gea-upstream-source-")));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const fixed = JSON.parse(readFileSync("scripts/quality-upstreams.json", "utf8"));
  try {
    const reference = join(directory, "upstream-reference");
    mkdirSync(reference);
    for (const [name, declaration] of [
      ["dsh-genui", fixed.genui],
      ["dsh-better-sidebar", fixed.sidebar],
    ]) {
      const source = join(reference, name);
      mkdirSync(source);
      writeFileSync(
        join(source, "package.json"),
        JSON.stringify({
          main: "lib/host.js",
          types: "lib/types/host.d.ts",
          packageManager: declaration.packageManager,
        }),
      );
      writeFileSync(join(source, "pnpm-lock.yaml"), "frozen fixture lock\n");
      git(source, "init", "-q");
      git(source, "add", ".");
      git(
        source,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@invalid",
        "commit",
        "-qm",
        "fixed upstream fixture",
      );
      declaration.head = git(source, "rev-parse", "HEAD");
      if (name === "dsh-better-sidebar")
        declaration.lockSha256 = hash(readFileSync(join(source, "pnpm-lock.yaml")));
    }
    const asset = join(directory, "upstream-assets/genui-0.11.3/package.json");
    mkdirSync(dirname(asset), { recursive: true });
    writeFileSync(asset, "{}\n");
    fixed.genui.files = { "package.json": hash(readFileSync(asset)) };
    const scripts = join(directory, "scripts");
    mkdirSync(scripts);
    for (const name of ["quality-upstreams.mjs", "source-combination-integrity.mjs"])
      copyFileSync("scripts/" + name, join(scripts, name));
    writeFileSync(join(scripts, "quality-upstreams.json"), JSON.stringify(fixed));
    const verify = () =>
      spawnSync(process.execPath, [join(scripts, "quality-upstreams.mjs"), "--root", directory], {
        encoding: "utf8",
      });
    assert.match(verify().stderr, /QUALITY_UPSTREAM_SOURCE_REMOTE_REQUIRED/);
    const genui = join(reference, "dsh-genui");
    const add = spawnSync(
      "git",
      ["remote", "add", "source", "https://example.invalid/substituted.git"],
      { cwd: genui, encoding: "utf8" },
    );
    assert.equal(add.status, 0, add.stderr);
    assert.match(verify().stderr, /QUALITY_UPSTREAM_SOURCE_REMOTE_MISMATCH/);
    const source = spawnSync("git", ["remote", "get-url", "source"], {
      cwd: genui,
      encoding: "utf8",
    });
    assert.equal(source.stdout.trim(), "https://example.invalid/substituted.git");
    git(genui, "remote", "set-url", "source", fixed.genui.repository);
    const sidebar = join(reference, "dsh-better-sidebar");
    git(sidebar, "remote", "add", "source", fixed.sidebar.repository);
    for (const file of [
      "lib/host.js",
      "lib/types/host.d.ts",
      "lib/client.js",
      "lib/invariant.js",
      "lib/client-registry.js",
      "lib/client-editor.js",
      "lib/client-locale.js",
      "lib/client-mermaid.js",
      "lib/types/client/service.d.ts",
    ]) {
      mkdirSync(dirname(join(sidebar, file)), { recursive: true });
      writeFileSync(join(sidebar, file), "fixed built fixture\n");
    }
    writeFileSync(join(sidebar, ".gitignore"), "lib/\n");
    git(sidebar, "add", ".gitignore");
    git(
      sidebar,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "ignore prepared fixture output",
    );
    fixed.sidebar.head = git(sidebar, "rev-parse", "HEAD");
    writeFileSync(join(scripts, "quality-upstreams.json"), JSON.stringify(fixed));
    const { bindQualityUpstreamInputs } = await import(
      pathToFileURL(join(scripts, "quality-upstreams.mjs"))
    );
    const inputs = join(directory, "job/upstream-inputs");
    await assert.rejects(
      bindQualityUpstreamInputs(directory, inputs),
      /QUALITY_UPSTREAM_INPUT_REQUIRED/,
    );
    await bindQualityUpstreamInputs(directory, inputs, { prepare: true });
    assert.equal(realpathSync(join(inputs, "genui")), realpathSync(dirname(asset)));
    assert.equal(realpathSync(join(inputs, "sidebar")), realpathSync(sidebar));
    await bindQualityUpstreamInputs(directory, inputs);
    const borrowed = join(directory, "borrowed-inputs");
    symlinkSync(inputs, borrowed, "dir");
    await assert.rejects(
      bindQualityUpstreamInputs(directory, borrowed, { prepare: true }),
      /QUALITY_UPSTREAM_INPUT_PRIVATE_ROOT_REQUIRED/,
    );
    rmSync(join(inputs, "sidebar"));
    symlinkSync(genui, join(inputs, "sidebar"), "dir");
    await assert.rejects(
      bindQualityUpstreamInputs(directory, inputs, { prepare: true }),
      /QUALITY_UPSTREAM_INPUT_MISMATCH/,
    );
    assert.equal(realpathSync(join(inputs, "sidebar")), genui);
    writeFileSync(asset, "changed original asset\n");
    await assert.rejects(
      bindQualityUpstreamInputs(directory, inputs, { prepare: true }),
      /QUALITY_UPSTREAM_HASH/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
