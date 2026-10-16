import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourcePlugins } from "./source-composition.mjs";
import { resolveSourceInputs } from "./source-profile.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import {
  readPreparedWorkbench,
  verifyPreparedWorkbench,
  prepareWorkbenchGeaAuthority,
  prepareWorkbenchAssets,
} from "./quality-workbench.mjs";

function preparedFixture(t, worktree = false) {
  const root = mkdtempSync(join(tmpdir(), "gea-prepared-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    prepared = join(root, "prepared"),
    receipt = join(root, "receipt.json");
  mkdirSync(join(source, "lib/types"), { recursive: true });
  mkdirSync(join(source, "src"));
  writeFileSync(
    join(source, "package.json"),
    '{"name":"@cleverc2200/dsh-agent-workbench","version":"1.0.0","exports":{"./client":"lib/client.js"}}',
  );
  writeFileSync(join(source, "package-lock.json"), "{}");
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  writeFileSync(join(source, "cordis.patch.yml"), "- insert: []\n");
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
  if (worktree) git("-C", source, "worktree", "add", "--detach", prepared, head);
  else {
    git("clone", "--no-hardlinks", source, prepared);
    git("-C", prepared, "remote", "add", "source", "https://example.invalid/workbench");
  }
  writeFileSync(join(prepared, "lib/host.js"), "built output\n");
  return { source, prepared, head, receipt, git };
}

function copiedSkillFixture(t) {
  const fixture = preparedFixture(t);
  const path = join(fixture.source, "..", "manage");
  const resource =
    "business-resources/inventory-aqkc/skills/inventory-policy/rules/data-boundary.md";
  const output = "lib/business/inventory-aqkc/skills/inventory-policy/rules/data-boundary.md";
  mkdirSync(join(path, resource, ".."), { recursive: true });
  writeFileSync(join(path, resource), "Only admitted inventory rows may be read.\n");
  fixture.git("-C", path, "init", "-q");
  fixture.git("-C", path, "add", ".");
  fixture.git(
    "-C",
    path,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-qm",
    "fixed Manage Skill",
  );
  fixture.manage = { path, head: fixture.git("-C", path, "rev-parse", "HEAD") };
  mkdirSync(join(fixture.prepared, output, ".."), { recursive: true });
  copyFileSync(join(path, resource), join(fixture.prepared, output));
  return { ...fixture, resource, output };
}

test("new AQKC Skill copies from the frozen Manage source are admitted and frozen", async (t) => {
  const fixture = copiedSkillFixture(t);
  const record = await readPreparedWorkbench(fixture);
  writeFileSync(fixture.receipt, JSON.stringify(record));
  await verifyPreparedWorkbench(fixture);
  const assets = join(fixture.source, "..", "copied-assets");
  await prepareWorkbenchAssets({ ...fixture, assets });
  assert.equal(
    readFileSync(join(assets, fixture.output), "utf8"),
    "Only admitted inventory rows may be read.\n",
  );
});

test("the public verifier uses caller-frozen Manage input for copied Skills", async (t) => {
  const fixture = copiedSkillFixture(t);
  const record = await readPreparedWorkbench(fixture);
  writeFileSync(fixture.receipt, JSON.stringify(record));
  const args = [
    "scripts/quality-workbench.mjs",
    "--source",
    fixture.source,
    "--prepared",
    fixture.prepared,
    "--head",
    fixture.head,
    "--receipt",
    fixture.receipt,
  ];
  const result = spawnSync(
    process.execPath,
    [...args, "--manage-source", fixture.manage.path, "--manage-head", fixture.manage.head],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(fixture.receipt, JSON.stringify({ ...record, manage: fixture.manage }));
  const missing = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
});

test("AQKC copied Skills reject changed frozen sources, unknown outputs, staging and redirects", async (t) => {
  const fixture = copiedSkillFixture(t);
  const output = join(fixture.prepared, fixture.output),
    original = join(fixture.manage.path, fixture.resource);
  const bytes = readFileSync(original);
  for (const file of [output, original]) {
    writeFileSync(file, "changed resource\n");
    await assert.rejects(
      readPreparedWorkbench(fixture),
      /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/,
    );
    writeFileSync(file, bytes);
  }
  writeFileSync(original, "changed source and copy\n");
  writeFileSync(output, "changed source and copy\n");
  await assert.rejects(readPreparedWorkbench(fixture), /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
  writeFileSync(original, bytes);
  writeFileSync(output, bytes);
  for (const file of ["lib/unexpected.js", "lib/business/inventory-aqkc/skills/unknown.md"]) {
    writeFileSync(join(fixture.prepared, file), bytes);
    await assert.rejects(
      readPreparedWorkbench(fixture),
      /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/,
    );
    rmSync(join(fixture.prepared, file));
  }
  const external = join(fixture.source, "..", "external-skill.md");
  writeFileSync(external, bytes);
  for (const file of [output, original]) {
    rmSync(file);
    symlinkSync(external, file);
    await assert.rejects(
      readPreparedWorkbench(fixture),
      /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/,
    );
    rmSync(file);
    writeFileSync(file, bytes);
  }
  const parent = join(fixture.prepared, fixture.output, "..");
  rmSync(parent, { recursive: true });
  symlinkSync(join(fixture.manage.path, fixture.resource, ".."), parent, "dir");
  await assert.rejects(readPreparedWorkbench(fixture), /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
  rmSync(parent);
  mkdirSync(parent);
  writeFileSync(output, bytes);
  fixture.git("-C", fixture.prepared, "add", fixture.output);
  await assert.rejects(readPreparedWorkbench(fixture), /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
});

test("copied Skills retain expected Manage head and receipt byte admission", async (t) => {
  const fixture = copiedSkillFixture(t);
  await assert.rejects(
    readPreparedWorkbench({ ...fixture, manage: { ...fixture.manage, head: "f".repeat(40) } }),
    /QUALITY_WORKBENCH_MANAGE_SOURCE_MISMATCH/,
  );
  const record = await readPreparedWorkbench(fixture);
  writeFileSync(fixture.receipt, JSON.stringify(record));
  writeFileSync(join(fixture.prepared, fixture.output), "changed after preparation\n");
  await assert.rejects(
    verifyPreparedWorkbench(fixture),
    /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/,
  );
  copyFileSync(join(fixture.manage.path, fixture.resource), join(fixture.prepared, fixture.output));
  writeFileSync(
    fixture.receipt,
    JSON.stringify({ ...record, files: { ...record.files, [fixture.output]: "0".repeat(64) } }),
  );
  await assert.rejects(verifyPreparedWorkbench(fixture), /QUALITY_WORKBENCH_ASSET_MISMATCH/);
});

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

test("new build declarations are frozen while new authored or staged files remain forbidden", async (t) => {
  const fixture = preparedFixture(t);
  const declaration = join(fixture.prepared, "lib/types/page-session-core.d.ts");
  writeFileSync(declaration, "export declare class PageSessionCore {}\n");
  const record = await readPreparedWorkbench(fixture);
  writeFileSync(fixture.receipt, JSON.stringify(record));
  await verifyPreparedWorkbench(fixture);
  writeFileSync(declaration, "changed output\n");
  await assert.rejects(verifyPreparedWorkbench(fixture), /QUALITY_WORKBENCH_ASSET_MISMATCH/);
  writeFileSync(join(fixture.prepared, "src/new.ts"), "authored source\n");
  await assert.rejects(readPreparedWorkbench(fixture), /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
  rmSync(join(fixture.prepared, "src/new.ts"));
  fixture.git("-C", fixture.prepared, "add", "lib/types/page-session-core.d.ts");
  await assert.rejects(readPreparedWorkbench(fixture), /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
});

test("public verifier refuses a prior receipt for a declaration symlink and its changed external target", async (t) => {
  const fixture = preparedFixture(t);
  const file = "lib/types/page-session-core.d.ts";
  const declaration = join(fixture.prepared, file);
  const target = join(fixture.source, "..", "external.d.ts");
  writeFileSync(declaration, "export declare class PageSessionCore {}\n");
  const record = await readPreparedWorkbench(fixture);
  rmSync(declaration);
  writeFileSync(target, "export declare class External {}\n");
  symlinkSync(target, declaration);
  // Reproduce the receipt the old reader could issue for this symlink.
  record.files[file] = "link:" + realpathSync(target);
  writeFileSync(fixture.receipt, JSON.stringify(record));
  const verify = () =>
    spawnSync(
      process.execPath,
      [
        "scripts/quality-workbench.mjs",
        "--source",
        fixture.source,
        "--prepared",
        fixture.prepared,
        "--head",
        fixture.head,
        "--receipt",
        fixture.receipt,
      ],
      { encoding: "utf8" },
    );
  for (const text of ["original external bytes\n", "changed external bytes\n"]) {
    writeFileSync(target, text);
    const result = verify();
    assert.equal(result.status, 1, "a symlink path cannot stand in for frozen declaration bytes");
    assert.match(result.stderr, /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
  }
  await assert.rejects(readPreparedWorkbench(fixture), /QUALITY_WORKBENCH_PREPARED_SOURCE_CHANGED/);
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
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
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

function authorityFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "gea-workbench-authority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workbench = join(root, "source/dsh-agent-workbench"),
    gea = join(root, "candidate/dsh-gea-plugin"),
    authority = join(root, "source/dsh-gea-plugin"),
    registry = "scripts/supported-cores.json";
  mkdirSync(workbench, { recursive: true });
  mkdirSync(join(gea, "scripts"), { recursive: true });
  writeFileSync(join(gea, registry), '{"source":"registered GEA candidate"}');
  return { workbench, gea, authority, registry };
}

test("cold Workbench source layout resolves its registry to the actual admitted GEA candidate file", async (t) => {
  const fixture = authorityFixture(t);
  await prepareWorkbenchGeaAuthority(fixture);
  assert.equal(lstatSync(fixture.authority).isSymbolicLink(), true);
  assert.equal(
    realpathSync(join(fixture.authority, fixture.registry)),
    realpathSync(join(fixture.gea, fixture.registry)),
  );
  writeFileSync(join(fixture.gea, fixture.registry), '{"updated":"same authority"}');
  assert.equal(
    readFileSync(join(fixture.authority, fixture.registry), "utf8"),
    '{"updated":"same authority"}',
  );
});

test("a correct existing GEA sibling link or actual registered directory is preserved", async (t) => {
  const fixture = authorityFixture(t);
  symlinkSync(fixture.gea, fixture.authority, "dir");
  const before = lstatSync(fixture.authority).ino;
  await prepareWorkbenchGeaAuthority(fixture);
  assert.equal(lstatSync(fixture.authority).ino, before);
  rmSync(fixture.authority);
  mkdirSync(join(fixture.authority, "scripts"), { recursive: true });
  writeFileSync(join(fixture.authority, fixture.registry), "{}");
  const directoryBefore = lstatSync(fixture.authority).ino;
  await prepareWorkbenchGeaAuthority({ ...fixture, gea: fixture.authority });
  assert.equal(lstatSync(fixture.authority).isDirectory(), true);
  assert.equal(lstatSync(fixture.authority).ino, directoryBefore);
});

test("a wrong existing GEA sibling directory or link is rejected without replacement", async (t) => {
  const fixture = authorityFixture(t);
  mkdirSync(fixture.authority);
  const before = lstatSync(fixture.authority).ino;
  await assert.rejects(
    prepareWorkbenchGeaAuthority(fixture),
    /QUALITY_WORKBENCH_GEA_AUTHORITY_MISMATCH/,
  );
  assert.equal(lstatSync(fixture.authority).isDirectory(), true);
  assert.equal(lstatSync(fixture.authority).ino, before);
  rmSync(fixture.authority, { recursive: true });
  symlinkSync(fixture.workbench, fixture.authority, "dir");
  await assert.rejects(
    prepareWorkbenchGeaAuthority(fixture),
    /QUALITY_WORKBENCH_GEA_AUTHORITY_MISMATCH/,
  );
  assert.equal(realpathSync(fixture.authority), realpathSync(fixture.workbench));
});

test("a real prepared worktree asset receipt admits the same five-source caller without Git metadata", async (t) => {
  const fixture = preparedFixture(t, true);
  assert.equal(lstatSync(join(fixture.prepared, ".git")).isFile(), true);
  mkdirSync(join(fixture.prepared, "node_modules"));
  writeFileSync(join(fixture.prepared, "node_modules/cache"), "writable dependency cache");
  const record = await readPreparedWorkbench(fixture);
  writeFileSync(fixture.receipt, JSON.stringify(record));
  const records = [
    {
      repo: sourcePlugins[0].repo,
      source: fixture.source,
      commit: fixture.head,
      assets: fixture.prepared,
      files: record.files,
    },
  ];
  for (const plugin of sourcePlugins.slice(1)) {
    const source = join(fixture.source, "..", plugin.repo);
    mkdirSync(join(source, "lib"), { recursive: true });
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({
        name: plugin.name,
        version: "1.0.0",
        exports: { "./client": "lib/client.js" },
      }),
    );
    for (const file of ["lib/host.js", "lib/client.js", "cordis.patch.yml", ...plugin.digests]) {
      mkdirSync(join(source, file, ".."), { recursive: true });
      writeFileSync(join(source, file), "fixed source input\n");
    }
    fixture.git("-C", source, "init", "-q");
    fixture.git("-C", source, "add", ".");
    fixture.git(
      "-C",
      source,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "fixed peer",
    );
    records.push({
      repo: plugin.repo,
      source,
      commit: fixture.git("-C", source, "rev-parse", "HEAD"),
    });
  }
  await resolveSourceInputs(records, { requireEntries: true });
  const assets = join(fixture.source, "..", "workbench-assets");
  const frozen = await prepareWorkbenchAssets({ ...fixture, assets });
  records[0].assets = frozen.assets;
  assert.deepEqual(frozen.files, record.files);
  assert.equal(existsSync(join(assets, ".git")), false);
  assert.equal(existsSync(join(assets, "node_modules")), false);
  assert.equal(realpathSync(fixture.source) === realpathSync(fixture.prepared), false);
  await resolveSourceInputs(records, { requireEntries: true });
  writeFileSync(join(assets, "lib/client.js"), "corrupted asset output\n");
  await assert.rejects(
    resolveSourceInputs(records, { requireEntries: true }),
    /SOURCE_ASSET_DIGEST_MISMATCH: dsh-agent-workbench/,
  );
  writeFileSync(join(fixture.prepared, "lib/client.js"), "changed prepared output\n");
  const refused = join(fixture.source, "..", "refused-assets");
  await assert.rejects(
    prepareWorkbenchAssets({ ...fixture, assets: refused }),
    /QUALITY_WORKBENCH_ASSET_MISMATCH/,
  );
  assert.equal(
    existsSync(refused),
    false,
    "changed prepared bytes are refused before snapshot creation",
  );
});
