import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import type { Context } from "@deepseek-ai/cordis";
import { runProfilePnpm } from "@deepseek-ai/dsh-plugin-manager/operations";
import { openCompanyInstallation } from "../../desktop/company-installation.mjs";
import { companyUpdateActive, readCompanyUpdate } from "../../desktop/company-update.mjs";
import { companyPnpmNetworkArguments } from "../../desktop/company-pnpm.mjs";
import type { PluginRelease } from "../shared/plugin-release.mjs";
import {
  pluginProfileStoreDirectory,
  optionalFile,
  readPluginProfile,
  retainsProfileUpdates,
} from "./plugin-update-profile.ts";
import {
  observeProfilePackageProcesses,
  profilePackageRunStopped,
} from "./plugin-update-processes.ts";
import { prepareWindowsPackageRun } from "./plugin-update-windows.ts";

type TestBundleArchive = { release: PluginRelease<string>; archivePath: string };

export async function stageTestBundles(
  ctx: Context,
  directory: string,
  coreVersion: string,
  archives: readonly TestBundleArchive[],
  signal: AbortSignal,
): Promise<"direct" | "staged" | "waiting"> {
  const profile = ctx.profileContext;
  return withFileLock(
    join(profile.dir, "package.json"),
    async () => {
      signal.throwIfAborted();
      const installation = await openCompanyInstallation(profile.dir);
      if (!installation) return "direct";
      if (await installation.hasPendingActivation()) {
        const receipt = await optionalFile(join(directory, "pending-restart.json"));
        const id: unknown = receipt && JSON.parse(receipt.toString("utf8")).id;
        return typeof id === "string" && (await installation.activationState(id)) === "pending"
          ? "staged"
          : "waiting";
      }
      if (companyUpdateActive(await readCompanyUpdate(profile.dir))) return "waiting";
      if (!profilePackageRunStopped(profile.dir)) throw Error("PROFILE_WRITER_UNCONFIRMED");
      const store = await pluginProfileStoreDirectory(profile.dir);
      const id = "test-" + randomUUID();
      const operation = join(directory, id);
      await mkdir(operation, { mode: 0o700 });
      await installation.prepare(
        id,
        async (
          stage: string,
          controls: {
            registerProcess(pid: number): Promise<void>;
          },
        ) => {
          const before = await readPluginProfile(stage);
          const windowsRun =
            process.platform === "win32"
              ? await prepareWindowsPackageRun(
                  operation,
                  stage,
                  profile.installAnchor,
                  coreVersion,
                  profile.packageManager,
                  async ({ pid }) => controls.registerProcess(pid),
                )
              : null;
          const monitor = windowsRun ?? (await observeProfilePackageProcesses(stage));
          try {
            const result = await runProfilePnpm(
              {
                profile: profile.name,
                dir: stage,
                installAnchor: profile.installAnchor,
                cwd: profile.cwd,
                home: profile.home,
              },
              [
                "add",
                ...archives.map(({ archivePath }) => "file:" + archivePath),
                "--store-dir=" + store,
                "--save-exact",
                "--ignore-scripts",
                "--ignore-pnpmfile",
                "--config.auto-install-peers=false",
                "--config.update-notifier=false",
                ...companyPnpmNetworkArguments,
              ],
              {
                ...(windowsRun?.packageManager ?? profile.packageManager),
                execution: "service",
                signal,
                outputBytes: 16_000,
                activateNewBundles: false,
                idleTimeoutMs: 90_000,
                lookupTimeoutMs: 20_000,
                onOutput: () => monitor.capture(),
              },
            );
            await monitor.capture();
            if (!(await monitor.waitForQuiescence(2_000))) {
              monitor.cancelObserved();
              throw Error("TEST_PLUGIN_PACKAGE_WRITERS_UNCONFIRMED");
            }
            if (result.exitCode !== 0 || result.timedOut) throw Error("TEST_PLUGIN_STAGE_FAILED");
            signal.throwIfAborted();
            const after = await readPluginProfile(stage);
            if (!retainsProfileUpdates(before, after, archives))
              throw Error("TEST_PLUGIN_GRAPH_CHANGED");
            for (const { release } of archives) {
              const actual = JSON.parse(
                await readFile(join(stage, "node_modules", release.name, "package.json"), "utf8"),
              );
              if (actual.name !== release.name || actual.version !== release.version)
                throw Error("TEST_PLUGIN_GRAPH_CHANGED");
            }
          } finally {
            monitor.close();
          }
        },
        signal,
      );
      await writeFileAtomic(
        join(directory, "pending-restart.json"),
        JSON.stringify({
          id,
          bundles: archives.map(({ release }) => ({
            name: release.name,
            version: release.version,
          })),
        }),
        { mode: 0o600 },
      );
      ctx.logger.info("Restart required to finish installing test plugins");
      return "staged";
    },
    { waitMs: 30_000 },
  );
}
