import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  dependencyDigests,
  readSourceCombination,
  resourceDigests,
} from "../scripts/source-combination-integrity.mjs";
import { createReadScope } from "../scripts/delivery-input-scope.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function ownedDirectory(t, name) {
  // A caller-provided directory retains this run's fixtures for review.
  const parent = process.env.GEA_SOURCE_INTEGRITY_TMP ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const directory = await realpath(await mkdtemp(join(parent, name + "-")));
  if (!process.env.GEA_SOURCE_INTEGRITY_TMP)
    t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t) {
  const root = await ownedDirectory(t, "source-integrity");
  const id = randomUUID();
  const directory = join(root, "source-combinations", id);
  const a = join(root, "external-a");
  const b = join(root, "external-b");
  await Promise.all([directory, a, b].map((path) => mkdir(path, { recursive: true })));
  const files = {};
  const externalFiles = {};
  const resources = [];
  const dependencies = [];
  async function put(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  async function resource(relative, bytes) {
    const path = join(directory, relative);
    await put(path, bytes);
    files[relative] = hash(bytes);
    resources.push(path);
  }
  async function dependency(path, bytes) {
    await put(path, bytes);
    externalFiles[path] = hash(bytes);
    dependencies.push(path);
  }
  // Tail files must remain covered when a reader processes several batches.
  for (let index = 0; index < 73; index++) {
    const name = String(index).padStart(3, "0");
    await resource(`pages/${index % 3}/asset-${name}.json`, JSON.stringify({ index }));
    await dependency(
      join(a, `group-${index % 4}`, `module-${name}.js`),
      `export default ${index};`,
    );
  }
  await dependency(join(b, "nested", "entry.js"), "export const nested = true;");
  const linkedFile = join(root, "linked-file.js");
  await dependency(linkedFile, "export const linked = true;");
  const links = [
    [join(a, "transitive"), b],
    [join(a, "entry-link.js"), linkedFile],
    [join(b, "cycle"), a],
  ];
  for (const [path, target] of links) {
    await symlink(target, path);
    externalFiles[path] = "link:" + target;
  }
  const resourceLink = join(directory, "dependency-link");
  await symlink(a, resourceLink);
  files["dependency-link"] = "link:" + a;
  const manifest = { name: "@fixture/resource", version: "1.0.0" };
  await resource("node_modules/@fixture/resource/package.json", JSON.stringify(manifest));
  await resource(
    "company-plugins.json",
    JSON.stringify({ [manifest.name]: { version: manifest.version } }),
  );
  const lock = join(root, "pnpm-lock.yaml");
  const lockBytes = "lockfileVersion: '9.0'\nfixture: original\n";
  await put(lock, lockBytes);
  externalFiles[lock] = hash(lockBytes);
  const composition = { id, dependencies: { [manifest.name]: manifest.version }, bundles: [] };
  await put(
    join(directory, "combination.json"),
    JSON.stringify({
      composition,
      files,
      externalRoots: [a, a, b],
      externalFiles,
      externalLockFiles: [lock],
    }),
  );
  return {
    root,
    id,
    directory,
    a,
    b,
    files,
    externalFiles,
    resources,
    dependencies,
    resourceLink,
    linkedFile,
    lock,
    composition,
    run: (options) => readSourceCombination(root, id, undefined, options),
  };
}

test("complete resource and transitive dependency maps include tail files, repeated roots and cyclic links", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await resourceDigests(f.directory), f.files);
  const { [f.lock]: _lock, ...expectedDependencies } = f.externalFiles;
  assert.deepEqual(await dependencyDigests([f.a, f.a, f.b]), expectedDependencies);
  assert.deepEqual(await f.run(), f.composition);
});

test("complete frozen maps accept reordered keys and reject same-count key substitution", async (t) => {
  const f = await fixture(t);
  const recordPath = join(f.directory, "combination.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  for (const key of ["files", "externalFiles"])
    record[key] = Object.fromEntries(Object.entries(record[key]).reverse());
  await writeFile(recordPath, JSON.stringify(record));
  assert.deepEqual(await f.run(), f.composition);
  for (const kind of ["resource", "dependency"]) {
    const changed = structuredClone(record);
    const map = changed[kind === "resource" ? "files" : "externalFiles"];
    const original = kind === "resource" ? "pages/0/asset-069.json" : f.dependencies[69];
    const replacement = kind === "resource" ? "unrecorded.json" : join(f.a, "unrecorded.js");
    const expected = map[original];
    assert.equal(typeof expected, "string");
    delete map[original];
    map[replacement] = expected;
    await writeFile(recordPath, JSON.stringify(changed));
    await assert.rejects(f.run(), (error) => {
      assert.equal(
        error.message,
        kind === "resource"
          ? "SOURCE_COMBINATION_DIGEST_MISMATCH"
          : "SOURCE_DEPENDENCY_DIGEST_MISMATCH",
      );
      assert.equal(error.mismatches.length, 2);
      const removed = error.mismatches.find((entry) => entry.path === original);
      const added = error.mismatches.find((entry) => entry.path === replacement);
      assert.equal(removed.actual, expected);
      assert.equal(removed.expected, null);
      assert.equal(added.actual, null);
      assert.equal(added.expected, expected);
      if (kind === "dependency") {
        assert.equal(removed.kind, "external-dependency");
        assert.equal(added.kind, "external-dependency");
      }
      return true;
    });
  }
});

test("full combination verification uses the safe read scope for resources, links, dependencies and locks", async (t) => {
  const f = await fixture(t);
  const readScope = await createReadScope(f.root);
  assert.deepEqual(await resourceDigests(f.directory, "", readScope), f.files);
  const { [f.lock]: _lock, ...expectedDependencies } = f.externalFiles;
  assert.deepEqual(await dependencyDigests([f.a, f.b], readScope), expectedDependencies);
  assert.deepEqual(await f.run({ readScope }), f.composition);
});

for (const kind of ["resource", "dependency"]) {
  for (const change of ["added", "changed", "missing"]) {
    test(`${kind} ${change} after freezing rejects the actual byte or inventory drift`, async (t) => {
      const f = await fixture(t);
      assert.deepEqual(await f.run(), f.composition);
      const paths = kind === "resource" ? f.resources : f.dependencies;
      const tail = paths[69];
      let path = tail;
      if (change === "added") {
        path = join(kind === "resource" ? f.directory : f.a, "unfrozen-entry.js");
        await writeFile(path, "added after freeze");
      } else if (change === "changed") await writeFile(path, "changed after freeze");
      else await unlink(path);
      const mismatchPath = kind === "resource" ? path.slice(f.directory.length + 1) : path;
      const frozenHash = kind === "resource" ? f.files[mismatchPath] : f.externalFiles[path];
      const actual =
        change === "missing"
          ? null
          : hash(change === "added" ? "added after freeze" : "changed after freeze");
      await assert.rejects(f.run(), (error) => {
        assert.equal(
          error.message,
          kind === "resource"
            ? "SOURCE_COMBINATION_DIGEST_MISMATCH"
            : "SOURCE_DEPENDENCY_DIGEST_MISMATCH",
        );
        const entry = error.mismatches.find((entry) => entry.path === mismatchPath);
        assert.ok(entry, JSON.stringify(error.mismatches));
        assert.equal(entry.actual, actual);
        assert.equal(entry.expected, frozenHash ?? null);
        if (kind === "dependency") assert.equal(entry.kind, "external-dependency");
        return true;
      });
    });
  }
}

test("linked dependency bytes are verified even when the target is outside the declared dependency roots", async (t) => {
  const f = await fixture(t);
  await writeFile(f.linkedFile, "changed linked target");
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.message, "SOURCE_DEPENDENCY_DIGEST_MISMATCH");
    assert.ok(
      error.mismatches.some(
        (entry) => entry.path === f.linkedFile && entry.actual === hash("changed linked target"),
      ),
    );
    return true;
  });
});

test("retargeted resource and transitive dependency links reject the frozen resolved location", async (t) => {
  for (const kind of ["resource", "dependency"]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      const link = kind === "resource" ? f.resourceLink : join(f.a, "transitive");
      const target = kind === "resource" ? f.b : f.a;
      await unlink(link);
      await symlink(target, link);
      await assert.rejects(f.run(), (error) => {
        assert.equal(
          error.message,
          kind === "resource"
            ? "SOURCE_COMBINATION_DIGEST_MISMATCH"
            : "SOURCE_DEPENDENCY_DIGEST_MISMATCH",
        );
        const path = kind === "resource" ? "dependency-link" : link;
        assert.ok(
          error.mismatches.some(
            (entry) => entry.path === path && entry.actual === "link:" + target,
          ),
        );
        return true;
      });
    });
  }
});

test("external lock changes reject with lock provenance and missing locks preserve ENOENT", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.lock);
  await writeFile(f.lock, "changed lock bytes");
  await assert.rejects(f.run(), (error) => {
    assert.equal(error.message, "SOURCE_DEPENDENCY_DIGEST_MISMATCH");
    assert.deepEqual(error.mismatches, [
      { path: f.lock, actual: hash("changed lock bytes"), expected: hash(original), kind: "lock" },
    ]);
    return true;
  });
  await unlink(f.lock);
  await assert.rejects(f.run(), { code: "ENOENT" });
});

test("safe read scope refuses an escaping resource link and a protected transitive directory", async (t) => {
  const f = await fixture(t);
  const outside = await ownedDirectory(t, "source-integrity-outside");
  await unlink(f.resourceLink);
  await symlink(outside, f.resourceLink);
  await assert.rejects(
    f.run({ readScope: await createReadScope(f.root) }),
    /INTEGRITY_INPUT_OUTSIDE_ROOT/,
  );
  await unlink(f.resourceLink);
  // The resource link is removed from this fixture so the refusal comes from
  // the external graph rather than its resource inventory.
  delete f.files["dependency-link"];
  const recordPath = join(f.directory, "combination.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  record.files = f.files;
  await writeFile(recordPath, JSON.stringify(record));
  await assert.rejects(
    f.run({ readScope: await createReadScope(f.root, [{ path: f.b }]) }),
    /INTEGRITY_PERSISTENT_OVERLAP/,
  );
});

test("read-scope byte denial propagates unchanged instead of accepting a partial dependency graph", async (t) => {
  const f = await fixture(t);
  const safe = await createReadScope(f.root);
  const denied = Error("fixture dependency read denied");
  const readScope = {
    ...safe,
    async read(path, limit) {
      if (path === f.dependencies[69]) throw denied;
      return safe.read(path, limit);
    },
  };
  await assert.rejects(f.run({ readScope }), (error) => error === denied);
});

test("public combination verification reports nested preparation costs without changing its result", async (t) => {
  const f = await fixture(t);
  const { measureSourceUpdate } = await import("./fixtures/source-update-timing.mjs");
  const records = [];
  const context = { name: t.name, diagnostic: (text) => records.push(JSON.parse(text)) };
  assert.deepEqual(
    await measureSourceUpdate(context, "baseline", "profile-start", () => f.run()),
    f.composition,
  );
  const phases = records.filter((row) => row.event === "source-preparation-phase-completed");
  const verification = phases.find((row) => row.step === "read-combination");
  assert.ok(verification);
  for (const step of [
    "resource-traversal",
    "resource-read-hash",
    "dependency-traversal",
    "dependency-read-hash",
  ]) {
    const row = phases.find((row) => row.step === step);
    assert.ok(row, step);
    assert.equal(row.parentId, verification.id);
    assert.equal(row.observationId, verification.observationId);
    assert.equal(row.scopeStep, "profile-start");
    assert.equal(row.phase, "baseline");
    assert.equal(row.status, "passed");
    assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0);
    assert.equal(row.fileCount, 75);
  }
  assert.equal(phases.find((row) => row.step === "resource-traversal").linkCount, 1);
  assert.equal(phases.find((row) => row.step === "dependency-traversal").linkCount, 3);
});

test("preparation observers retain failed phases and cannot mask public entry failures", async (t) => {
  const f = await fixture(t);
  const { measureSourceUpdate } = await import("./fixtures/source-update-timing.mjs");
  const { prepareSourcePlugins, mergeSourceComponents } =
    await import("../scripts/source-profile.mjs");
  const records = [];
  const context = {
    name: t.name,
    diagnostic(text) {
      records.push(JSON.parse(text));
      throw Error("diagnostic unavailable");
    },
  };
  await assert.rejects(
    measureSourceUpdate(context, "baseline", "profile-start", () => prepareSourcePlugins()),
    /EXPLICIT_SOURCE_INPUTS_REQUIRED/,
  );
  await assert.rejects(
    measureSourceUpdate(context, "gea-updated", "channel-prepare", () =>
      mergeSourceComponents(f.root, randomUUID(), {}, undefined),
    ),
    { code: "ENOENT" },
  );
  const original = Error("read denied");
  const safe = await createReadScope(f.root);
  const readScope = {
    ...safe,
    async read(path, limit) {
      if (path === f.dependencies[69]) throw original;
      return safe.read(path, limit);
    },
  };
  await assert.rejects(
    measureSourceUpdate(context, "gea-updated", "apply-update", () => f.run({ readScope })),
    (error) => error === original,
  );
  for (const step of ["prepare", "merge", "read-combination", "dependency-read-hash"]) {
    const row = records.find(
      (row) => row.event === "source-preparation-phase-completed" && row.step === step,
    );
    assert.ok(row, step);
    assert.equal(row.status, "failed");
    assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0);
  }
  const { withSourcePhaseObserver } = await import("../scripts/source-combination-integrity.mjs");
  const observer = () => {
    throw Error("observer unavailable");
  };
  assert.deepEqual(await withSourcePhaseObserver(observer, () => f.run()), f.composition);
  await assert.rejects(
    withSourcePhaseObserver(observer, () => f.run({ readScope })),
    (error) => error === original,
  );
});

test("an asynchronously failing observer leaves complete public verification successful", async (t) => {
  const f = await fixture(t);
  const { withSourcePhaseObserver } = await import("../scripts/source-combination-integrity.mjs");
  assert.deepEqual(
    await withSourcePhaseObserver(
      async () => {
        throw Error("async observer unavailable");
      },
      () => f.run(),
    ),
    f.composition,
  );
  await new Promise((done) => setImmediate(done));
});
