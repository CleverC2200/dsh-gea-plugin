import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const cli = resolve(import.meta.dirname, "quality-system-chrome.mjs");
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quality-chrome-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, body) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), body);
  };
  put("quality-test-plan.json", JSON.stringify({ browser: true }));
  put("system/chrome", "Chrome producer bytes");
  chmodSync(join(root, "system/chrome"), 0o755);
  put("system/chrome-sandbox", "sandbox original");
  chmodSync(join(root, "system/chrome-sandbox"), 0o4755);
  put("system/resources.pak", "Chrome resources");
  mkdirSync(join(root, "system/locales"));
  put("system/locales/en-US.pak", "locale");
  put(
    "package-files.json",
    JSON.stringify([
      "/opt/google/chrome",
      ...["chrome", "chrome-sandbox", "resources.pak", "locales", "locales/en-US.pak"].map(
        (p) => "/opt/google/chrome/" + p,
      ),
    ]),
  );
  put("candidate/dsh-gea-plugin/package.json", JSON.stringify({ type: "module" }));
  put(
    "candidate/dsh-gea-plugin/node_modules/@playwright/test/package.json",
    JSON.stringify({ type: "commonjs", exports: "./index.cjs", version: "1.58.2" }),
  );
  put(
    "candidate/dsh-gea-plugin/node_modules/@playwright/test/api.cjs",
    `const {appendFileSync}=require('node:fs');const chromium={launch:async options=>{if(process.env.FAIL_LAUNCH==='1')throw Error('launch failed');appendFileSync(${JSON.stringify(join(root, "launches.jsonl"))},JSON.stringify(options)+'\\n');return {version:()=> '154.0.8037.97',close:async()=>{}}}};Object.assign(module.exports,{chromium});`,
  );
  put(
    "candidate/dsh-gea-plugin/node_modules/@playwright/test/index.cjs",
    "module.exports = require('./api.cjs');",
  );
  put(
    "boundary.mjs",
    `import {installChromeCommands} from ${JSON.stringify(resolve(import.meta.dirname, "fixtures/quality-system-chrome-commands.mjs"))};installChromeCommands({root:${JSON.stringify(root)}});`,
  );
  const run = (action, extra = {}) =>
    spawnSync(process.execPath, [cli, action, "--root", root], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--import=" + join(root, "boundary.mjs"),
        GITHUB_WORKSPACE: root,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "github-hosted",
        RUNNER_OS: "Linux",
        ...extra,
      },
    });
  return {
    root,
    put,
    run,
    read: (name) => JSON.parse(readFileSync(join(root, name))),
    chmod: (p, m) => chmodSync(join(root, p), m),
    link: (p, target) => symlinkSync(target, join(root, p)),
  };
}
test("the public Chrome producer freezes original bytes and records ordinary sandbox mode before readonly mount and cleanup", (t) => {
  const f = fixture(t);
  const prepared = f.run("prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  const receipt = f.read("system-chrome-preparation.json");
  assert.equal(receipt.status, "system-chrome-prepared");
  assert.equal(receipt.version, "Google Chrome 154.0.8037.97");
  const sandbox = receipt.entries.find((x) => x.path === "chrome-sandbox");
  assert.equal(sandbox.sourceMode, 0o4755);
  assert.equal(sandbox.mode, 0o755);
  assert.equal(
    readFileSync(join(f.root, ".quality-system-chrome/chrome"), "utf8"),
    "Chrome producer bytes",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, "launches.jsonl"), "utf8").trim()), {
    channel: "chrome",
    headless: true,
  });
  const mounted = f.run("mount");
  assert.equal(mounted.status, 0, mounted.stderr);
  assert.equal(f.read("quality-system-chrome-mount.json").status, "system-chrome-mounted");
  assert.equal(f.read("mount-state.json").readonly, true);
  const cleanup = f.run("cleanup");
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(f.read("quality-system-chrome-cleanup.json").status, "system-chrome-unmounted");
});

test("producer refuses non-package files, special modes, redirected or dangling links and changes during copying", (t) => {
  for (const scenario of [
    "unowned",
    "mode",
    "directory",
    "external",
    "dangling",
    "cycle",
    "changed",
    "launch",
  ]) {
    const f = fixture(t);
    if (scenario === "unowned") f.put("system/Profile", "private");
    if (scenario === "mode") f.chmod("system/resources.pak", 0o4755);
    if (scenario === "directory") f.chmod("system/locales", 0o2755);
    if (scenario === "external") f.link("system/link", "../outside");
    if (scenario === "dangling") f.link("system/link", "missing");
    if (scenario === "cycle") f.link("system/link", "link");
    const r = f.run("prepare", {
      ...(scenario === "changed" ? { CHANGE_SOURCE: "1" } : {}),
      ...(scenario === "launch" ? { FAIL_LAUNCH: "1" } : {}),
    });
    assert.equal(r.status, 1, scenario);
    assert.match(r.stderr, /QUALITY_SYSTEM_CHROME_REJECTED|launch failed/);
  }
});
test("snapshot corruption, unknown mounts and failed or writable mounts refuse without fallback; owned partial mounts still clean up", (t) => {
  for (const scenario of [
    "bytes",
    "extra",
    "mode",
    "mount",
    "remount",
    "readonly",
    "version",
    "wrong-source",
    "wrong-target",
    "unknown",
  ]) {
    const f = fixture(t);
    assert.equal(f.run("prepare").status, 0);
    if (scenario === "bytes") f.put(".quality-system-chrome/resources.pak", "wrong");
    if (scenario === "extra") f.put(".quality-system-chrome/Profile", "wrong");
    if (scenario === "mode") f.chmod(".quality-system-chrome/chrome", 0o644);
    if (scenario === "unknown") f.put("mount-state.json", JSON.stringify({ readonly: true }));
    const env =
      scenario === "mount"
        ? { FAIL_MOUNT: "1" }
        : scenario === "remount"
          ? { FAIL_REMOUNT: "1" }
          : scenario === "readonly"
            ? { NOT_READONLY: "1" }
            : scenario === "version"
              ? { WRONG_VERSION: "1" }
              : scenario === "wrong-source"
                ? { WRONG_MOUNT_SOURCE: "1" }
                : scenario === "wrong-target"
                  ? { WRONG_MOUNT_TARGET: "1" }
                  : {};
    assert.equal(f.run("mount", env).status, 1, scenario);
    if (["remount", "readonly", "version"].includes(scenario))
      assert.equal(f.run("cleanup").status, 0, scenario);
  }
});
test("cleanup preserves a failed integrity result while unmounting, and rejects wrong ownership or unmount failure", (t) => {
  for (const scenario of ["bytes", "owner", "unmount"]) {
    const f = fixture(t);
    assert.equal(f.run("prepare").status, 0);
    assert.equal(f.run("mount").status, 0);
    if (scenario === "bytes") f.put(".quality-system-chrome/resources.pak", "changed by tests");
    if (scenario === "owner") {
      const marker = f.read("quality-system-chrome-mount.json");
      marker.runAttempt = "2";
      f.put("quality-system-chrome-mount.json", JSON.stringify(marker));
    }
    assert.equal(
      f.run(
        "cleanup",
        scenario === "unmount"
          ? { FAIL_UNMOUNT: "1" }
          : scenario === "bytes"
            ? { BUSY_UNMOUNT: "1" }
            : {},
      ).status,
      1,
      scenario,
    );
    if (scenario === "bytes") {
      assert.equal(f.read("quality-system-chrome-cleanup.json").status, "failed");
      assert.match(
        f.read("quality-system-chrome-cleanup.json").error,
        /Chrome snapshot bytes\/mode\/link changed/,
      );
      assert.equal(f.read("quality-system-chrome-cleanup.json").unmount.attempts.length, 2);
      assert.equal(existsSync(join(f.root, "mount-state.json")), false);
    }
  }
});

test("cleanup rejects a mount lost after readiness but permits cleanup when bind never succeeded", (t) => {
  const lost = fixture(t);
  assert.equal(lost.run("prepare").status, 0);
  assert.equal(lost.run("mount").status, 0);
  assert.equal(lost.read("quality-system-chrome-mount.json").status, "system-chrome-mounted");
  rmSync(join(lost.root, "mount-state.json"));
  const failed = lost.run("cleanup");
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /previously mounted Chrome is missing/);
  const receipt = lost.read("quality-system-chrome-cleanup.json");
  assert.equal(receipt.status, "failed");
  assert.match(receipt.error, /previously mounted Chrome is missing/);

  const neverBound = fixture(t);
  assert.equal(neverBound.run("prepare").status, 0);
  assert.equal(neverBound.run("mount", { FAIL_MOUNT: "1" }).status, 1);
  assert.equal(neverBound.read("quality-system-chrome-mount.json").status, "mounting");
  assert.equal(existsSync(join(neverBound.root, "mount-state.json")), false);
  const cleaned = neverBound.run("cleanup");
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(
    neverBound.read("quality-system-chrome-cleanup.json").status,
    "system-chrome-unmounted",
  );
});

test("source root and nested ordinary modes are recorded while prepared directories stay 0755", (t) => {
  const f = fixture(t);
  f.chmod("system", 0o775);
  f.chmod("system/locales", 0o770);
  const result = f.run("prepare");
  assert.equal(result.status, 0, result.stderr);
  const receipt = f.read("system-chrome-preparation.json");
  assert.equal(receipt.sourceRootMode, 0o775);
  assert.deepEqual(receipt.preparation.sourceRoot, {
    path: "/opt/google/chrome",
    type: "directory",
    mode: 0o775,
    realpath: "/opt/google/chrome",
  });
  assert.match(result.stderr, /quality-system-chrome-source/);
  assert.equal(receipt.entries.find((x) => x.path === "locales").sourceMode, 0o770);
  assert.equal(receipt.entries.find((x) => x.path === "locales").mode, 0o755);
  assert.equal(statSync(join(f.root, ".quality-system-chrome")).mode & 0o7777, 0o755);
  assert.equal(statSync(join(f.root, ".quality-system-chrome/locales")).mode & 0o7777, 0o755);
});

test("source directory special bits and changing modes reject; prepared directory modes cannot drift", (t) => {
  for (const path of ["system", "system/locales"]) {
    const special = fixture(t);
    special.chmod(path, 0o2775);
    const refused = special.run("prepare");
    assert.equal(refused.status, 1, path);
    assert.match(refused.stderr, /Chrome root mode\/path|Chrome directory mode/);
    const observation = JSON.parse(
      refused.stderr
        .split("\n")
        .find((x) => x.startsWith("[quality-system-chrome-source]"))
        .slice("[quality-system-chrome-source] ".length),
    );
    assert.equal(observation.type, "directory");
    assert.equal(observation.realpath, "/opt/google/chrome");
    if (path === "system") assert.equal(observation.mode, 0o2775);
  }
  for (const scope of ["root", "directory"]) {
    const f = fixture(t);
    const result = f.run("prepare", { CHANGE_SOURCE_MODE: scope });
    assert.equal(result.status, 1, scope);
    assert.match(result.stderr, /Chrome changed during snapshot/);
  }
  for (const path of [".quality-system-chrome", ".quality-system-chrome/locales"]) {
    const f = fixture(t);
    assert.equal(f.run("prepare").status, 0);
    f.chmod(path, 0o775);
    const result = f.run("mount");
    assert.equal(result.status, 1, path);
    assert.match(result.stderr, /Chrome root mode\/path|Chrome directory mode/);
  }
  const old = fixture(t);
  assert.equal(old.run("prepare").status, 0);
  const receipt = old.read("system-chrome-preparation.json");
  delete receipt.sourceRootMode;
  old.put("system-chrome-preparation.json", JSON.stringify(receipt));
  const unknown = old.run("mount");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /fixed Chrome receipt/);
});

for (const change of ["identity", "list"])
  test(`producer refuses a ${change}-only package change during copy with unchanged Chrome bytes/version`, (t) => {
    const f = fixture(t);
    const result = f.run("prepare", { CHANGE_CHROME_PACKAGE: change });
    assert.equal(readFileSync(join(f.root, "system/chrome"), "utf8"), "Chrome producer bytes");
    assert.equal(readFileSync(join(f.root, "system/resources.pak"), "utf8"), "Chrome resources");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Chrome package changed during snapshot/);
    assert.equal(existsSync(join(f.root, "system-chrome-preparation.json")), false);
  });
test("package path order changes alone preserve the complete normalized package identity", (t) => {
  const f = fixture(t);
  const before = f.read("package-files.json");
  const result = f.run("prepare", { CHANGE_CHROME_PACKAGE: "order" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.read("package-files.json"), before.reverse());
  assert.equal(f.read("system-chrome-preparation.json").status, "system-chrome-prepared");
});

test("cleanup waits for transient busy on the same owned mount using only ordinary umount", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1" });
  assert.equal(result.status, 0, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.equal(receipt.status, "system-chrome-unmounted");
  assert.equal(receipt.unmount.attempts.length, 2);
  assert.equal(receipt.unmount.attempts[0].status, 32);
  assert.equal(receipt.unmount.attempts[1].status, 0);
  assert.equal(existsSync(join(f.root, "mount-state.json")), false);
  const calls = readFileSync(join(f.root, "chrome-commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const unmounts = calls.filter((x) => x.command === "sudo" && x.args.includes("umount"));
  assert.ok(
    unmounts.every(
      (x) => x.locale === "C" && x.lang === "C" && x.timeout > 0 && x.timeout <= 10000,
    ),
  );
  assert.deepEqual(
    unmounts.map((x) => x.args),
    Array.from({ length: 2 }, () => ["-n", "umount", "/opt/google/chrome"]),
  );
});

test("cleanup keeps persistent busy failed after its bounded wait without detaching the mount", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { BUSY_UNMOUNT: "always" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Chrome unmount remained busy after 10000ms/);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.unmount.timeoutMs, 10000);
  assert.ok(receipt.unmount.attempts.length > 1);
  assert.ok(receipt.unmount.attempts.length <= 101);
  assert.ok(receipt.unmount.attempts.every((x) => x.status === 32));
  assert.equal(existsSync(join(f.root, "mount-state.json")), true);
});

test("cleanup never retries a non-busy error, signal, timeout or different target/status", (t) => {
  for (const failure of ["1", "wrong-target", "wrong-status", "signal", "timeout"]) {
    const f = fixture(t);
    assert.equal(f.run("prepare").status, 0);
    assert.equal(f.run("mount").status, 0);
    const result = f.run("cleanup", { FAIL_UNMOUNT: failure });
    assert.equal(result.status, 1, failure);
    const receipt = f.read("quality-system-chrome-cleanup.json");
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.unmount.attempts.length, 1, failure);
    assert.equal(existsSync(join(f.root, "mount-state.json")), true);
  }
});

test("cleanup rejects owner, snapshot, source, readonly drift or disappearance before another busy attempt", (t) => {
  for (const [change, reason] of [
    ["owner", /ownership changed/],
    ["snapshot", /ownership changed/],
    ["source", /source changed/],
    ["readonly", /options changed/],
    ["missing", /previously mounted Chrome is missing/],
  ]) {
    const f = fixture(t);
    assert.equal(f.run("prepare").status, 0);
    assert.equal(f.run("mount").status, 0);
    const result = f.run("cleanup", { BUSY_UNMOUNT: "1", CHANGE_AFTER_BUSY: change });
    assert.equal(result.status, 1, change);
    assert.match(result.stderr, reason, change);
    assert.equal(f.read("quality-system-chrome-cleanup.json").status, "failed");
    assert.equal(f.read("quality-system-chrome-cleanup.json").unmount.attempts.length, 1, change);
  }
});

test("cleanup drains a short busy tail beyond two seconds within its finite ten second window", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { BUSY_UNMOUNT: "21" });
  assert.equal(result.status, 0, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.equal(receipt.status, "system-chrome-unmounted");
  assert.equal(receipt.unmount.timeoutMs, 10000);
  assert.equal(receipt.unmount.attempts.length, 22);
  assert.equal(receipt.unmount.attempts.at(-1).status, 0);
});

test("cleanup retains first busy and does not launch sudo with a six millisecond tail", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1", CLOCK_INSPECTION_TAIL_MS: "6" });
  assert.equal(result.status, 1, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.match(receipt.error, /Chrome unmount remained busy/);
  assert.equal(receipt.unmount.attempts.length, 1);
  assert.equal(receipt.unmount.firstBusy.status, 32);
  assert.equal(receipt.unmount.stopReason.kind, "insufficient-command-budget");
  assert.equal(receipt.unmount.stopReason.minimumMs, 100);
  assert.ok(receipt.unmount.stopReason.remainingMs < 100);
  assert.equal(existsSync(join(f.root, "mount-state.json")), true);
});

test("a cleanup-owned deadline timeout preserves exact busy as primary and the terminal command details", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1", TIMEOUT_AFTER_BUSY: "1" });
  assert.equal(result.status, 1, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.match(receipt.error, /Chrome unmount remained busy after 10000ms/);
  assert.equal(receipt.unmount.firstBusy.status, 32);
  assert.equal(receipt.unmount.lastBusy.status, 32);
  assert.equal(receipt.unmount.attempts.length, 2);
  assert.equal(receipt.unmount.terminalFailure.command, "sudo");
  assert.equal(receipt.unmount.terminalFailure.errorCode, "ETIMEDOUT");
  assert.equal(receipt.unmount.terminalFailure.signal, "SIGTERM");
  assert.equal(existsSync(join(f.root, "mount-state.json")), true);
});

test("busy cleanup records bounded read-only candidate references without claiming holder ownership", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  f.put("proc/123/stat", "123 (chrome) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 777\n");
  f.put("proc/123/maps", "7f000-7f001 r-xp 00000000 08:01 42 /opt/google/chrome/chrome\n");
  f.put("proc/123/cmdline", "PRIVATE_ARGV_MUST_NOT_BE_READ");
  f.put("proc/123/environ", "PRIVATE_ENV_MUST_NOT_BE_READ");
  f.put(
    "proc/self/mountinfo",
    "77 2 8:1 /.quality-system-chrome /opt/google/chrome ro - ext4 /dev/root ro\n78 77 8:1 /child /opt/google/chrome/child ro - ext4 /dev/root ro\n",
  );
  f.link("proc/123/cwd", "/opt/google/chrome");
  f.put("proc/123/fd/placeholder", "");
  f.link("proc/123/fd/3", f.root + "/.quality-system-chrome/resources.pak");
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1" });
  assert.equal(result.status, 0, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  const diagnostic = receipt.unmount.referenceDiagnostics;
  assert.equal(diagnostic.holderProof, "unknown");
  assert.equal(diagnostic.scope, "read-only-proc-candidate-references");
  assert.ok(
    diagnostic.references.some(
      (r) =>
        r.pid === 123 &&
        r.ppid === 1 &&
        r.comm === "chrome" &&
        r.starttime === "777" &&
        r.kind === "cwd",
    ),
  );
  assert.ok(
    diagnostic.references.some((r) => r.kind === "maps" && r.path === "/opt/google/chrome/chrome"),
  );
  assert.ok(diagnostic.references.some((r) => r.kind === "fd"));
  assert.deepEqual(
    diagnostic.mounts.map((r) => r.id),
    [77, 78],
  );
  assert.equal(diagnostic.limits.budgetMs, 250);
  assert.ok(!JSON.stringify(receipt).includes("PRIVATE_"));
  assert.ok(!readFileSync(join(f.root, "proc-access.jsonl"), "utf8").match(/cmdline|environ/));
  assert.equal(receipt.unmount.attempts.at(-1).status, 0);
});

test("cleanup does not start a mount inspection with insufficient remaining command budget", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1", CLOCK_AFTER_BUSY_REMAINING: "106" });
  assert.equal(result.status, 1, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.match(receipt.error, /Chrome unmount remained busy/);
  const calls = readFileSync(join(f.root, "chrome-commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(!calls.some((c) => c.command === "findmnt" && c.timeout < 100));
  assert.equal(receipt.unmount.attempts.length, 1);
  assert.equal(receipt.unmount.stopReason.command, "findmnt");
});

test("a cleanup-owned inspection timeout retains the prior busy and inspection details", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1", TIMEOUT_INSPECTION_AFTER_BUSY: "1" });
  assert.equal(result.status, 1, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.match(receipt.error, /Chrome unmount remained busy after 10000ms/);
  assert.equal(receipt.unmount.firstBusy.status, 32);
  assert.equal(receipt.unmount.terminalFailure.command, "findmnt");
  assert.equal(receipt.unmount.terminalFailure.errorCode, "ETIMEDOUT");
  assert.equal(receipt.unmount.terminalFailure.signal, "SIGTERM");
  assert.equal(receipt.unmount.attempts.length, 1);
});

test("busy cleanup refuses a redirected fixed Chrome source before another unmount", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1", CHANGE_AFTER_BUSY: "redirect" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /system Chrome source redirected/);
  assert.equal(f.read("quality-system-chrome-cleanup.json").unmount.attempts.length, 1);
  assert.equal(existsSync(join(f.root, "mount-state.json")), true);
});

test("cleanup cannot report success without enough budget to verify normal unmount", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { SUCCESS_UNMOUNT_REMAINING: "6" });
  assert.equal(result.status, 1, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.match(receipt.error, /cleanup command budget exhausted/);
  assert.equal(receipt.unmount.unmountSucceeded, true);
  assert.equal(receipt.unmount.stopReason.command, "findmnt");
  assert.equal(receipt.unmount.firstBusy, undefined);
  assert.equal(receipt.unmount.attempts.length, 1);
});

test("unknown or failed proc diagnostics never release a persistent busy mount", (t) => {
  for (const mode of ["denied", "vanished", "timeout", "broken"]) {
    const f = fixture(t);
    assert.equal(f.run("prepare").status, 0);
    assert.equal(f.run("mount").status, 0);
    f.put("proc/123/stat", "123 (chrome) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 777\n");
    const result = f.run("cleanup", {
      BUSY_UNMOUNT: "always",
      UNMOUNT_ADVANCE_MS: "1000",
      PROC_DIAGNOSTIC: mode,
    });
    assert.equal(result.status, 1, mode);
    const receipt = f.read("quality-system-chrome-cleanup.json");
    assert.match(receipt.error, /Chrome unmount remained busy after 10000ms/);
    assert.equal(receipt.unmount.referenceDiagnostics.holderProof, "unknown");
    assert.ok(receipt.unmount.referenceDiagnostics.unknown.length > 0, mode);
    assert.equal(existsSync(join(f.root, "mount-state.json")), true);
    assert.ok(!JSON.stringify(receipt).includes("private fixture diagnostic error"));
  }
});

test("proc diagnostics cap file bytes and candidate output rather than treating truncation as no holders", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  f.put("proc/123/stat", "123 (chrome) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 777\n");
  f.put(
    "proc/123/maps",
    "7f000-7f001 r-xp 00000000 08:01 42 /opt/google/chrome/chrome\n".repeat(1400),
  );
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1" });
  assert.equal(result.status, 0, result.stderr);
  const diagnostic = f.read("quality-system-chrome-cleanup.json").unmount.referenceDiagnostics;
  assert.equal(diagnostic.holderProof, "unknown");
  assert.equal(diagnostic.references.length, 32);
  assert.ok(diagnostic.unknown.some((r) => r.kind === "file-truncated"));
  assert.ok(diagnostic.unknown.some((r) => r.kind === "references-truncated"));
  assert.ok(diagnostic.unknown.length <= 32);
});

test("proc diagnostics stop after their finite PID, FD or clock limits", (t) => {
  for (const mode of ["pids", "fds", "clock"]) {
    const f = fixture(t);
    assert.equal(f.run("prepare").status, 0);
    assert.equal(f.run("mount").status, 0);
    for (let i = 1; i <= (mode === "pids" ? 260 : 1); i++) {
      f.put(`proc/${i}/stat`, `${i} (chrome) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 777\n`);
      f.put(`proc/${i}/maps`, "");
      for (let fd = 0; fd < (mode === "fds" ? 70 : 1); fd++) f.put(`proc/${i}/fd/${fd}`, "");
    }
    const result = f.run("cleanup", {
      BUSY_UNMOUNT: "1",
      ...(mode === "clock" ? { PROC_DIAGNOSTIC: "timeout" } : {}),
    });
    assert.equal(result.status, 0, result.stderr);
    const diagnostic = f.read("quality-system-chrome-cleanup.json").unmount.referenceDiagnostics;
    assert.equal(diagnostic.holderProof, "unknown");
    assert.ok(diagnostic.processesScanned <= 256);
    assert.ok(
      diagnostic.unknown.some((r) =>
        ["processes-truncated", "fds-truncated", "deadline"].includes(r.kind),
      ),
      mode,
    );
    const access = readFileSync(join(f.root, "proc-access.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      access.filter((r) => r.operation === "readlinkSync" && r.path.startsWith("/proc/1/fd/"))
        .length <= 64,
    );
    if (mode === "clock") assert.equal(diagnostic.processesScanned, 0);
  }
});

test("initial snapshot failure remains primary despite a later cleanup deadline timeout", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  f.put(".quality-system-chrome/resources.pak", "changed by tests");
  const result = f.run("cleanup", { BUSY_UNMOUNT: "1", TIMEOUT_AFTER_BUSY: "1" });
  assert.equal(result.status, 1, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.match(receipt.error, /Chrome snapshot bytes\/mode\/link changed/);
  assert.equal(receipt.unmount.firstBusy.status, 32);
  assert.equal(receipt.unmount.terminalFailure.errorCode, "ETIMEDOUT");
  assert.equal(receipt.unmount.attempts.length, 2);
});

test("a non-deadline timeout or signal after busy stays an independent cleanup failure", (t) => {
  for (const failure of ["timeout", "signal", "1"]) {
    const f = fixture(t);
    assert.equal(f.run("prepare").status, 0);
    assert.equal(f.run("mount").status, 0);
    const result = f.run("cleanup", { BUSY_UNMOUNT: "1", FAIL_UNMOUNT: failure });
    assert.equal(result.status, 1, failure);
    const receipt = f.read("quality-system-chrome-cleanup.json");
    assert.match(receipt.error, /sudo:/);
    assert.doesNotMatch(receipt.error, /remained busy/);
    assert.equal(receipt.unmount.firstBusy.status, 32);
    assert.equal(receipt.unmount.attempts.length, 2);
    assert.equal(existsSync(join(f.root, "mount-state.json")), true);
  }
});

test("post-unmount inspection failure remains failed and preserves its command details", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("mount").status, 0);
  const result = f.run("cleanup", { FAIL_POST_UNMOUNT_INSPECTION: "1" });
  assert.equal(result.status, 1, result.stderr);
  const receipt = f.read("quality-system-chrome-cleanup.json");
  assert.match(receipt.error, /mount inspection failed/);
  assert.equal(receipt.unmount.unmountSucceeded, true);
  assert.equal(receipt.unmount.firstBusy, undefined);
  assert.equal(receipt.unmount.terminalFailure.command, "findmnt");
  assert.equal(receipt.unmount.terminalFailure.errorCode, "ETIMEDOUT");
});
