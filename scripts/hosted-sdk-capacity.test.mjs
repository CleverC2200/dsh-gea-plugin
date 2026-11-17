import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import child from "node:child_process";
import { join, resolve } from "node:path";
import { reclaimHostedSdks } from "./hosted-sdk-capacity.mjs";
import { acquireBuild, readBuildAdmissions } from "./build-admission.mjs";

const GiB = 1024 ** 3;
function fixture(t, availableGiB) {
  const root = fs.mkdtempSync(join(os.tmpdir(), "hosted-capacity-"));
  const cwd = join(root, "candidate");
  fs.mkdirSync(cwd);
  const previous = Object.fromEntries(
    ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "DSH_BUILD_ADMISSION"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  process.env.GITHUB_ACTIONS = "true";
  process.env.RUNNER_ENVIRONMENT = "github-hosted";
  delete process.env.DSH_BUILD_ADMISSION;
  t.mock.method(os, "platform", () => "linux");
  t.mock.method(os, "tmpdir", () => root);
  let available = availableGiB * GiB;
  t.mock.method(fs, "statfsSync", () => ({ bavail: available, bsize: 1 }));
  const removed = [];
  const commands = [];
  const sizes = new Map([
    ["/usr/share/dotnet", 4 * GiB],
    ["/usr/local/lib/android", 12 * GiB],
    ["/usr/share/swift", 2 * GiB],
  ]);
  const stat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (path, options) =>
    String(path).startsWith("/usr/") || String(path).startsWith("/opt/")
      ? sizes.has(path)
        ? { isDirectory: () => true }
        : undefined
      : stat(path, options),
  );
  let freed = true;
  t.mock.method(child, "execFileSync", (command, args) => {
    commands.push({ command, args });
    if (command === "du") return String(sizes.get(args.at(-1)) / 1024) + "\tfixture\n";
    assert.equal(command, "sudo");
    assert.deepEqual(args.slice(0, 3), ["rm", "-rf", "--"]);
    const path = args.at(-1);
    assert.ok(sizes.has(path));
    removed.push(path);
    if (freed) available += sizes.get(path);
    sizes.delete(path);
    return "";
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    cwd,
    root,
    removed,
    commands,
    sizes,
    noFreedSpace: () => {
      freed = false;
    },
  };
}

test("ample hosted capacity avoids sizing and deletion and leaves no admission behind", (t) => {
  const f = fixture(t, 85);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = reclaimHostedSdks({ cwd: f.cwd });
    assert.equal(result.status, "not-needed");
    assert.equal(result.before.requiredBytes, 28 * GiB);
    assert.equal(result.after.availableBytes, 85 * GiB);
  }
  assert.deepEqual(f.commands, []);
  assert.deepEqual(readBuildAdmissions(f.cwd), []);
});

test("low capacity reclaims the smallest sufficient directory and rechecks the real admission", (t) => {
  const f = fixture(t, 25);
  const result = reclaimHostedSdks({ cwd: f.cwd });
  assert.equal(result.status, "reclaimed");
  assert.deepEqual(f.removed, ["/usr/share/dotnet"]);
  assert.equal(result.after.availableBytes, 29 * GiB);
  assert.equal(result.removed[0].bytesBefore, 4 * GiB);
  assert.ok(result.removed[0].durationMs >= 0);
  assert.equal(reclaimHostedSdks({ cwd: f.cwd }).status, "not-needed");
  assert.deepEqual(readBuildAdmissions(f.cwd), []);
});

test("partial previous cleanup converges and stops once capacity is sufficient", (t) => {
  const f = fixture(t, 15);
  f.sizes.delete("/usr/share/dotnet");
  const result = reclaimHostedSdks({ cwd: f.cwd });
  assert.equal(result.status, "reclaimed");
  assert.deepEqual(f.removed, ["/usr/local/lib/android", "/usr/share/swift"]);
  assert.equal(result.after.availableBytes, 29 * GiB);
});

test("deletion without recovered space preserves the capacity refusal and failure evidence", (t) => {
  const f = fixture(t, 1);
  f.noFreedSpace();
  assert.throws(
    () => reclaimHostedSdks({ cwd: f.cwd }),
    (error) => {
      assert.equal(error.code, "BUILD_CAPACITY_INSUFFICIENT");
      assert.equal(error.requiredBytes, 28 * GiB);
      assert.equal(error.reclamation.status, "failed");
      assert.equal(error.reclamation.removed.length, 3);
      return true;
    },
  );
  assert.deepEqual(readBuildAdmissions(f.cwd), []);
});

test("missing hosted SDK directories leave the capacity refusal intact without privileged commands", (t) => {
  const f = fixture(t, 1);
  f.sizes.clear();
  assert.throws(
    () => reclaimHostedSdks({ cwd: f.cwd }),
    (error) => {
      assert.equal(error.code, "BUILD_CAPACITY_INSUFFICIENT");
      assert.deepEqual(error.reclamation.removed, []);
      return true;
    },
  );
  assert.deepEqual(f.commands, []);
});

test("invalid SDK size output stops before deletion and preserves diagnostics", (t) => {
  const f = fixture(t, 25);
  t.mock.method(child, "execFileSync", (command) => {
    assert.equal(command, "du");
    return "invalid-size\n";
  });
  assert.throws(
    () => reclaimHostedSdks({ cwd: f.cwd }),
    (error) => {
      assert.match(error.message, /HOSTED_SDK_SIZE_INVALID/);
      assert.equal(error.reclamation.status, "failed");
      assert.deepEqual(error.reclamation.removed, []);
      return true;
    },
  );
  assert.deepEqual(f.removed, []);
});

test("an active heavy writer refuses cleanup and retained watch reservations count toward capacity", (t) => {
  const f = fixture(t, 29);
  const release = acquireBuild({ operation: "build", cwd: f.cwd });
  delete process.env.DSH_BUILD_ADMISSION;
  assert.throws(() => reclaimHostedSdks({ cwd: join(f.root, "other") }), /BUILD_VOLUME_BUSY/);
  assert.deepEqual(f.commands, []);
  release();
  const watch = acquireBuild({ operation: "watch", cwd: f.cwd });
  delete process.env.DSH_BUILD_ADMISSION;
  const result = reclaimHostedSdks({ cwd: join(f.root, "other") });
  assert.equal(result.before.requiredBytes, 29 * GiB);
  assert.equal(result.before.reservedBytes, GiB);
  assert.deepEqual(f.commands, []);
  watch();
});

test("self-hosted and non-Linux processes cannot invoke hosted cleanup", (t) => {
  const f = fixture(t, 1);
  process.env.RUNNER_ENVIRONMENT = "self-hosted";
  assert.throws(() => reclaimHostedSdks({ cwd: f.cwd }), /HOSTED_SDK_RUNNER_REQUIRED/);
  process.env.RUNNER_ENVIRONMENT = "github-hosted";
  t.mock.method(os, "platform", () => "darwin");
  assert.throws(() => reclaimHostedSdks({ cwd: f.cwd }), /HOSTED_SDK_RUNNER_REQUIRED/);
  assert.deepEqual(f.commands, []);
});

test("stale reservations require review without cleanup", (t) => {
  const f = fixture(t, 1);
  const directory = join(f.root, `dsh-build-admission-${process.getuid?.() ?? "user"}`);
  fs.mkdirSync(directory);
  fs.writeFileSync(
    join(directory, "stale.json"),
    JSON.stringify({
      pid: 2147483647,
      scopes: [f.cwd],
      reserveBytes: GiB,
      operation: "build",
    }),
  );
  assert.throws(() => reclaimHostedSdks({ cwd: f.cwd }), /BUILD_ADMISSION_REQUIRES_REVIEW/);
  assert.deepEqual(f.commands, []);
  assert.ok(fs.existsSync(join(directory, "stale.json")));
});

test("a failed privileged deletion stops and keeps its failure receipt", (t) => {
  const f = fixture(t, 25);
  const execute = child.execFileSync;
  t.mock.method(child, "execFileSync", (command, args) => {
    if (command === "sudo") throw Error("fixture-delete-refused");
    return execute(command, args);
  });
  assert.throws(
    () => reclaimHostedSdks({ cwd: f.cwd }),
    (error) => {
      assert.match(error.message, /fixture-delete-refused/);
      assert.equal(error.reclamation.status, "failed");
      assert.equal(error.reclamation.removed.length, 1);
      assert.equal(error.reclamation.removed[0].status, "failed");
      return true;
    },
  );
  assert.deepEqual(readBuildAdmissions(f.cwd), []);
});

test("the public CLI refuses a non-hosted invocation before running privileged commands", () => {
  const result = child.spawnSync(
    process.execPath,
    [resolve("scripts/hosted-sdk-capacity.mjs"), "--output", process.cwd()],
    {
      env: { PATH: process.env.PATH, GITHUB_ACTIONS: "false" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HOSTED_SDK_RUNNER_REQUIRED/);
});
