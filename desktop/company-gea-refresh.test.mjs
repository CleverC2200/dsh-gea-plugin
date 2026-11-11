import test from "node:test";
import assert from "node:assert/strict";
import { planBundledCompanyRefresh } from "./company-gea-refresh.mjs";

const name = "@cleverc2200/gea-dsh-prototype";
const companions = [
  {
    name: "@cleverc2200/dsh-agent-workbench",
    from: "0.1.25",
    version: "0.1.28",
    file: "workbench.tgz",
  },
  {
    name: "dsh-agent-manage",
    from: "0.6.3-company.28",
    version: "0.6.3-company.30",
    file: "manage.tgz",
  },
];
const current = {
  dependencies: {
    [name]: "file:/old/gea.tgz",
    "my-plugin": "1.0.0",
    ...Object.fromEntries(companions.map((row) => [row.name, "file:/old/" + row.file])),
  },
  dsh: {
    profile: {
      bundles: [name, "my-plugin", ...companions.map((row) => row.name)],
    },
  },
};
const bundled = { name, version: "0.0.166" };
const installed = { name, version: "0.0.130" };
const bundledSuite = [...companions, { ...bundled, file: "gea.tgz" }];
const installedSuite = (gea = installed) => [
  ...companions.map((row) => ({ name: row.name, version: row.from })),
  gea,
];

test("an older company release produces a complete bundled suite plan", () => {
  const before = structuredClone(current);
  const plan = planBundledCompanyRefresh(current, installedSuite(), bundledSuite);
  assert.equal(plan.status, "ready");
  assert.deepEqual(
    plan.targets.map((row) => row.name),
    bundledSuite.map((row) => row.name),
  );
  assert.deepEqual(current, before);
  for (const version of ["0.0.167", "0.0.166-beta.1", "custom"])
    assert.equal(
      planBundledCompanyRefresh(current, installedSuite({ name, version }), bundledSuite).changed,
      false,
    );
  assert.equal(planBundledCompanyRefresh(current, bundledSuite, bundledSuite).changed, false);
  assert.throws(
    () => planBundledCompanyRefresh(current, [installed], [bundled]),
    /GEA_BUNDLED_COMPANY_SUITE_REQUIRED/,
  );
});

test("disabled, linked, missing and differently named plugins are preserved", () => {
  for (const manifest of [
    { ...current, dsh: { profile: { bundles: ["my-plugin"] } } },
    { ...current, dependencies: { [name]: "link:/development" } },
    { ...current, dependencies: { [name]: "file:/my-gea" } },
    { ...current, dependencies: {} },
  ])
    assert.equal(
      planBundledCompanyRefresh(manifest, installedSuite(), bundledSuite).changed,
      false,
    );
  assert.equal(
    planBundledCompanyRefresh(
      current,
      installedSuite({ ...installed, name: "my-plugin" }),
      bundledSuite,
    ).changed,
    false,
  );
});

import { mkdtemp, mkdir, writeFile, readFile, rm, access, rename, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshBundledCompanySuite, assertProfileIdle } from "./company-gea-refresh.mjs";
import { refreshCompanyStartup } from "./company-bootstrap.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "gea-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, "profiles/desktop");
  await mkdir(join(profile, "node_modules", name), { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify(current));
  await writeFile(join(profile, "node_modules", name, "package.json"), JSON.stringify(installed));
  for (const row of companions) {
    await mkdir(join(profile, "node_modules", row.name), { recursive: true });
    await writeFile(
      join(profile, "node_modules", row.name, "package.json"),
      JSON.stringify({ name: row.name, version: row.from }),
    );
  }
  await writeFile(join(profile, "cordis.patch.yml"), "# user configuration\n- id: custom\n");
  await writeFile(join(profile, "pnpm-lock.yaml"), "old lock");
  return {
    home,
    profile,
    root: "unused",
    support: "unused",
    seed: "/bundled",
    manifest: { packages: bundledSuite },
  };
}

test("the refresh installs one complete suite, keeps user configuration and saves original declarations", async (t) => {
  const f = await fixture(t);
  const result = await refreshBundledCompanySuite({
    ...f,
    install: async (options) => {
      assert.deepEqual(
        options.packages,
        bundledSuite.map((row) => "/bundled/archives/" + row.file),
      );
      await options.beforeInstall();
      await writeFile(
        join(f.profile, "package.json"),
        JSON.stringify({
          ...current,
          dependencies: {
            ...current.dependencies,
            ...Object.fromEntries(
              bundledSuite.map((row) => [row.name, "file:/bundled/archives/" + row.file]),
            ),
          },
        }),
      );
      await writeFile(
        join(f.profile, "node_modules", name, "package.json"),
        JSON.stringify(bundled),
      );
      for (const row of companions)
        await writeFile(
          join(f.profile, "node_modules", row.name, "package.json"),
          JSON.stringify({ name: row.name, version: row.version }),
        );
      await options.complete({ writeFileAtomic: writeFile });
    },
  });
  assert.equal(result.changed, true);
  const backup = join(f.profile, "gea/bootstrap/gea-refresh/before-0.0.130-to-0.0.166");
  assert.equal(await readFile(join(backup, "package.json"), "utf8"), JSON.stringify(current));
  assert.equal(await readFile(join(backup, "pnpm-lock.yaml"), "utf8"), "old lock");
  assert.equal(
    await readFile(join(f.profile, "cordis.patch.yml"), "utf8"),
    "# user configuration\n- id: custom\n",
  );
  assert.equal(
    (
      await refreshBundledCompanySuite({
        ...f,
        install: () => assert.fail("must not reinstall"),
      })
    ).changed,
    false,
  );
});

test("a pending restart defers bundled refresh while strict installation stays blocked", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  const operation = join(f.profile, "gea/plugin-updates/operations", id);
  await mkdir(operation, { recursive: true });
  await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  const receipt = JSON.stringify({ id, stage: "pending-restart" });
  await writeFile(join(operation, "receipt.json"), receipt);
  await assert.rejects(assertProfileIdle(f.profile), /GEA_REFRESH_UPDATE_PENDING/);
  const result = await refreshBundledCompanySuite({
    ...f,
    install: () => assert.fail("pending restart must not enter installation"),
  });
  assert.equal(result.status, "pending-restart-preserved");
  assert.equal(result.changed, false);
  assert.equal(await readFile(join(operation, "receipt.json"), "utf8"), receipt);
  await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh")), {
    code: "ENOENT",
  });
  assert.equal(await readFile(join(f.profile, "package.json"), "utf8"), JSON.stringify(current));
  const options = {
    ...f,
    legacyData: f.home,
    install: () => assert.fail("must not install"),
  };
  const startup = await refreshCompanyStartup(options);
  assert.equal(startup.refresh.status, "pending-restart-preserved");
  assert.equal(startup.cleanup, null);
  for (const row of bundledSuite)
    await writeFile(join(f.profile, "node_modules", row.name, "package.json"), JSON.stringify(row));
  assert.equal((await refreshCompanyStartup(options)).cleanup, null);
  await writeFile(join(operation, "receipt.json"), JSON.stringify({ id, stage: "completed" }));
  const next = await refreshCompanyStartup(options);
  assert.equal(next.refresh.status, "current-company-suite-preserved");
  assert.ok(next.cleanup);
});

async function pendingCompanions(t, bundledVersions = ["0.1.51", "0.6.3-company.47", "0.0.219"]) {
  const f = await fixture(t);
  const child = spawn(process.execPath, ["-e", ""], {
    detached: process.platform !== "win32",
  });
  const pid = child.pid;
  await once(child, "exit");
  const id = "aae2d1fe-5c75-407a-ac8b-803d394271d3";
  const operation = join(f.profile, "gea/plugin-updates/operations", id);
  const cache = join(f.profile, "gea/plugin-updates/cache");
  const seed = join(f.home, "company-seed");
  for (const path of [operation, cache, join(seed, "archives")])
    await mkdir(path, { recursive: true });
  const versions = ["0.1.51", "0.6.3-company.47", "0.0.219"];
  const profile = structuredClone(current);
  const packages = [];
  const targets = [];
  for (const [index, row] of bundledSuite.entries()) {
    const bytes = Buffer.from(row.name + "@" + bundledVersions[index]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file =
      row.name.replace(/^@/, "").replace("/", "-") + "-" + bundledVersions[index] + ".tgz";
    packages.push({ name: row.name, version: bundledVersions[index], file, sha256 });
    await writeFile(join(seed, "archives", file), bytes);
    if (index < 2) {
      const installedBytes = Buffer.from(row.name + "@" + versions[index]);
      const installedSha256 = createHash("sha256").update(installedBytes).digest("hex");
      const archivePath = join(cache, installedSha256 + ".tgz");
      await writeFile(archivePath, installedBytes);
      targets.push({
        packageName: row.name,
        targetVersion: versions[index],
        targetSha256: installedSha256,
        archivePath,
      });
      profile.dependencies[row.name] = "file:" + archivePath;
    } else {
      const oldArchive = join(seed, "archives/cleverc2200-gea-dsh-prototype-0.0.216.tgz");
      await writeFile(oldArchive, "old GEA216");
      profile.dependencies[row.name] = "file:" + oldArchive;
    }
    await writeFile(
      join(f.profile, "node_modules", row.name, "package.json"),
      JSON.stringify({
        name: row.name,
        version: index < 2 ? versions[index] : "0.0.216",
      }),
    );
  }
  await writeFile(join(f.profile, "package.json"), JSON.stringify(profile));
  const receipt = {
    schema: 2,
    id,
    directory: operation,
    ...targets[0],
    targets,
    processIdentity: "old-gea216-host",
    stage: "pending-restart",
    startedAt: "2026-11-03T07:00:00.000Z",
    updatedAt: "2026-11-03T07:01:00.000Z",
    logs: ["original-pnpm.log"],
    diagnostic: "original diagnostic",
    completionProof: null,
    processes: [
      {
        pid,
        grouped: process.platform !== "win32",
        startIdentity: "observed",
        sawAlive: true,
      },
    ],
  };
  const original = JSON.stringify(receipt) + "\n";
  await writeFile(join(operation, "receipt.json"), original);
  if (process.platform === "win32") await writeWindowsJob(operation, receipt.processes[0]);
  await writeFile(
    join(f.profile, "gea/plugin-updates/latest.json"),
    JSON.stringify({ schema: 1, id }),
  );
  const userFiles = {
    "sessions/keep.json": "user session",
    "drafts/keep.json": "user draft",
  };
  for (const [file, bytes] of Object.entries(userFiles)) {
    await mkdir(join(f.profile, file, ".."), { recursive: true });
    await writeFile(join(f.profile, file), bytes);
  }
  return {
    ...f,
    seed,
    manifest: { packages },
    operation,
    receipt,
    original,
    userFiles,
    profileManifest: profile,
  };
}

async function writeWindowsJob(operation, observation, overrides = {}) {
  await writeFile(
    join(operation, "windows-job.json"),
    JSON.stringify({
      nonce: observation.startIdentity,
      pid: observation.pid,
      stage: "empty",
      exitCode: 0,
      ...overrides,
    }),
  );
}

async function windowsPendingCompanions(t, versions) {
  const f = await pendingCompanions(t, versions);
  windowsPlatform(t);
  const nonce = "00000000-1111-4222-8333-444444444444";
  f.receipt.processes = [
    { pid: process.pid, grouped: false, startIdentity: nonce, sawAlive: true },
  ];
  f.original = JSON.stringify(f.receipt) + "\n";
  await writeFile(join(f.operation, "receipt.json"), f.original);
  await writeWindowsJob(f.operation, f.receipt.processes[0]);
  return f;
}

function windowsPlatform(t) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
}

for (const scenario of [
  {
    title: "matching bundled companions",
    versions: ["0.1.51", "0.6.3-company.47", "0.0.219"],
    expectedTargets: [
      [companions[0].name, "0.1.51"],
      [companions[1].name, "0.6.3-company.47"],
      [name, "0.0.219"],
    ],
    backup: "before-0.0.216-to-0.0.219",
  },
  {
    title: "newer bundled companions",
    versions: ["0.1.53", "0.6.3-company.48", "0.0.221"],
    expectedTargets: [
      [companions[0].name, "0.1.53"],
      [companions[1].name, "0.6.3-company.48"],
      [name, "0.0.221"],
    ],
    backup: "before-0.0.216-to-0.0.221",
  },
  {
    title: "a completed Windows Job whose PID has been reused",
    windows: true,
    versions: ["0.1.56", "0.6.3-company.50", "0.0.224"],
    expectedTargets: [
      [companions[0].name, "0.1.56"],
      [companions[1].name, "0.6.3-company.50"],
      [name, "0.0.224"],
    ],
    backup: "before-0.0.216-to-0.0.224",
  },
])
  test(
    "startup repairs an older GEA behind a companion-only pending restart with " +
      scenario.title +
      " and leaves the complete suite awaiting actual observation",
    async (t) => {
      const f = await (scenario.windows ? windowsPendingCompanions : pendingCompanions)(
        t,
        scenario.versions,
      );
      const result = await refreshCompanyStartup({
        ...f,
        legacyData: f.home,
        install: async (options) => {
          await options.beforeInstall();
          assert.equal(options.strictPeers, true);
          assert.equal(options.activateNewBundles, false);
          assert.deepEqual(
            options.packages,
            f.manifest.packages.map((row) => join(f.seed, "archives", row.file)),
          );
          const after = structuredClone(f.profileManifest);
          for (const row of f.manifest.packages) {
            after.dependencies[row.name] =
              "file:" + join(f.home, "desktop-company-cache/archives", row.sha256, row.file);
            await writeFile(
              join(f.profile, "node_modules", row.name, "package.json"),
              JSON.stringify(row),
            );
          }
          await writeFile(join(f.profile, "package.json"), JSON.stringify(after));
          await options.complete({
            writeFileAtomic: writeFile,
            result: { logPath: "recovery-pnpm.log" },
          });
        },
      });
      assert.equal(result.refresh.status, "pending-restart-preserved");
      assert.equal(result.refresh.changed, true);
      assert.equal(result.cleanup, null);
      const journal = JSON.parse(await readFile(join(f.operation, "receipt.json")));
      assert.equal(journal.stage, "pending-restart");
      assert.equal(journal.completionProof, null);
      assert.equal(journal.processIdentity, f.receipt.processIdentity);
      assert.equal(journal.diagnostic, f.receipt.diagnostic);
      assert.deepEqual(journal.logs, ["original-pnpm.log", "recovery-pnpm.log"]);
      assert.deepEqual(
        journal.targets.map((row) => [row.packageName, row.targetVersion]),
        scenario.expectedTargets,
      );
      for (const row of journal.targets) {
        assert.equal(
          createHash("sha256")
            .update(await readFile(row.archivePath))
            .digest("hex"),
          row.targetSha256,
        );
        assert.equal(
          row.archivePath,
          join(f.profile, "gea/plugin-updates/cache", row.targetSha256 + ".tgz"),
        );
      }
      const backup = join(f.profile, "gea/bootstrap/gea-refresh", scenario.backup);
      assert.equal(await readFile(join(backup, "pending-update-receipt.json"), "utf8"), f.original);
      assert.equal(
        await readFile(join(backup, "package.json"), "utf8"),
        JSON.stringify(f.profileManifest),
      );
      for (const [file, bytes] of Object.entries(f.userFiles))
        assert.equal(await readFile(join(f.profile, file), "utf8"), bytes);
      assert.equal(
        await readFile(join(f.profile, "cordis.patch.yml"), "utf8"),
        "# user configuration\n- id: custom\n",
      );
      assert.equal(
        (
          await refreshCompanyStartup({
            ...f,
            install: () => assert.fail("must not reinstall"),
          })
        ).refresh.changed,
        false,
      );
    },
  );

test("pending restart recovery preserves unsupported suites and refuses unconfirmed writers or changed receipts", async (t) => {
  for (const variant of [
    "disabled",
    "custom",
    "newer",
    "same-gea",
    "different-suite",
    "active",
    "unobserved",
    "package-writer",
    "changed",
    "tampered",
  ]) {
    await t.test(variant, async (t) => {
      const f = await pendingCompanions(t);
      if (variant === "disabled") f.profileManifest.dsh.profile.bundles = [name];
      if (variant === "custom") f.profileManifest.dependencies[name] = "file:/custom/gea.tgz";
      if (["newer", "same-gea"].includes(variant))
        await writeFile(
          join(f.profile, "node_modules", name, "package.json"),
          JSON.stringify({
            name,
            version: variant === "newer" ? "0.0.220" : "0.0.219",
          }),
        );
      if (variant === "different-suite") f.manifest.packages[0].sha256 = "f".repeat(64);
      if (variant === "active") f.receipt.processes[0].pid = process.pid;
      if (variant === "unobserved") f.receipt.processes[0].sawAlive = false;
      if (variant === "tampered")
        await writeFile(f.receipt.targets[0].archivePath, "changed archive");
      await writeFile(join(f.profile, "package.json"), JSON.stringify(f.profileManifest));
      await writeFile(join(f.operation, "receipt.json"), JSON.stringify(f.receipt) + "\n");
      const original = await readFile(join(f.operation, "receipt.json"));
      if (variant === "package-writer") {
        await mkdir(join(f.profile, ".plugin-manager"));
        await writeFile(
          join(f.profile, ".plugin-manager/run.json"),
          JSON.stringify({ pid: process.pid, grouped: false }),
        );
      }
      let installs = 0;
      const task = refreshCompanyStartup({
        ...f,
        install: async (options) => {
          if (variant === "changed")
            await writeFile(
              join(f.operation, "receipt.json"),
              JSON.stringify({ ...f.receipt, diagnostic: "changed" }),
            );
          await options.beforeInstall();
          installs++;
          assert.fail("preserved or blocked recovery must not write packages");
        },
      });
      if (["active", "unobserved", "changed"].includes(variant))
        await assert.rejects(task, /GEA_REFRESH_UPDATE_PENDING/);
      else if (variant === "package-writer") await assert.rejects(task, /GEA_REFRESH_PROFILE_BUSY/);
      else if (variant === "tampered") await assert.rejects(task, /GEA_REFRESH_UPDATE_UNKNOWN/);
      else assert.equal((await task).refresh.changed, false);
      assert.equal(installs, 0);
      if (variant !== "changed")
        assert.deepEqual(await readFile(join(f.operation, "receipt.json")), original);
      await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh/receipt.json")), {
        code: "ENOENT",
      });
    });
  }
});

test("Windows startup refuses unconfirmed Jobs and rechecks writers and evidence under the install lock", async (t) => {
  for (const variant of [
    "missing",
    "malformed",
    "nonce",
    "pid",
    "running",
    "exit-code",
    "unobserved",
    "multiple-processes",
    "linked-operation",
    "package-writer",
    "changed-receipt",
    "changed-job",
  ])
    await t.test(variant, async (t) => {
      const f = await windowsPendingCompanions(t);
      const proof = join(f.operation, "windows-job.json");
      if (variant === "missing") await rm(proof);
      if (variant === "malformed") await writeFile(proof, "{");
      if (variant === "nonce")
        await writeWindowsJob(f.operation, f.receipt.processes[0], { nonce: "different" });
      if (variant === "pid")
        await writeWindowsJob(f.operation, f.receipt.processes[0], { pid: process.pid + 1 });
      if (variant === "running")
        await writeWindowsJob(f.operation, f.receipt.processes[0], { stage: "running" });
      if (variant === "exit-code")
        await writeWindowsJob(f.operation, f.receipt.processes[0], { exitCode: null });
      if (variant === "unobserved") f.receipt.processes[0].sawAlive = false;
      if (variant === "multiple-processes")
        f.receipt.processes.push({ ...f.receipt.processes[0], pid: process.pid + 1 });
      const original = JSON.stringify(f.receipt) + "\n";
      await writeFile(join(f.operation, "receipt.json"), original);
      if (variant === "linked-operation") {
        const outside = join(f.home, "outside-operation");
        await rename(f.operation, outside);
        await symlink(outside, f.operation, "junction");
      }
      let writes = 0;
      await assert.rejects(
        refreshCompanyStartup({
          ...f,
          legacyData: f.home,
          install: async (options) => {
            if (variant === "package-writer") {
              await mkdir(join(f.profile, ".plugin-manager"));
              await writeFile(
                join(f.profile, ".plugin-manager/run.json"),
                JSON.stringify({ pid: process.pid, grouped: false }),
              );
            }
            if (variant === "changed-receipt")
              await writeFile(
                join(f.operation, "receipt.json"),
                JSON.stringify({ ...f.receipt, diagnostic: "changed under lock" }),
              );
            if (variant === "changed-job")
              await writeWindowsJob(f.operation, f.receipt.processes[0], { stage: "running" });
            await options.beforeInstall();
            writes++;
          },
        }),
        variant === "package-writer" ? /GEA_REFRESH_PROFILE_BUSY/ : /GEA_REFRESH_UPDATE_PENDING/,
      );
      assert.equal(writes, 0);
      if (variant !== "changed-receipt")
        assert.equal(await readFile(join(f.operation, "receipt.json"), "utf8"), original);
      await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh/receipt.json")), {
        code: "ENOENT",
      });
    });
});

test("failed pending recovery retains the original evidence and blocks automatic retries even if receipt commit failed", async (t) => {
  for (const variant of ["install", "receipt-commit", "rebound-source"])
    await t.test(variant, async (t) => {
      const f = await pendingCompanions(t);
      await assert.rejects(
        refreshCompanyStartup({
          ...f,
          install: async (options) => {
            await options.beforeInstall();
            if (variant === "install") throw Error("package manager failed");
            const after = structuredClone(f.profileManifest);
            for (const row of f.manifest.packages) {
              after.dependencies[row.name] =
                variant === "rebound-source"
                  ? "file:/custom/gea.tgz"
                  : "file:" + join(f.home, "desktop-company-cache/archives", row.sha256, row.file);
              await writeFile(
                join(f.profile, "node_modules", row.name, "package.json"),
                JSON.stringify(row),
              );
            }
            await writeFile(join(f.profile, "package.json"), JSON.stringify(after));
            await options.complete({
              writeFileAtomic:
                variant === "receipt-commit"
                  ? async () => {
                      throw Error("receipt commit failed");
                    }
                  : writeFile,
            });
          },
        }),
        /package manager failed|receipt commit failed|GEA_REFRESH_PROFILE_NOT_PRESERVED/,
      );
      assert.equal(await readFile(join(f.operation, "receipt.json"), "utf8"), f.original);
      const receipt = JSON.parse(
        await readFile(join(f.profile, "gea/bootstrap/gea-refresh/receipt.json")),
      );
      assert.equal(receipt.status, "failed");
      assert.equal(
        await readFile(join(receipt.backup, "pending-update-receipt.json"), "utf8"),
        f.original,
      );
      for (const [file, bytes] of Object.entries(f.userFiles))
        assert.equal(await readFile(join(f.profile, file), "utf8"), bytes);
      await assert.rejects(
        refreshCompanyStartup({
          ...f,
          install: () => assert.fail("must not retry"),
        }),
        /GEA_REFRESH_RECOVERY_REQUIRED/,
      );
    });
});

test("startup completes the accepted cached suite after partial installation and preserves disabled plugins", async (t) => {
  const child = spawn(process.execPath, ["-e", ""], {
    detached: process.platform !== "win32",
  });
  const pid = child.pid;
  await once(child, "exit");
  for (const variant of [
    "success",
    "failure",
    "partial",
    "tampered",
    "active",
    "unobserved",
    "windows-reused-pid",
    "windows-job-changed",
  ])
    await t.test(variant, async (t) => {
      const windows = variant.startsWith("windows-");
      if (windows) windowsPlatform(t);
      const f = await fixture(t);
      const id = "00000000-0000-4000-8000-000000000000";
      const operation = join(f.profile, "gea/plugin-updates/operations", id);
      const cache = join(f.profile, "gea/plugin-updates/cache");
      await mkdir(operation, { recursive: true });
      await mkdir(cache, { recursive: true });
      const targets = [];
      for (const [index, row] of bundledSuite.entries()) {
        const bytes = Buffer.from(row.name + " accepted " + row.version);
        const targetSha256 = createHash("sha256").update(bytes).digest("hex");
        const archivePath = join(cache, targetSha256 + ".tgz");
        await writeFile(archivePath, bytes);
        targets.push({
          packageName: row.name,
          targetVersion: row.version,
          targetSha256,
          archivePath,
        });
        if (index === 0)
          await rm(join(f.profile, "node_modules", row.name), {
            recursive: true,
          });
      }
      const profile = structuredClone(current);
      profile.dsh.profile.bundles = [name, "my-plugin"];
      await writeFile(join(f.profile, "package.json"), JSON.stringify(profile));
      const patch = await readFile(join(f.profile, "cordis.patch.yml"));
      await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
      const receipt = {
        schema: 2,
        id,
        directory: operation,
        ...targets[0],
        targets,
        processIdentity: "old-host",
        stage: "unknown",
        diagnostic: "PACKAGE_WRITERS_UNCONFIRMED",
        logs: ["original-pnpm.log"],
        completionProof: null,
        processes: [
          {
            pid: windows || variant === "active" ? process.pid : pid,
            grouped: process.platform !== "win32",
            startIdentity: "observed",
            sawAlive: variant !== "unobserved",
          },
        ],
      };
      const original = JSON.stringify(receipt);
      await writeFile(join(operation, "receipt.json"), original);
      if (process.platform === "win32")
        await writeWindowsJob(operation, receipt.processes[0], {
          stage: variant === "active" ? "running" : "empty",
          exitCode: windows ? 1 : 0,
        });
      if (variant === "tampered") await writeFile(targets[0].archivePath, "changed");
      let installs = 0;
      const options = {
        ...f,
        legacyData: f.home,
        install: async (options) => {
          if (variant === "windows-job-changed")
            await writeWindowsJob(operation, receipt.processes[0], { stage: "running" });
          await options.beforeInstall();
          installs++;
          assert.deepEqual(
            options.packages,
            targets.map((row) => row.archivePath),
          );
          assert.equal(options.seed, undefined);
          assert.equal(options.activateNewBundles, false);
          if (variant === "failure") throw Error("GEA_COMPANY_INSTALL_FAILED: retry-pnpm.log");
          const after = structuredClone(profile);
          for (const target of targets) {
            after.dependencies[target.packageName] = "file:" + target.archivePath;
            await mkdir(join(f.profile, "node_modules", target.packageName), {
              recursive: true,
            });
            await writeFile(
              join(f.profile, "node_modules", target.packageName, "package.json"),
              JSON.stringify({
                name: target.packageName,
                version:
                  variant === "partial" && target.packageName === name
                    ? "0.0.130"
                    : target.targetVersion,
              }),
            );
          }
          await writeFile(join(f.profile, "package.json"), JSON.stringify(after));
          await options.complete({
            writeFileAtomic: writeFile,
            result: { logPath: "retry-pnpm.log" },
          });
        },
      };
      if (!["success", "windows-reused-pid"].includes(variant)) {
        await assert.rejects(
          refreshCompanyStartup(options),
          variant === "failure"
            ? /GEA_COMPANY_INSTALL_FAILED/
            : variant === "partial"
              ? /GEA_REFRESH_PROFILE_NOT_PRESERVED/
              : variant === "tampered"
                ? /GEA_REFRESH_UPDATE_UNKNOWN/
                : /GEA_REFRESH_UPDATE_PENDING/,
        );
        assert.equal(installs, ["failure", "partial"].includes(variant) ? 1 : 0);
        assert.equal(await readFile(join(operation, "receipt.json"), "utf8"), original);
        return;
      }
      const result = await refreshCompanyStartup(options);
      assert.equal(result.refresh.status, "pending-restart-preserved");
      assert.equal(result.refresh.changed, true);
      assert.equal(result.cleanup, null);
      const saved = JSON.parse(await readFile(join(operation, "receipt.json")));
      assert.equal(saved.stage, "pending-restart");
      assert.equal(saved.processIdentity, "old-host");
      assert.deepEqual(saved.targets, targets);
      assert.deepEqual(saved.logs, ["original-pnpm.log", "retry-pnpm.log"]);
      const after = JSON.parse(await readFile(join(f.profile, "package.json")));
      assert.deepEqual(after.dsh, profile.dsh);
      assert.equal(after.dependencies["my-plugin"], "1.0.0");
      assert.deepEqual(await readFile(join(f.profile, "cordis.patch.yml")), patch);
      assert.equal((await refreshCompanyStartup(options)).refresh.changed, false);
      assert.equal(installs, 1);
    });
});

test("interrupted updates, unknown receipts and active writers still block startup refresh", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  const operation = join(f.profile, "gea/plugin-updates/operations", id);
  await mkdir(operation, { recursive: true });
  await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
  for (const stage of ["accepted", "installing", "verifying", "restoring", "unknown"]) {
    await writeFile(join(operation, "receipt.json"), JSON.stringify({ id, stage }));
    await assert.rejects(
      refreshBundledCompanySuite({
        ...f,
        install: () => assert.fail("must not install"),
      }),
      /GEA_REFRESH_UPDATE_PENDING/,
    );
  }
  await writeFile(
    join(operation, "receipt.json"),
    JSON.stringify({ id: "different", stage: "pending-restart" }),
  );
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: () => assert.fail("must not install"),
    }),
    /GEA_REFRESH_UPDATE_UNKNOWN/,
  );
  await writeFile(
    join(operation, "receipt.json"),
    JSON.stringify({ id, stage: "pending-restart" }),
  );
  await mkdir(join(f.profile, ".plugin-manager"));
  await writeFile(join(f.profile, ".plugin-manager/run.json"), "{}");
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: () => assert.fail("must not install"),
    }),
    /GEA_REFRESH_PROFILE_BUSY/,
  );
});

test("an update that starts after startup admission is still blocked under the install lock", async (t) => {
  const f = await fixture(t);
  const id = "00000000-0000-4000-8000-000000000000";
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: async (options) => {
        const operation = join(f.profile, "gea/plugin-updates/operations", id);
        await mkdir(operation, { recursive: true });
        await writeFile(join(f.profile, "gea/plugin-updates/latest.json"), JSON.stringify({ id }));
        await writeFile(
          join(operation, "receipt.json"),
          JSON.stringify({ id, stage: "pending-restart" }),
        );
        await options.beforeInstall();
        assert.fail("must reject before package-manager writes");
      },
    }),
    /GEA_REFRESH_UPDATE_PENDING/,
  );
  await assert.rejects(access(join(f.profile, "gea/bootstrap/gea-refresh")), {
    code: "ENOENT",
  });
});

test("failed refreshes retain their backup and require recovery instead of retrying at next startup", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        throw Error("package manager failed");
      },
    }),
    /package manager failed/,
  );
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: () => assert.fail("must not retry"),
    }),
    /GEA_REFRESH_RECOVERY_REQUIRED/,
  );
  const receipt = JSON.parse(
    await readFile(join(f.profile, "gea/bootstrap/gea-refresh/receipt.json")),
  );
  assert.equal(receipt.status, "failed");
  await access(join(f.profile, "gea/bootstrap/gea-refresh/before-0.0.130-to-0.0.166/package.json"));
});

import { createHash } from "node:crypto";
import { prepareCompanyArchives } from "./company-archives.mjs";

async function legacyArchives(t) {
  const f = await fixture(t);
  const seed = join(f.home, "new-client/company-seed");
  const old = join(f.home, "removed-client/company-seed/archives");
  const root = join(f.home, "app");
  const yaml = join(root, "dsh/node_modules/yaml");
  await mkdir(yaml, { recursive: true });
  await writeFile(join(yaml, "package.json"), '{"main":"index.cjs"}');
  await writeFile(
    join(yaml, "index.cjs"),
    "exports.parse = JSON.parse; exports.stringify = JSON.stringify;",
  );
  await mkdir(join(seed, "archives"), { recursive: true });
  const versions = {
    "@cleverc2200/dsh-agent-workbench": ["0.1.8", "0.1.17"],
    "dsh-agent-manage": ["0.6.3-company.15", "0.6.3-company.23"],
    [name]: ["0.0.159", "0.0.177"],
  };
  const dependencies = {};
  const packages = [];
  for (const [packageName, [previous, next]] of Object.entries(versions)) {
    const prefix = packageName.replace(/^@/, "").replace("/", "-");
    dependencies[packageName] = "file:" + join(old, prefix + "-" + previous + ".tgz");
    await mkdir(join(f.profile, "node_modules", packageName), {
      recursive: true,
    });
    await writeFile(
      join(f.profile, "node_modules", packageName, "package.json"),
      JSON.stringify({ name: packageName, version: previous }),
    );
    const bytes = Buffer.from(packageName + "@" + next);
    const file = prefix + "-" + next + ".tgz";
    await writeFile(join(seed, "archives", file), bytes);
    packages.push({
      name: packageName,
      version: next,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const genui = "@changfenhuang/dsh-genui";
  dependencies[genui] = "file:" + join(old, "dsh-genui-0.11.3.tgz");
  await mkdir(join(f.profile, "node_modules", genui), { recursive: true });
  await writeFile(
    join(f.profile, "node_modules", genui, "package.json"),
    JSON.stringify({ name: genui, version: "0.11.3" }),
  );
  const genuiBytes = Buffer.from("locked original GenUI archive");
  await mkdir(old, { recursive: true });
  const oldGenui = join(old, "dsh-genui-0.11.3.tgz");
  await writeFile(oldGenui, genuiBytes);
  const lock = {
    importers: {
      ".": { dependencies: { [genui]: { specifier: dependencies[genui] } } },
    },
    packages: {
      [genui + "@" + dependencies[genui]]: {
        resolution: {
          tarball: dependencies[genui],
          integrity: "sha512-" + createHash("sha512").update(genuiBytes).digest("base64"),
        },
      },
    },
  };
  await writeFile(join(f.profile, "pnpm-lock.yaml"), JSON.stringify(lock));
  await writeFile(join(f.profile, "package.json"), JSON.stringify({ ...current, dependencies }));
  const manifest = { packages };
  await writeFile(join(seed, "manifest.json"), JSON.stringify(manifest));
  return {
    ...f,
    seed,
    root,
    manifest,
    genuiBytes,
    oldGenui,
    packages: [join(seed, "archives", packages[2].file)],
  };
}

test("removed client archive references move to persistent storage and preserve the exact locked optional GenUI", async (t) => {
  const f = await legacyArchives(t);
  const original = await readFile(join(f.profile, "package.json"));
  const result = await prepareCompanyArchives(f);
  assert.equal(result.packages.length, 4);
  assert.equal(result.replacements.length, 4);
  assert.equal(
    result.replacements.find((row) => row.name === "@changfenhuang/dsh-genui").version,
    "0.11.3",
  );
  for (const path of result.packages)
    assert.ok(path.startsWith(join(f.home, "desktop-company-cache/archives")));
  await rm(join(f.home, "new-client"), { recursive: true });
  for (const path of result.packages) await access(path);
  assert.deepEqual(await readFile(join(f.profile, "package.json")), original);
});

test("legacy archive recovery rejects changed bytes and refuses to downgrade a newer company plugin", async (t) => {
  for (const variant of ["integrity", "downgrade"]) {
    const f = await legacyArchives(t);
    const original = await readFile(join(f.profile, "package.json"));
    if (variant === "integrity") await writeFile(f.oldGenui, "changed");
    if (variant === "downgrade")
      await writeFile(
        join(f.profile, "node_modules/@cleverc2200/dsh-agent-workbench/package.json"),
        JSON.stringify({
          name: "@cleverc2200/dsh-agent-workbench",
          version: "0.1.20",
        }),
      );
    await assert.rejects(
      prepareCompanyArchives(f),
      variant === "integrity"
        ? /GEA_LEGACY_ARCHIVE_INTEGRITY_CHANGED/
        : /GEA_LEGACY_ARCHIVE_IDENTITY_CHANGED/,
    );
    assert.deepEqual(await readFile(join(f.profile, "package.json")), original);
  }
});

test("only the logged pre-write missing company archive failure may resume and the original failed receipt is retained", async (t) => {
  for (const variant of [
    "known",
    "workbench",
    "manage",
    "gea",
    "changed",
    "other",
    "retried",
    "unrelated",
    "nonseed",
    "custom-dependency",
  ]) {
    const f = await legacyArchives(t);
    const directory = join(f.profile, "gea/bootstrap/gea-refresh");
    const backup = join(directory, "before-0.0.159-to-0.0.177");
    const log = join(f.profile, ".plugin-manager/logs/operation-known/pnpm.log");
    await mkdir(backup, { recursive: true });
    await mkdir(join(f.profile, ".plugin-manager/logs/operation-known"), {
      recursive: true,
    });
    const profile = JSON.parse(await readFile(join(f.profile, "package.json")));
    const packageName =
      {
        workbench: "@cleverc2200/dsh-agent-workbench",
        manage: "dsh-agent-manage",
        gea: name,
      }[variant] ?? "@changfenhuang/dsh-genui";
    let oldArchive = profile.dependencies[packageName].slice(5);
    if (variant === "unrelated") oldArchive = join(f.home, "other/dsh-genui-0.11.3.tgz");
    if (variant === "nonseed") {
      oldArchive = join(f.home, "custom/dsh-genui-0.11.3.tgz");
      profile.dependencies[packageName] = "file:" + oldArchive;
    }
    if (variant === "custom-dependency") {
      oldArchive = join(f.home, "removed-client/company-seed/archives/user-plugin-1.0.0.tgz");
      profile.dependencies["user-plugin"] = "file:" + oldArchive;
    }
    await writeFile(join(f.profile, "package.json"), JSON.stringify(profile));
    await writeFile(
      log,
      variant === "other"
        ? "[ERR_PNPM_OTHER] unexpected failure\n"
        : "Progress: resolved 4\n[ENOENT] ENOENT: no such file or directory, open '" +
            oldArchive +
            "'\n",
    );
    for (const file of ["package.json", "cordis.patch.yml", "pnpm-lock.yaml"])
      await writeFile(join(backup, file), await readFile(join(f.profile, file)));
    const failed = JSON.stringify({
      status: "failed",
      changed: false,
      from: "0.0.159",
      to: "0.0.177",
      diagnostic: "GEA_COMPANY_INSTALL_FAILED: " + log,
    });
    await writeFile(join(directory, "receipt.json"), failed);
    if (variant === "changed")
      await writeFile(join(f.profile, "cordis.patch.yml"), "changed by user");
    if (variant === "retried") await writeFile(join(backup, "failed-receipt.json"), failed);
    const task = refreshBundledCompanySuite({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        for (const row of f.manifest.packages)
          await writeFile(
            join(f.profile, "node_modules", row.name, "package.json"),
            JSON.stringify({ name: row.name, version: row.version }),
          );
        await options.complete({ writeFileAtomic: writeFile });
      },
    });
    if (["known", "workbench", "manage", "gea"].includes(variant)) {
      assert.equal((await task).status, "completed");
      assert.equal(await readFile(join(backup, "failed-receipt.json"), "utf8"), failed);
    } else {
      await assert.rejects(task, /GEA_REFRESH_RECOVERY_REQUIRED/);
      assert.equal(await readFile(join(directory, "receipt.json"), "utf8"), failed);
    }
  }
});

test("the same bundled GEA version still repairs old installer archive references once", () => {
  const manifest = {
    ...current,
    dependencies: {
      ...current.dependencies,
      "@changfenhuang/dsh-genui":
        "file:D:/Program Files/DSH/resources/company-seed/archives/dsh-genui-0.11.3.tgz",
    },
  };
  assert.equal(planBundledCompanyRefresh(manifest, bundledSuite, bundledSuite).status, "ready");
  assert.equal(
    planBundledCompanyRefresh(current, bundledSuite, bundledSuite).status,
    "current-company-suite-preserved",
  );
  assert.equal(
    planBundledCompanyRefresh(
      manifest,
      installedSuite({ ...bundled, version: "0.0.167" }),
      bundledSuite,
    ).status,
    "newer-company-suite-preserved",
  );
});

test("desktop replacement refreshes the whole bundled suite when GEA is already current", async (t) => {
  const f = await fixture(t);
  const versions = [
    ["@cleverc2200/dsh-agent-workbench", "0.1.25", "0.1.28"],
    ["dsh-agent-manage", "0.6.3-company.28", "0.6.3-company.30"],
    [name, "0.0.187", "0.0.187"],
  ];
  const before = structuredClone(current);
  before.dsh.profile.bundles = versions.map(([name]) => name);
  for (const [packageName, version] of versions) {
    before.dependencies[packageName] = "file:/persistent-cache/" + version + ".tgz";
    await mkdir(join(f.profile, "node_modules", packageName), {
      recursive: true,
    });
    await writeFile(
      join(f.profile, "node_modules", packageName, "package.json"),
      JSON.stringify({ name: packageName, version }),
    );
  }
  await writeFile(join(f.profile, "package.json"), JSON.stringify(before));
  const packages = versions.map(([name, , version], index) => ({
    name,
    version,
    file: "company-" + index + ".tgz",
  }));
  const result = await refreshBundledCompanySuite({
    ...f,
    manifest: { packages },
    install: async (options) => {
      assert.deepEqual(
        options.packages,
        packages.map((row) => "/bundled/archives/" + row.file),
      );
      await options.beforeInstall();
      const after = structuredClone(before);
      for (const row of packages) {
        after.dependencies[row.name] = "file:/bundled/archives/" + row.file;
        await writeFile(
          join(f.profile, "node_modules", row.name, "package.json"),
          JSON.stringify({ name: row.name, version: row.version }),
        );
      }
      await writeFile(join(f.profile, "package.json"), JSON.stringify(after));
      await options.complete({ writeFileAtomic: writeFile });
    },
  });
  assert.equal(result.status, "completed");
  for (const row of packages)
    assert.equal(
      JSON.parse(await readFile(join(f.profile, "node_modules", row.name, "package.json"))).version,
      row.version,
    );
  assert.equal(
    await readFile(join(f.profile, "cordis.patch.yml"), "utf8"),
    "# user configuration\n- id: custom\n",
  );
  assert.equal(
    (
      await refreshBundledCompanySuite({
        ...f,
        manifest: { packages },
        install: () => assert.fail("current suite must not reinstall"),
      })
    ).changed,
    false,
  );
});

test("one disabled, custom or newer companion preserves the complete existing suite", () => {
  for (const companion of companions) {
    const disabled = structuredClone(current);
    disabled.dsh.profile.bundles = disabled.dsh.profile.bundles.filter(
      (name) => name !== companion.name,
    );
    assert.equal(
      planBundledCompanyRefresh(disabled, installedSuite(), bundledSuite).status,
      "disabled-company-profile-preserved",
    );
    const custom = structuredClone(current);
    custom.dependencies[companion.name] = "link:/development";
    assert.equal(
      planBundledCompanyRefresh(custom, installedSuite(), bundledSuite).status,
      "custom-company-profile-preserved",
    );
    const newer = installedSuite().map((row) =>
      row.name === companion.name
        ? {
            ...row,
            version: companion.name === "dsh-agent-manage" ? "0.6.3-company.31" : "0.1.29",
          }
        : row,
    );
    assert.equal(
      planBundledCompanyRefresh(current, newer, bundledSuite).status,
      "newer-company-suite-preserved",
    );
  }
});

test("a partial companion installation cannot publish a successful suite receipt", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    refreshBundledCompanySuite({
      ...f,
      install: async (options) => {
        await options.beforeInstall();
        await writeFile(
          join(f.profile, "node_modules", name, "package.json"),
          JSON.stringify(bundled),
        );
        await options.complete({ writeFileAtomic: writeFile });
      },
    }),
    /GEA_REFRESH_PROFILE_NOT_PRESERVED/,
  );
  const receipt = JSON.parse(
    await readFile(join(f.profile, "gea/bootstrap/gea-refresh/receipt.json")),
  );
  assert.equal(receipt.status, "failed");
});
