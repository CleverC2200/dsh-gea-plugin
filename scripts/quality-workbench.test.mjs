import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { readPreparedWorkbench, verifyPreparedWorkbench } from "./quality-workbench.mjs";

function preparedFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gea-prepared-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    prepared = join(root, "prepared"),
    receipt = join(root, "receipt.json");
  mkdirSync(join(source, "lib/types"), { recursive: true });
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "package.json"), '{"name":"@cleverc2200/dsh-agent-workbench"}');
  writeFileSync(join(source, "package-lock.json"), "{}");
  writeFileSync(join(source, "src/input.ts"), "export const input = true;\n");
  for (const id of ["category", "mps", "regional"]) {
    mkdirSync(join(source, "static", id), { recursive: true });
    writeFileSync(join(source, "static", id, "index.html"), "original HTML\n");
    writeFileSync(join(source, "static", id, "page.json"), "{}\n");
  }
  for (const file of ["host.js", "client.js", "types/host.d.ts", "types/client.d.ts"])
    writeFileSync(join(source, "lib", file), "original output\n");
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  git("-C", source, "init", "-q");
  git("-C", source, "remote", "add", "source", "https://example.invalid/workbench");
  git("-C", source, "add", ".");
  git(
    "-C",
    source,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-qm",
    "prepared source",
  );
  const head = git("-C", source, "rev-parse", "HEAD");
  git("clone", "--no-hardlinks", source, prepared);
  git("-C", prepared, "remote", "add", "source", "https://example.invalid/workbench");
  writeFileSync(join(prepared, "lib/host.js"), "built output\n");
  return { source, prepared, head, receipt, git };
}

test("the three built static HTML outputs are frozen while authored static source remains immutable", async (t) => {
  const fixture = preparedFixture(t);
  for (const id of ["category", "mps", "regional"])
    writeFileSync(join(fixture.prepared, "static", id, "index.html"), "built HTML\n");
  const record = await readPreparedWorkbench(fixture);
  writeFileSync(fixture.receipt, JSON.stringify(record));
  await verifyPreparedWorkbench(fixture);
  writeFileSync(join(fixture.prepared, "static/category/index.html"), "changed HTML\n");
  await assert.rejects(verifyPreparedWorkbench(fixture), /QUALITY_WORKBENCH_ASSET_MISMATCH/);
  writeFileSync(join(fixture.prepared, "static/category/index.html"), "built HTML\n");
  fixture.git(
    "-C",
    fixture.prepared,
    "update-index",
    "--skip-worktree",
    "static/category/page.json",
  );
  writeFileSync(join(fixture.prepared, "static/category/page.json"), '{"changed":true}\n');
  await assert.rejects(readPreparedWorkbench(fixture), /QUALITY_WORKBENCH_SOURCE_BLOB_MISMATCH/);
});

test("prepared Git metadata changes preserve resource admission while real output changes are refused", async (t) => {
  const fixture = preparedFixture(t);
  const record = await readPreparedWorkbench(fixture);
  writeFileSync(fixture.receipt, JSON.stringify(record));
  const index = join(fixture.prepared, ".git/index"),
    before = readFileSync(index);
  fixture.git("-C", fixture.prepared, "update-index", "--index-version", "4");
  assert.notDeepEqual(readFileSync(index), before, "the real Git index bytes must change");
  writeFileSync(join(fixture.prepared, ".git/agent-local-note"), "local metadata\n");
  await verifyPreparedWorkbench(fixture);
  writeFileSync(join(fixture.prepared, "lib/client.js"), "changed runtime output\n");
  await assert.rejects(verifyPreparedWorkbench(fixture), /QUALITY_WORKBENCH_ASSET_MISMATCH/);
});

test("public prepared reads leave source and prepared Git indexes unchanged without weakening origin admission", async (t) => {
  const fixture = preparedFixture(t),
    indexes = [fixture.source, fixture.prepared].map((root) => join(root, ".git/index")),
    before = indexes.map((file) => readFileSync(file)),
    touched = new Date(Date.now() + 10000);
  for (const root of [fixture.source, fixture.prepared])
    utimesSync(join(root, "src/input.ts"), touched, touched);
  await readPreparedWorkbench(fixture);
  for (const [index, file] of indexes.entries())
    assert.deepEqual(readFileSync(file), before[index], "read-only Git must not refresh " + file);
  fixture.git(
    "-C",
    fixture.prepared,
    "remote",
    "set-url",
    "source",
    "https://example.invalid/other",
  );
  await assert.rejects(readPreparedWorkbench(fixture), /QUALITY_WORKBENCH_ORIGIN_MISMATCH/);
});
test("the public prepared Workbench verifier refuses an absent frozen receipt", () => {
  const result = spawnSync(process.execPath, ["scripts/quality-workbench.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_WORKBENCH_RECEIPT_REQUIRED/);
});

test("prepared outputs cannot conceal a dirty source checkout or a changed non-output blob", () => {
  const root = mkdtempSync(join(tmpdir(), "gea-workbench-source-"));
  try {
    const source = join(root, "source"),
      prepared = join(root, "prepared");
    mkdirSync(source);
    writeFileSync(join(source, "package.json"), "{}");
    const git = (...args) =>
      execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("-C", source, "init", "-q");
    git("-C", source, "add", ".");
    git(
      "-C",
      source,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "source input",
    );
    const head = git("-C", source, "rev-parse", "HEAD");
    git("clone", "--no-hardlinks", source, prepared);
    const receipt = join(root, "receipt.json");
    writeFileSync(receipt, "{}");
    const run = () =>
      spawnSync(
        process.execPath,
        [
          "scripts/quality-workbench.mjs",
          "--source",
          source,
          "--prepared",
          prepared,
          "--head",
          head,
          "--receipt",
          receipt,
        ],
        { encoding: "utf8" },
      );
    writeFileSync(join(source, "package.json"), '{"changed":true}');
    assert.match(run().stderr, /QUALITY_WORKBENCH_SOURCE_DIRTY/);
    writeFileSync(join(source, "package.json"), "{}");
    writeFileSync(join(prepared, "package.json"), '{"changed":true}');
    assert.match(run().stderr, /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
    assert.equal(
      existsSync(join(prepared, "lib")),
      false,
      "rejection precedes any output requirement or build",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
