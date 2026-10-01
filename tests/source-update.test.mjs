import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applySourceUpdate,
  readSourceUpdateBaseline,
} from "../scripts/source-update.mjs";
import { selectSourceCombination } from "../scripts/source-profile.mjs";
import {
  sourceUpdateFixture,
  core,
  releases,
  gea,
  workbench,
  manage,
} from "./fixtures/source-updates.mjs";
const options = { core, releases };

test("an old delayed candidate cannot overwrite a newer selected version", async (t) => {
  const f = await sourceUpdateFixture(t),
    old = await f.snapshot({ [gea]: { version: "1.1.0" } }),
    next = await f.snapshot({ [gea]: { version: "1.2.0" } });
  const oldProposal = await f.proposal(old, [gea]),
    nextProposal = await f.proposal(next, [gea]);
  const held = Promise.withResolvers(),
    reached = Promise.withResolvers();
  const late = applySourceUpdate(f.runtime, oldProposal, {
    ...options,
    io: {
      ...fs,
      readFile: async (file, ...args) => {
        if (file === fileURLToPath(oldProposal.releases[0].url)) {
          reached.resolve();
          await held.promise;
        }
        return fs.readFile(file, ...args);
      },
    },
  });
  await reached.promise;
  const installed = await applySourceUpdate(f.runtime, nextProposal, options);
  assert.equal(installed.phase, "succeeded");
  held.resolve();
  const rejected = await late;
  assert.equal(rejected.phase, "failed");
  assert.equal(rejected.failed[0].error, "STALE_SOURCE_UPDATE");
  const current = await readSourceUpdateBaseline(f.runtime, core);
  assert.equal(current.id, installed.target);
  assert.equal(current.components[gea].version, "1.2.0");
});

test("component updates merge into the latest list and keep unrelated changes", async (t) => {
  const f = await sourceUpdateFixture(t),
    a = await f.snapshot({ [gea]: { version: "1.1.0" } }),
    b = await f.snapshot({ [workbench]: { version: "1.1.0" } });
  const first = await f.proposal(a, [gea]),
    second = await f.proposal(b, [workbench]);
  assert.equal(
    (await applySourceUpdate(f.runtime, first, options)).phase,
    "succeeded",
  );
  const result = await applySourceUpdate(f.runtime, second, options);
  assert.equal(result.phase, "succeeded");
  const current = await readSourceUpdateBaseline(f.runtime, core);
  assert.equal(current.components[gea].version, "1.1.0");
  assert.equal(current.components[workbench].version, "1.1.0");
  assert.deepEqual(current.components[manage], f.baseline.components[manage]);
  const module = await import(
    pathToFileURL(
      join(
        f.runtime,
        "source-combinations",
        current.id,
        "node_modules",
        gea,
        "lib/host.js",
      ),
    )
  );
  assert.equal(module.default.version, "1.1.0");
  assert.equal(
    await fs.readFile(join(f.runtime, "workspace/user.txt"), "utf8"),
    "keep user data",
  );
});

for (const scenario of [
  "same-version",
  "bad-download",
  "incompatible",
  "origin",
  "baseline-digest",
  "baseline-core",
])
  test(`rejects ${scenario} without changing selection`, async (t) => {
    const f = await sourceUpdateFixture(t),
      candidate = await f.snapshot({
        [gea]: {
          version: scenario === "same-version" ? "1.0.0" : "1.1.0",
          label: "new artifact",
        },
      });
    const proposal = await f.proposal(candidate, [gea]);
    if (scenario === "bad-download")
      await fs.writeFile(
        fileURLToPath(proposal.releases[0].url),
        "corrupted download",
      );
    if (scenario === "incompatible")
      proposal.releases[0].compatible.core = ["b".repeat(40)];
    if (scenario === "baseline-digest")
      proposal.baseline.components[gea].sha256 = "b".repeat(64);
    if (scenario === "baseline-core") proposal.baseline.core = "b".repeat(40);
    if (scenario === "origin")
      proposal.releases[0].source.origin =
        "https://example.invalid/other-source.git";
    const result = await applySourceUpdate(f.runtime, proposal, options);
    assert.notEqual(result.phase, "succeeded");
    assert.equal(
      (await readSourceUpdateBaseline(f.runtime, core)).id,
      f.initial,
    );
    assert.ok(result.failed.length);
  });

test("a partial preparation failure reports prepared and failed components without activation", async (t) => {
  const f = await sourceUpdateFixture(t),
    candidate = await f.snapshot({
      [gea]: { version: "1.1.0" },
      [workbench]: { version: "1.1.0" },
    }),
    proposal = await f.proposal(candidate, [gea, workbench]);
  await fs.writeFile(
    fileURLToPath(proposal.releases[1].url),
    "bad second artifact",
  );
  const result = await applySourceUpdate(f.runtime, proposal, options);
  assert.equal(result.phase, "prepare-failed");
  assert.deepEqual(result.prepared, [gea]);
  assert.equal(result.failed[0].package, workbench);
  assert.equal(result.activation, "unchanged");
  assert.equal((await readSourceUpdateBaseline(f.runtime, core)).id, f.initial);
});

for (const failure of ["write", "rename-after-write", "readback"])
  test(`reports real ${failure} state and rechecks before recovery`, async (t) => {
    const f = await sourceUpdateFixture(t),
      candidate = await f.snapshot({ [gea]: { version: "1.1.0" } }),
      proposal = await f.proposal(candidate, [gea]);
    const io = {
      ...fs,
      writeFile: async (path, ...args) => {
        if (failure === "write" && path.includes("source-selection-"))
          throw Object.assign(Error("disk write failed"), { code: "EIO" });
        return fs.writeFile(path, ...args);
      },
      rename: async (from, to) => {
        await fs.rename(from, to);
        if (failure === "rename-after-write")
          throw Object.assign(Error("rename acknowledgement lost"), {
            code: "EIO",
          });
      },
      readFile: async (file, ...args) => {
        if (
          failure === "readback" &&
          file === join(f.runtime, "source-selection.json")
        )
          throw Object.assign(Error("selection unreadable"), { code: "EIO" });
        return fs.readFile(file, ...args);
      },
    };
    const result = await applySourceUpdate(f.runtime, proposal, {
      ...options,
      io,
    });
    assert.equal(
      result.phase,
      failure === "readback" ? "readback-failed" : "write-failed",
    );
    const actual = await readSourceUpdateBaseline(f.runtime, core);
    assert.equal(actual.id === f.initial, failure === "write");
    assert.equal(
      result.activation,
      failure === "write"
        ? "unchanged"
        : failure === "readback"
          ? "unknown"
          : "selected-unverified",
    );
    if (failure !== "write") {
      await assert.rejects(
        selectSourceCombination(f.runtime, f.initial, core, {
          expected: f.baseline,
        }),
        /STALE_SOURCE_RECOVERY/,
      );
      await selectSourceCombination(f.runtime, f.initial, core, {
        expected: actual,
      });
      assert.equal(
        (await readSourceUpdateBaseline(f.runtime, core)).id,
        f.initial,
      );
      assert.equal(
        await fs.readFile(join(f.runtime, "workspace/user.txt"), "utf8"),
        "keep user data",
      );
    }
    const saved = JSON.parse(
      await fs.readFile(
        join(f.runtime, `source-update-${result.id}.json`),
        "utf8",
      ),
    );
    assert.equal(saved.phase, result.phase);
  });

test("current package version must match the candidate metadata even when all hashes are valid", async (t) => {
  const f = await sourceUpdateFixture(t),
    id = await f.snapshot({ [gea]: { version: "1.1.0" } });
  const file = join(f.runtime, "source-combinations", id, "combination.json"),
    record = JSON.parse(await fs.readFile(file, "utf8"));
  record.composition.dependencies[gea] = "2.0.0";
  await fs.writeFile(file, JSON.stringify(record));
  const proposal = await f.proposal(id, [gea]);
  const result = await applySourceUpdate(f.runtime, proposal, options);
  assert.equal(result.phase, "prepare-failed");
  assert.equal(result.failed[0].error, "SOURCE_COMPONENT_VERSION_MISMATCH");
  assert.equal((await readSourceUpdateBaseline(f.runtime, core)).id, f.initial);
});

test("a stopped-profile lock cannot be bypassed while the Host owns it", async (t) => {
  const f = await sourceUpdateFixture(t),
    candidate = await f.snapshot({ [gea]: { version: "1.1.0" } }),
    proposal = await f.proposal(candidate, [gea]);
  await fs.writeFile(join(f.runtime, "source-profile.lock"), "running Host");
  const result = await applySourceUpdate(f.runtime, proposal, options);
  assert.notEqual(result.phase, "succeeded");
  assert.equal(
    await fs.readFile(join(f.runtime, "source-profile.lock"), "utf8"),
    "running Host",
  );
  assert.equal((await readSourceUpdateBaseline(f.runtime, core)).id, f.initial);
});

test("caller mutation while waiting for the lock cannot change the verified release or baseline", async (t) => {
  const f = await sourceUpdateFixture(t),
    id = await f.snapshot({ [gea]: { version: "1.1.0" } }),
    proposal = await f.proposal(id, [gea]);
  const original = structuredClone(proposal),
    reached = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const update = applySourceUpdate(f.runtime, proposal, {
    ...options,
    io: {
      ...fs,
      open: async (...args) => {
        reached.resolve();
        await resume.promise;
        return fs.open(...args);
      },
    },
  });
  await reached.promise;
  proposal.releases[0].version = "9.9.9";
  proposal.releases[0].sha256 = "b".repeat(64);
  proposal.baseline.core = "b".repeat(40);
  resume.resolve();
  const result = await update;
  assert.equal(result.phase, "succeeded");
  const current = await readSourceUpdateBaseline(f.runtime, core);
  assert.equal(current.components[gea].version, "1.1.0");
  assert.equal(current.history[gea + "@1.1.0"], original.releases[0].sha256);
  assert.equal(current.history[gea + "@9.9.9"], undefined);
});

test("a frozen source origin does not follow later Git remote changes", async (t) => {
  const f = await sourceUpdateFixture(t),
    before = await readSourceUpdateBaseline(f.runtime, core);
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", [
    "-C",
    join(f.runtime, "source"),
    "remote",
    "set-url",
    "source",
    "https://example.invalid/changed-origin.git",
  ]);
  assert.deepEqual(await readSourceUpdateBaseline(f.runtime, core), before);
});

test("a retained GEA compatibility restriction rejects an independent Workbench update", async (t) => {
  const f = await sourceUpdateFixture(t),
    a = await f.snapshot({ [gea]: { version: "1.1.0" } }),
    b = await f.snapshot({ [workbench]: { version: "1.1.0" } });
  const first = await f.proposal(a, [gea]),
    second = await f.proposal(b, [workbench]);
  first.releases[0].compatible.workbench = ["1.0.0"];
  const installed = await applySourceUpdate(f.runtime, first, options);
  assert.equal(installed.phase, "succeeded");
  const rejected = await applySourceUpdate(f.runtime, second, options);
  assert.equal(rejected.phase, "failed");
  assert.equal(rejected.failed[0].error, "SOURCE_RELEASE_INCOMPATIBLE");
  const current = await readSourceUpdateBaseline(f.runtime, core);
  assert.equal(current.id, installed.target);
  assert.equal(current.components[workbench].version, "1.0.0");
  assert.deepEqual(current.compatibility[gea].workbench, ["1.0.0"]);
});

test("an artifact's manifest cannot be changed behind its downloaded reference", async (t) => {
  const f = await sourceUpdateFixture(t),
    id = await f.snapshot({ [gea]: { version: "1.1.0" } }),
    proposal = await f.proposal(id, [gea]);
  const file = join(f.runtime, "source-combinations", id, "combination.json"),
    record = JSON.parse(await fs.readFile(file, "utf8"));
  record.compatibility[gea].workbench.push("9.9.9");
  await fs.writeFile(file, JSON.stringify(record));
  const result = await applySourceUpdate(f.runtime, proposal, options);
  assert.equal(result.phase, "prepare-failed");
  assert.equal(result.failed[0].error, "SOURCE_ARTIFACT_MANIFEST_MISMATCH");
  assert.equal((await readSourceUpdateBaseline(f.runtime, core)).id, f.initial);
});

test("channel compatibility cannot widen a candidate snapshot's declared range", async (t) => {
  const f = await sourceUpdateFixture(t),
    candidate = await f.snapshot({ [workbench]: { version: "1.1.0" } });
  const file = join(
      f.runtime,
      "source-combinations",
      candidate,
      "combination.json",
    ),
    record = JSON.parse(await fs.readFile(file, "utf8"));
  record.compatibility[workbench].workbench = ["1.0.0"];
  await fs.writeFile(file, JSON.stringify(record));
  const proposal = await f.proposal(candidate, [workbench]);
  proposal.releases[0].compatible.workbench = ["1.1.0"];
  const result = await applySourceUpdate(f.runtime, proposal, options);
  assert.equal(result.failed[0].error, "SOURCE_RELEASE_INCOMPATIBLE");
  assert.equal((await readSourceUpdateBaseline(f.runtime, core)).id, f.initial);
});

test("rewriting a candidate manifest and dependency while waiting for the lock cannot reauthorize changed bytes", async (t) => {
  const f = await sourceUpdateFixture(t),
    candidate = await f.snapshot({ [gea]: { version: "1.1.0" } });
  const directory = join(f.runtime, "source-combinations", candidate),
    file = join(directory, "combination.json"),
    record = JSON.parse(await fs.readFile(file, "utf8"));
  const external = join(f.runtime, "external"),
    dependency = join(external, "value.js");
  await fs.mkdir(external);
  await fs.writeFile(dependency, "original dependency");
  const link = join(
    directory,
    "node_modules",
    gea,
    "node_modules",
    "fixture-dependency",
  );
  await fs.symlink(external, link);
  const { createHash } = await import("node:crypto");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  record.files[`node_modules/${gea}/node_modules/fixture-dependency`] =
    "link:" + external;
  record.externalRoots.push(external);
  record.externalFiles[dependency] = hash("original dependency");
  await fs.writeFile(file, JSON.stringify(record));
  const proposal = await f.proposal(candidate, [gea]),
    reached = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const pending = applySourceUpdate(f.runtime, proposal, {
    ...options,
    io: {
      ...fs,
      open: async (...args) => {
        reached.resolve();
        await resume.promise;
        return fs.open(...args);
      },
    },
  });
  await reached.promise;
  await fs.writeFile(dependency, "changed dependency");
  record.externalFiles[dependency] = hash("changed dependency");
  await fs.writeFile(file, JSON.stringify(record));
  resume.resolve();
  const result = await pending;
  assert.equal(result.phase, "failed");
  assert.equal(result.failed[0].error, "SOURCE_ARTIFACT_MANIFEST_MISMATCH");
  assert.equal((await readSourceUpdateBaseline(f.runtime, core)).id, f.initial);
});

test("late deployment overlay changes cannot be rehashed into a newly authorized combination", async (t) => {
  const f = await sourceUpdateFixture(t),
    candidate = await f.snapshot({ [gea]: { version: "1.1.0" } }),
    proposal = await f.proposal(candidate, [gea]);
  const originalFile = join(
      f.runtime,
      "source-combinations",
      f.initial,
      "deployment.patch.json",
    ),
    original = await fs.readFile(originalFile);
  const { watch } = await import("node:fs");
  const changed = Promise.withResolvers();
  const watcher = watch(
    join(f.runtime, "source-combinations"),
    (event, filename) => {
      const name = String(filename);
      if (event !== "rename" || [f.initial, candidate].includes(name)) return;
      watcher.close();
      fs.writeFile(
        originalFile,
        JSON.stringify([
          { id: "unrequested-overlay-change", config: { altered: true } },
        ]),
      ).then(changed.resolve, changed.reject);
    },
  );
  t.after(() => watcher.close());
  const result = await applySourceUpdate(f.runtime, proposal, options);
  await changed.promise;
  assert.equal(result.phase, "failed");
  assert.match(result.failed[0].error, /SOURCE_INPUT_DIGEST_MISMATCH/);
  assert.equal(
    JSON.parse(
      await fs.readFile(join(f.runtime, "source-selection.json"), "utf8"),
    ).id,
    f.initial,
  );
  await fs.writeFile(originalFile, original);
  assert.equal((await readSourceUpdateBaseline(f.runtime, core)).id, f.initial);
});
