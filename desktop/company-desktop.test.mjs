import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompanyInstallation } from "./company-installation.mjs";
import { startCompanyDesktop } from "./company-desktop.mjs";
import { companyPackageNames } from "./company-archives.mjs";

async function trial(t) {
  const profile = await mkdtemp(join(tmpdir(), "gea company desktop "));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const coreHead = "b".repeat(40);
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      dependencies: Object.fromEntries(companyPackageNames.map((name) => [name, "1.0.0"])),
    }),
  );
  await writeFile(join(profile, "saved-session"), "history and draft");
  for (const name of companyPackageNames) {
    await mkdir(join(profile, "node_modules", name), { recursive: true });
    await writeFile(
      join(profile, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
  }
  const installation = new CompanyInstallation(profile, coreHead);
  await installation.initialize();
  await installation.beginBoot();
  await installation.store.confirmBoot();
  await installation.prepare("candidate", async (stage) => {
    for (const name of companyPackageNames)
      await writeFile(
        join(stage, "node_modules", name, "package.json"),
        JSON.stringify({ name, version: "2.0.0" }),
      );
  });
  await installation.beginBoot();
  const app = Object.assign(new EventEmitter(), {
    relaunches: 0,
    quits: 0,
    relaunch() {
      this.relaunches++;
    },
    quit() {
      this.quits++;
      this.emit("before-quit");
    },
    whenReady: async () => {},
    getPath: () => profile,
  });
  t.after(() => app.emit("before-quit"));
  const options = {
    app,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    root: "unused",
    resources: "unused",
    loadOfficial() {},
    runBootstrap: async () => ({ schema: 1, profile, coreHead, graphId: "candidate", trial: true }),
    trialTimeoutMs: 500,
  };
  return { profile, installation, app, options };
}

test("the actual company desktop coordinator restores the verified selection when trial loading throws", async (t) => {
  const f = await trial(t);
  const result = await startCompanyDesktop({
    ...f.options,
    loadOfficial() {
      throw Error("HOST_START_FAILED");
    },
  });
  assert.equal(result.status, "started");
  assert.equal(f.app.relaunches, 1);
  assert.equal(f.app.quits, 1);
  assert.equal((await f.installation.beginBoot()).id, "baseline");
  assert.equal(await readFile(join(f.profile, "saved-session"), "utf8"), "history and draft");
});

test("a confirmed Host and client prevent rollback, while a missing startup confirmation causes rollback", async (t) => {
  for (const confirmed of [true, false])
    await t.test(String(confirmed), async (t) => {
      const f = await trial(t);
      await startCompanyDesktop(f.options);
      if (confirmed) await f.installation.store.confirmBoot("candidate");
      await new Promise((resolve) => setTimeout(resolve, 850));
      assert.equal(f.app.relaunches, confirmed ? 0 : 1);
      assert.equal(
        (await f.installation.store.status()).active,
        confirmed ? "candidate" : "baseline",
      );
    });
});

test("bootstrap failure starts a verified graph through the recovery entry without rerunning installation", async (t) => {
  const f = await trial(t);
  const calls = [];
  await startCompanyDesktop({
    ...f.options,
    runBootstrap: async (recover) => {
      calls.push(recover);
      if (!recover) throw Error("INSTALL_INTERRUPTED");
      await f.installation.rollback("BOOTSTRAP_FAILED");
      await f.installation.beginBoot();
      return {
        schema: 1,
        profile: f.profile,
        coreHead: f.installation.coreHead,
        graphId: "baseline",
        trial: false,
      };
    },
  });
  assert.deepEqual(calls, [false, true]);
  assert.equal(f.app.relaunches, 0);
  assert.equal((await f.installation.store.status()).active, "baseline");
});
