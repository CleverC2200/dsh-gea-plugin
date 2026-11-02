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
for (const mode of ["success", "pnpm", "pnpm-stalled-registry", "fail-after-write", "orphan"]) {
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
      { mode, fileCommit },
    );
    await symlink(
      join(process.env.GEA_WINDOWS_RUNTIME, "dsh/node_modules"),
      join(f.root, "anchor/node_modules"),
      "junction",
    );
    let stalledRegistry;
    if (mode.startsWith("pnpm")) {
      await installPnpmConsumerLayout(f, "^3.0.0");
      f.profile.packageManager.args = [process.env.GEA_PLUGIN_UPDATE_PNPM];
      if (mode === "pnpm-stalled-registry")
        stalledRegistry = await configureStalledPnpmRegistry(t, f.profile);
    }
    f.profile.packageManager.env.FIXTURE_UPDATE_RUNTIME = f.options.runtimeDirectory;
    f.options.fileCommit = fileCommit;
    f.options.idleTimeoutMs = mode === "orphan" ? 1500 : 10000;
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
    const result = await waitForStage(
      controller,
      ["pending-restart", "failed", "unknown", "failed"],
      30000,
    );
    const expected =
      mode === "success" || mode.startsWith("pnpm")
        ? "pending-restart"
        : mode === "fail-after-write"
          ? "failed"
          : "unknown";
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
      const installing = JSON.parse(await readFile(join(f.dir, "installing-receipt.json"), "utf8"));
      assert.equal(installing.stage, "installing");
      assert.deepEqual(installing.processes, result.processes);
      assert.equal(installing.id, result.id);
    }
    if (mode === "fail-after-write") assert.equal(result.diagnostic, "PACKAGE_INSTALL_FAILED");
    if (mode === "orphan") {
      const pid = Number(await readFile(join(f.dir, "orphan-pid"), "utf8"));
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
