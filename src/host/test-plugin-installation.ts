import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-plugin-manager";
import { runProfilePnpm } from "@deepseek-ai/dsh-plugin-manager/operations";
import { assertProfileIdle } from "../../desktop/company-gea-refresh.mjs";
import { openCompanyInstallation } from "../../desktop/company-installation.mjs";
import { companyUpdateActive, readCompanyUpdate } from "../../desktop/company-update.mjs";
import { companyPnpmNetworkArguments } from "../../desktop/company-pnpm.mjs";
import {
  updatablePackageNames,
  validatePluginCombination,
  type FixedCore,
  type PluginRelease,
} from "../shared/plugin-release.mjs";
import {
  pluginProfileStoreDirectory,
  optionalFile,
  object,
  readPluginProfile,
  retainsProfileUpdates,
} from "./plugin-update-profile.ts";
import {
  observeProfilePackageProcesses,
  profilePackageRunStopped,
} from "./plugin-update-processes.ts";
import { prepareWindowsPackageRun } from "./plugin-update-windows.ts";
import {
  planPluginInstallRegistries,
  retryPluginInstallFromRegistry,
} from "./plugin-install-registry.ts";

export type TestBundleArchive = {
  release: PluginRelease<string>;
  archivePath: string;
  previousSpec: unknown;
};

export async function pendingTestPluginRestart(
  profile: string,
  directory: string,
): Promise<string | null> {
  const receipt = await optionalFile(join(directory, "pending-restart.json"));
  if (!receipt) return null;
  const { id } = object(JSON.parse(receipt.toString("utf8")));
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    return null;
  const installation = await openCompanyInstallation(profile);
  return (await installation?.pendingTestPluginActivation()) === id ? id : null;
}

export async function stageTestBundles(
  ctx: Context,
  directory: string,
  core: FixedCore,
  archives: readonly TestBundleArchive[],
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<"staged" | "waiting"> {
  signal.throwIfAborted();
  const profile = ctx.profileContext;
  if (await pendingTestPluginRestart(profile.dir, directory)) return "staged";
  const registryAttempts = await planPluginInstallRegistries(
    profile,
    await ctx.pluginManager.registries(),
    join(directory, "registry-cache"),
    signal,
  );
  const lockProfile = <T>(run: () => Promise<T>) =>
    withFileLock(join(profile.dir, "package.json"), run, { waitMs: 30_000 });
  const installation = await openCompanyInstallation(profile.dir);
  if (!installation) throw Error("TEST_PLUGIN_MANAGED_DESKTOP_REQUIRED");
  const baseline = await lockProfile(async () => {
    signal.throwIfAborted();
    assertCurrent();
    if (await installation.hasPendingActivation())
      return (await pendingTestPluginRestart(profile.dir, directory)) ? "staged" : "waiting";
    if (companyUpdateActive(await readCompanyUpdate(profile.dir))) return "waiting";
    await assertProfileIdle(profile.dir, {});
    if (!profilePackageRunStopped(profile.dir)) throw Error("PROFILE_WRITER_UNCONFIRMED");
    return {
      profile: await readPluginProfile(profile.dir),
      store: await pluginProfileStoreDirectory(profile.dir),
    };
  });
  if (typeof baseline === "string") return baseline;

  for (const [index, registryArgs] of registryAttempts.entries()) {
    signal.throwIfAborted();
    const id = randomUUID();
    const operation = join(directory, id);
    await mkdir(operation, { mode: 0o700 });
    let retryRegistry = false;
    try {
      await installation.prepare(
        id,
        async (
          stage: string,
          controls: {
            registerProcess(pid: number): Promise<void>;
          },
        ) => {
          const before = await readPluginProfile(stage);
          const dependencies = object(before.manifest.dependencies ?? {});
          if (
            archives.some(
              ({ release, previousSpec }) => dependencies[release.name] !== previousSpec,
            )
          )
            throw Error("TEST_PLUGIN_INSTALLATION_CHANGED");
          const releases = archives.map(({ release }) => release);
          const targets = new Set(releases.map(({ name }) => name));
          const combination = validatePluginCombination({
            core,
            manifests: [...before.packages, ...releases],
          });
          if (
            combination.some(
              ({ packageName, dependency }) =>
                dependency !== undefined &&
                (targets.has(dependency) ||
                  (targets.has(packageName) &&
                    (dependency.startsWith("@deepseek-ai/") ||
                      updatablePackageNames.some((name) => name === dependency)))),
            )
          )
            throw Error("TEST_PLUGIN_COMBINATION_INCOMPATIBLE");
          const windowsRun =
            process.platform === "win32"
              ? await prepareWindowsPackageRun(
                  operation,
                  stage,
                  profile.installAnchor,
                  core.version,
                  profile.packageManager,
                  async ({ pid }) => controls.registerProcess(pid),
                )
              : null;
          const monitor = windowsRun ?? (await observeProfilePackageProcesses(stage));
          const stopLauncher = windowsRun ? new AbortController() : null;
          let stopTimer: ReturnType<typeof setTimeout> | undefined;
          const cancelJob = () => {
            stopTimer = setTimeout(() => stopLauncher?.abort(), 5_000);
            stopTimer.unref();
            try {
              windowsRun?.cancelObserved();
            } catch {
              stopLauncher?.abort();
            }
          };
          try {
            signal.throwIfAborted();
            if (windowsRun) signal.addEventListener("abort", cancelJob, { once: true });
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
                "--store-dir=" + baseline.store,
                "--save-exact",
                "--ignore-scripts",
                "--ignore-pnpmfile",
                "--config.auto-install-peers=false",
                "--config.update-notifier=false",
                ...companyPnpmNetworkArguments,
                ...registryArgs,
              ],
              {
                ...(windowsRun?.packageManager ?? profile.packageManager),
                execution: "service",
                signal: stopLauncher?.signal ?? signal,
                outputBytes: 16_000,
                activateNewBundles: false,
                idleTimeoutMs: 90_000,
                lookupTimeoutMs: 20_000,
                onOutput: () => monitor.capture(),
              },
            ).finally(async () => {
              if (await monitor.waitForQuiescence(2_000)) return;
              if (stopTimer === undefined) monitor.cancelObserved();
              if (!(await monitor.waitForQuiescence(2_000)))
                throw Error("TEST_PLUGIN_PACKAGE_WRITERS_UNCONFIRMED");
              if (!signal.aborted) throw Error("TEST_PLUGIN_PACKAGE_WRITERS_INTERRUPTED");
            });
            signal.throwIfAborted();
            if (result.exitCode !== 0 || result.timedOut) {
              retryRegistry = retryPluginInstallFromRegistry(result.output, result.timedOut);
              throw Error("TEST_PLUGIN_STAGE_FAILED");
            }
            assertCurrent();
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
            signal.removeEventListener("abort", cancelJob);
            clearTimeout(stopTimer);
            monitor.close();
          }
        },
        signal,
        {
          testPlugin: true,
          commitActivation: (activate: () => Promise<void>) =>
            lockProfile(async () => {
              signal.throwIfAborted();
              assertCurrent();
              await assertProfileIdle(profile.dir, {});
              if (!profilePackageRunStopped(profile.dir)) throw Error("PROFILE_WRITER_UNCONFIRMED");
              if (
                companyUpdateActive(await readCompanyUpdate(profile.dir)) ||
                (await installation.hasPendingActivation()) ||
                (await readPluginProfile(profile.dir)).sha256 !== baseline.profile.sha256
              )
                throw Error("TEST_PLUGIN_INSTALLATION_CHANGED");
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
              await activate();
            }),
        },
      );
      ctx.logger.info("Restart required to finish installing test plugins");
      return "staged";
    } catch (error) {
      if (!retryRegistry || index + 1 === registryAttempts.length) throw error;
    }
  }
  return "waiting";
}
