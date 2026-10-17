import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import * as candidate from "../scripts/source-combination-integrity.mjs";
import { createReadScope } from "../scripts/delivery-input-scope.mjs";
import { spawnSync } from "node:child_process";
const digest = (b) => createHash("sha256").update(b).digest("hex");
const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "callback-reader-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test("the update baseline consumes its verified manifest and component metadata without rereading them", async (t) => {
  const runtime = await fixture(t),
    id = randomUUID(),
    directory = join(runtime, "source-combinations", id),
    name = "fixture-plugin";
  await fs.mkdir(join(directory, "node_modules", name), { recursive: true });
  await fs.writeFile(
    join(directory, "node_modules", name, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  await fs.writeFile(
    join(directory, "company-plugins.json"),
    JSON.stringify({
      [name]: {
        version: "1.0.0",
        origin: "https://fixture.invalid/source",
        commit: "a".repeat(40),
      },
    }),
  );
  const record = {
    composition: { id, dependencies: { [name]: "1.0.0" } },
    files: await candidate.resourceDigests(directory),
    externalRoots: [],
    externalFiles: {},
    externalLockFiles: [],
  };
  await fs.writeFile(join(directory, "combination.json"), JSON.stringify(record));
  const manifestSha256 = digest(await fs.readFile(join(directory, "combination.json")));
  await fs.writeFile(
    join(runtime, "source-selection.json"),
    JSON.stringify({ id, manifestSha256 }),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const reads={};
for(const target of [fs,fs.promises]){
 const read=target.readFile;
 target.readFile=function(file,...args){reads[file]=(reads[file]??0)+1;return read.call(this,file,...args);};
}
syncBuiltinESMExports();
const {readSourceUpdateBaseline}=await import(${JSON.stringify(new URL("../scripts/source-update.mjs", import.meta.url).href)});
const baseline=await readSourceUpdateBaseline(${JSON.stringify(runtime)});
console.log(JSON.stringify({baseline,reads}));
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const { baseline, reads } = JSON.parse(result.stdout);
  assert.equal(baseline.id, id);
  assert.equal(baseline.manifestSha256, manifestSha256);
  assert.equal(baseline.components[name].version, "1.0.0");
  assert.equal(reads[join(directory, "combination.json")], 1);
  assert.equal(reads[join(directory, "company-plugins.json")], 2);
});
test("public digest preserves full bytes and supported path/FileHandle inputs", async (t) => {
  const root = await fixture(t),
    file = join(root, "a");
  await fs.writeFile(file, "abc");
  for (const path of [file, Buffer.from(file), pathToFileURL(file)])
    assert.equal(await candidate.fileDigest(path), abc);
  const handle = await fs.open(file, "r");
  try {
    assert.equal(await candidate.fileDigest(handle), abc);
  } finally {
    await handle.close();
  }
  await assert.rejects(candidate.fileDigest(12345), { code: "ERR_INVALID_ARG_TYPE" });
  const bytes = Buffer.from([0, 255, 13, 10, 0, 128]);
  await fs.writeFile(file, bytes);
  assert.equal(await candidate.fileDigest(file), digest(bytes));
});
test("public complete resource/dependency maps include links and new extensions, reject real drift", async (t) => {
  const root = await fixture(t),
    runtime = join(root, "runtime"),
    id = randomUUID(),
    dir = join(runtime, "source-combinations", id),
    deps = join(root, "deps");
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(deps);
  await fs.writeFile(join(dir, "new.unknown-extension"), "abc");
  await fs.writeFile(join(deps, "body.bin"), Buffer.from([0, 255, 0]));
  await fs.writeFile(join(deps, ".hidden"), "hidden");
  await fs.symlink(join(deps, "body.bin"), join(deps, "linked"));
  await fs.symlink(deps, join(dir, "dependency-link"));
  const files = { "dependency-link": "link:" + deps, "new.unknown-extension": abc },
    externalFiles = {
      [join(deps, "body.bin")]: digest(Buffer.from([0, 255, 0])),
      [join(deps, "linked")]: "link:" + join(deps, "body.bin"),
    };
  assert.deepEqual(await candidate.resourceDigests(dir), files);
  assert.deepEqual(await candidate.dependencyDigests([deps]), externalFiles);
  const composition = { id, dependencies: {} },
    record = { composition, files, externalFiles, externalRoots: [deps], externalLockFiles: [] };
  await fs.writeFile(join(dir, "combination.json"), JSON.stringify(record));
  assert.deepEqual(await candidate.readSourceCombination(runtime, id), composition);
  await fs.writeFile(join(deps, "added.newext"), "added");
  await assert.rejects(
    candidate.readSourceCombination(runtime, id),
    /SOURCE_DEPENDENCY_DIGEST_MISMATCH/,
  );
  await fs.rm(join(deps, "added.newext"));
  await fs.unlink(join(deps, "linked"));
  await fs.symlink(join(dir, "new.unknown-extension"), join(deps, "linked"));
  await assert.rejects(
    candidate.readSourceCombination(runtime, id),
    /SOURCE_DEPENDENCY_DIGEST_MISMATCH/,
  );
});
test("native missing and permission failures retain code, errno, syscall and path", async (t) => {
  const root = await fixture(t),
    missing = join(root, "missing"),
    denied = join(root, "denied");
  await fs.writeFile(denied, "abc");
  await fs.chmod(denied, 0);
  t.after(() => fs.chmod(denied, 0o600).catch(() => {}));
  for (const file of [missing, denied]) {
    const errors = [];
    for (const read of [fs.readFile, candidate.fileDigest])
      try {
        await read(file);
        assert.fail("expected real filesystem rejection");
      } catch (e) {
        errors.push({ code: e.code, errno: e.errno, syscall: e.syscall, path: e.path });
      }
    assert.deepEqual(errors[1], errors[0]);
    assert.equal(errors[0].code, file === missing ? "ENOENT" : "EACCES");
  }
});
test("real readScope keeps containment, protected paths, hardlinks, serial reads and cancellation rejection", async (t) => {
  const root = await fixture(t),
    inside = join(root, "inside"),
    outside = await fixture(t);
  await fs.mkdir(inside);
  const file = join(inside, "a");
  await fs.writeFile(file, "abc");
  await fs.writeFile(join(outside, "a"), "abc");
  await fs.writeFile(join(inside, "credentials.json"), "abc");
  const scope = await createReadScope(inside);
  assert.equal(await candidate.fileDigest(file, scope), abc);
  await assert.rejects(
    candidate.fileDigest(join(outside, "a"), scope),
    /INTEGRITY_INPUT_OUTSIDE_ROOT/,
  );
  await assert.rejects(
    candidate.fileDigest(join(inside, "credentials.json"), scope),
    /INTEGRITY_SOURCE_SCOPE_UNSUPPORTED/,
  );
  const protectedScope = await createReadScope(inside, [{ path: "a" }]);
  await assert.rejects(candidate.fileDigest(file, protectedScope), /INTEGRITY_PERSISTENT_OVERLAP/);
  await fs.link(file, join(inside, "hardlink"));
  await assert.rejects(candidate.fileDigest(file, scope), /INTEGRITY_MULTILINK_UNVERIFIABLE/);
  await fs.unlink(join(inside, "hardlink"));
  await fs.rm(join(inside, "credentials.json"));
  await fs.writeFile(join(inside, "b"), "abc");
  let active = 0,
    peak = 0;
  const observed = {
    ...scope,
    async read(...args) {
      active++;
      peak = Math.max(peak, active);
      try {
        return await scope.read(...args);
      } finally {
        active--;
      }
    },
  };
  await candidate.dependencyDigests([inside], observed);
  assert.equal(peak, 1);
  assert.equal(active, 0);
  const controller = new AbortController(),
    reason = Error("reader-scope-cancel");
  controller.abort(reason);
  const canceled = {
    ...scope,
    async read(...args) {
      controller.signal.throwIfAborted();
      return scope.read(...args);
    },
  };
  await assert.rejects(candidate.fileDigest(file, canceled), (e) => e === reason);
});
