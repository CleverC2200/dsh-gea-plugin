import { installPnpmConsumerLayout } from "./fixtures/plugin-updates/pnpm-profile.mjs";
import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { controllerFixture, waitForStage } from "./fixtures/plugin-updates/profile.mjs";
import { prepareWindowsFileCommit } from "../src/host/plugin-update-windows.ts";
import { configureStalledPnpmRegistry } from "./fixtures/plugin-updates/stalled-registry.mjs";
import { downloadRegistry } from "./fixtures/plugin-updates/download-registry.mjs";
if (
  process.platform !== "win32" ||
  !process.env.GEA_WINDOWS_RUNTIME ||
  !process.env.GEA_WINDOWS_CONTROLLER
)
  throw Error("WINDOWS_NATIVE_INPUTS_REQUIRED");
const { createPluginUpdateController } = await import(
  pathToFileURL(process.env.GEA_WINDOWS_CONTROLLER)
);
const anchor = join(process.env.GEA_WINDOWS_RUNTIME, "dsh/package.json");

if (process.env.GEA_WINDOWS_RESTART_UPDATE)
  test("Windows restart coordinator unlocks after the Host becomes idle without a desktop receipt", async (t) => {
    const { DesktopRestartUpdate } = await import(
      pathToFileURL(process.env.GEA_WINDOWS_RESTART_UPDATE)
    );
    const f = await controllerFixture(t, { sourceFailure: "network" });
    const controller = createPluginUpdateController({
      ...f.options,
      runtimeDirectory: join(f.dir, "gea/plugin-updates"),
    });
    t.after(() => controller.dispose());
    await controller.initialize();
    const desktopVersion = process.env.GEA_DESKTOP_VERSION;
    process.env.GEA_DESKTOP_VERSION = "0.2.0-rc.2.20261123.1";
    t.after(() => {
      if (desktopVersion === undefined) delete process.env.GEA_DESKTOP_VERSION;
      else process.env.GEA_DESKTOP_VERSION = desktopVersion;
    });
    const target = "0.2.0-rc.2.20261124.1";
    let lostStatus = true;
    const tasks = [],
      window = [];
    const host = {
      updateTasks: async (action) => {
        tasks.push(action);
        return false;
      },
      updateOperation: async ({ action }) => {
        try {
          if (action === "desktop-prepare") await controller.prepareDesktop(target);
          else if (action === "desktop-cancel") await controller.cancelDesktop();
          else if (action === "plugins-status") {
            if (lostStatus) {
              lostStatus = false;
              return { ok: false, error: { code: "host-unavailable" } };
            }
            return { ok: true, value: controller.operationStatus() };
          } else assert.fail(action);
          return { ok: true, value: {} };
        } catch (error) {
          return { ok: false, error: { code: error.message } };
        }
      },
    };
    const coordinator = new DesktopRestartUpdate({
      host: () => host,
      recoverLockedHost: async () => host,
      state: () => ({ phase: "available", version: target }),
      block: (blocked) => window.push(blocked),
      progress: () => {},
      download: () => assert.fail("unexpected native download"),
      install: () => assert.fail("unexpected native installation"),
    });
    await assert.rejects(
      coordinator.start({ kind: "desktop", version: target }),
      /preparation failed/,
    );
    assert.equal(controller.operationStatus().state, "idle");
    assert.equal(await controller.companyStatus(), null);
    assert.deepEqual(window, [true]);
    await coordinator.recover();
    assert.deepEqual(tasks, ["lock", "unlock"]);
    assert.deepEqual(window, [true, false]);
    assert.equal(coordinator.active, false);
  });
for (const mode of [
  "success",
  "pnpm",
  "pnpm-stalled-registry",
  "pnpm-network-transient",
  "pnpm-network-partial",
  "fail-after-write",
  "orphan",
]) {
  test("Windows official installer with native Job: " + mode, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "GEA native windows "));
    let controller;
    const cleanup = [];
    t.after(async () => {
      await controller?.dispose();
      for (const action of cleanup) await action();
      await rm(root, { recursive: true, force: true });
    });
    const fileCommit = await prepareWindowsFileCommit(join(root, "platform"), anchor, "0.2.0-rc.2");
    const f = await controllerFixture(
      { after: (action) => cleanup.push(action) },
      {
        mode,
        fileCommit,
        managed: !mode.startsWith("pnpm"),
        ...(mode.startsWith("pnpm-network")
          ? {
              releaseDependencies: {
                "@cleverc2200/gea-dsh-prototype": { "fixture-network-dependency": "1.0.0" },
              },
            }
          : {}),
      },
    );
    await symlink(
      join(process.env.GEA_WINDOWS_RUNTIME, "dsh/node_modules"),
      join(f.root, "anchor/node_modules"),
      "junction",
    );
    let stalledRegistry, networkRegistry;
    if (mode.startsWith("pnpm")) {
      await installPnpmConsumerLayout(f, "^3.0.0");
      f.profile.packageManager.args = [process.env.GEA_PLUGIN_UPDATE_PNPM];
      if (mode === "pnpm-stalled-registry")
        stalledRegistry = await configureStalledPnpmRegistry(t, f.profile);
      if (mode.startsWith("pnpm-network")) {
        networkRegistry = await downloadRegistry(
          t,
          f.root,
          mode.endsWith("partial") ? "partial" : "transient",
        );
        f.profile.packageManager.args.push("--registry=" + networkRegistry.origin);
      }
    }
    f.profile.packageManager.env.FIXTURE_UPDATE_RUNTIME = f.options.runtimeDirectory;
    f.options.fileCommit = fileCommit;
    f.options.idleTimeoutMs =
      mode === "orphan" ? 1500 : mode === "pnpm-network-partial" ? 3000 : 10000;
    f.options.quiescenceWaitMs = 1500;
    controller = createPluginUpdateController(f.options);
    controller.subscribe((snapshot) => {
      if (mode === "pnpm" && snapshot.operation?.stage === "verifying")
        console.error(
          "WINDOWS_FIXTURE_MANIFEST",
          JSON.stringify({
            manifest: JSON.parse(readFileSync(join(f.dir, "package.json"), "utf8")),
            archive: snapshot.operation.archivePath,
          }),
        );
    });
    await controller.initialize();
    await controller.check();
    const item = controller
      .snapshot()
      .items.find((x) => x.packageName === "@cleverc2200/gea-dsh-prototype");
    assert.equal(item.state, "available");
    await controller.submit({ packageName: item.packageName, planId: item.planId });
    const result = await waitForStage(controller, ["pending-restart", "failed", "unknown"], 30000);
    const expected =
      mode !== "pnpm-network-partial" && (mode === "success" || mode.startsWith("pnpm"))
        ? "pending-restart"
        : "failed";
    if (result.stage !== expected) {
      for (const log of result.logs)
        console.error("WINDOWS_FIXTURE_LOG", mode, await readFile(log, "utf8"));
    }
    assert.equal(result.stage, expected, JSON.stringify(result));
    assert(result.processes.some((x) => x.grouped === false && x.sawAlive && x.startIdentity));
    if (stalledRegistry) {
      assert.deepEqual(stalledRegistry.requests, []);
      const proof = JSON.parse(await readFile(join(result.directory, "windows-job.json"), "utf8"));
      assert.equal(proof.stage, "empty");
      assert.equal(proof.exitCode, 0);
      assert.equal(proof.nonce, result.processes[0].startIdentity);
    }
    if (!mode.startsWith("pnpm")) {
      const installing = JSON.parse(
        await readFile(join(f.evidence, "installing-receipt.json"), "utf8"),
      );
      assert.equal(installing.stage, "installing");
      assert.deepEqual(installing.processes, result.processes);
      assert.equal(installing.id, result.id);
    }
    if (mode === "fail-after-write") assert.equal(result.diagnostic, "PACKAGE_INSTALL_FAILED");
    if (networkRegistry) {
      assert(networkRegistry.requests.includes("/" + networkRegistry.name));
      assert.equal(
        JSON.parse(
          await readFile(join(f.dir, "node_modules", item.packageName, "package.json"), "utf8"),
        ).version,
        "3.0.0",
      );
      if (mode === "pnpm-network-partial") {
        assert.equal(result.diagnostic, "PACKAGE_INSTALL_TIMEOUT");
        assert.equal((await f.installation.store.status()).pending ?? null, null);
        networkRegistry.recover();
        await controller.check();
        const retry = controller.snapshot().items.find((row) => row.planId);
        await controller.submit({ packageName: retry.packageName, planId: retry.planId });
        const retried = await waitForStage(
          controller,
          ["pending-restart", "failed", "unknown"],
          30000,
        );
        assert.equal(retried.stage, "pending-restart", JSON.stringify(retried));
        assert.notEqual(retried.id, result.id);
      }
    }
    if (mode === "orphan") {
      const pid = Number(await readFile(join(f.evidence, "orphan-pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    const receipt = JSON.parse(
      await readFile(
        join(f.options.runtimeDirectory, "operations", result.id, "receipt.json"),
        "utf8",
      ),
    );
    assert.equal(receipt.stage, result.stage);
  });
}
