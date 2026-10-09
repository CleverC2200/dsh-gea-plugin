import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
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
