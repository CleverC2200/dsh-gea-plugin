import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  rmSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("the public verifier rejects missing or substituted source remotes in independent local clones", () => {
  const directory = mkdtempSync(join(tmpdir(), "gea-upstream-source-"));
  const upstream = resolve("../../../current-mainline-closeout-44");
  const fixed = JSON.parse(readFileSync("scripts/quality-upstreams.json", "utf8"));
  try {
    for (const file of Object.keys(fixed.genui.files)) {
      const target = join(directory, "upstream-assets/genui-0.11.3", file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(upstream, "upstream-assets/genui-0.11.3", file), target);
    }
    const reference = join(directory, "upstream-reference");
    mkdirSync(reference);
    for (const name of ["dsh-genui", "dsh-better-sidebar"]) {
      const result = spawnSync(
        "git",
        [
          "clone",
          "--no-hardlinks",
          join(upstream, "upstream-reference", name),
          join(reference, name),
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const verify = () =>
      spawnSync(process.execPath, ["scripts/quality-upstreams.mjs", "--root", directory], {
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
