import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  acquireBuild,
  readBuildAdmissions,
  withBuildAdmission,
  buildPolicy,
} from "./build-admission.mjs";

function fixture(t, bytes = 100 * 1024 ** 3) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "build-admission-test-"));
  const a = join(root, "a"),
    b = join(root, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  t.mock.method(os, "tmpdir", () => root);
  t.mock.method(fs, "statfsSync", () => ({ bavail: bytes, bsize: 1 }));
  t.after(() => {
    delete process.env.DSH_BUILD_ADMISSION;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, a, b };
}
for (const [operation, requiredGiB] of [
  ["build", 3],
  ["package", 3],
  ["watch", 3],
  ["prepare", 5],
  ["desktop", 28],
  ["sdk", 28],
]) {
  const requiredBytes = requiredGiB * 1024 ** 3;
  test(`${operation} accepts its own space budget at ${requiredGiB} GiB`, (t) => {
    const { a } = fixture(t, requiredBytes);
    const release = acquireBuild({ operation, cwd: a });
    assert.equal(readBuildAdmissions(a).length, 1);
    release();
    assert.deepEqual(readBuildAdmissions(a), []);
  });
  test(`${operation} refuses below its own space budget`, (t) => {
    const { a } = fixture(t, requiredBytes - 1);
    assert.throws(
      () => acquireBuild({ operation, cwd: a }),
      (error) =>
        error.message === "BUILD_CAPACITY_INSUFFICIENT" && error.requiredBytes === requiredBytes,
    );
    assert.deepEqual(readBuildAdmissions(a), []);
  });
}
test("capacity refusal occurs before the output or command is created", async (t) => {
  const { a } = fixture(t, buildPolicy.safetyBytes);
  const output = join(a, "not-created");
  let ran = false;
  await assert.rejects(
    withBuildAdmission({ operation: "prepare", cwd: a, output }, () => {
      ran = true;
    }),
    (error) =>
      error.message === "BUILD_CAPACITY_INSUFFICIENT" && error.requiredBytes > error.availableBytes,
  );
  assert.equal(ran, false);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(readBuildAdmissions(a), []);
});
test("another heavy writer is refused while a nested owner reuses its reservation", (t) => {
  const { a, b } = fixture(t);
  const release = acquireBuild({ operation: "prepare", cwd: a });
  acquireBuild({ operation: "build", cwd: a })();
  delete process.env.DSH_BUILD_ADMISSION;
  assert.throws(() => acquireBuild({ operation: "build", cwd: b }), /BUILD_VOLUME_BUSY/);
  release();
  assert.deepEqual(readBuildAdmissions(a), []);
});
test("watch reservations remain counted and overlapping checkouts refuse writes", (t) => {
  const { a, b } = fixture(
    t,
    buildPolicy.safetyBytes + buildPolicy.reserveBytes.watch + buildPolicy.reserveBytes.build - 1,
  );
  const release = acquireBuild({ operation: "watch", cwd: a });
  delete process.env.DSH_BUILD_ADMISSION;
  assert.throws(() => acquireBuild({ operation: "build", cwd: a }), /BUILD_OUTPUT_BUSY/);
  assert.throws(() => acquireBuild({ operation: "build", cwd: b }), /BUILD_CAPACITY_INSUFFICIENT/);
  assert.equal(readBuildAdmissions(a).length, 1);
  release();
});
test("failed work releases only its own lease and stale owners are retained for review", async (t) => {
  const { a, root } = fixture(t);
  await assert.rejects(
    withBuildAdmission({ operation: "build", cwd: a }, () => {
      throw Error("fixture-failure");
    }),
    /fixture-failure/,
  );
  assert.deepEqual(readBuildAdmissions(a), []);
  const dir = join(root, `dsh-build-admission-${process.getuid?.() ?? "user"}`);
  fs.writeFileSync(
    join(dir, "stale.json"),
    JSON.stringify({ pid: 2147483647, scopes: [a], reserveBytes: 1, operation: "build" }),
  );
  assert.throws(
    () => acquireBuild({ operation: "build", cwd: a }),
    /BUILD_ADMISSION_REQUIRES_REVIEW/,
  );
  assert.equal(fs.existsSync(join(dir, "stale.json")), true);
});
