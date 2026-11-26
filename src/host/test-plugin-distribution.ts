import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-plugin-manager";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  comparePluginVersions,
  isManagedPluginName,
  validatePluginCombination,
  type PluginRelease,
} from "../shared/plugin-release.mjs";
import type { Business } from "./business.ts";
import {
  createManagedPluginReleaseSource,
  parsePluginReleaseSourceConfig,
} from "./plugin-release-source.ts";
import { readPluginUpdateCore } from "./plugin-update-core.ts";
import { object, optionalFile } from "./plugin-update-profile.ts";
import { prepareWindowsFileCommit } from "./plugin-update-windows.ts";
import { stageTestBundles } from "./test-plugin-installation.ts";

const refreshIntervalMs = 120_000;
type Identity = Pick<Business, "status" | "watchIdentity" | "identitySignal">;

export function mountTestPluginDistribution(
  ctx: Context,
  business: Identity,
  rawSource: unknown,
  pluginUpdates: unknown,
  directory: string,
): () => void {
  const lifetime = new AbortController();
  const manager = ctx.pluginManager;
  const ownedPath = join(directory, "managed-bundles.json");
  const eligible = () => {
    const status = business.status();
    return (
      status.environments.length === 1 && status.environment === "test" && status.authenticated
    );
  };
  const report = (error: unknown) => {
    if (lifetime.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
    ctx.logger.warn("Test plugin distribution failed", error);
    const diagnostic =
      error instanceof Error && /^[A-Z][A-Z_0-9]{0,100}$/.test(error.message)
        ? error.message
        : "TEST_PLUGIN_DISTRIBUTION_FAILED";
    void mkdir(directory, { recursive: true, mode: 0o700 })
      .then(() =>
        writeFileAtomic(join(directory, "last-failure.json"), JSON.stringify({ diagnostic }), {
          mode: 0o600,
        }),
      )
      .catch(() => {});
  };
  const loadSource = async () => {
    const sourceConfig = parsePluginReleaseSourceConfig(rawSource);
    if (sourceConfig.authenticationRef !== "anonymous")
      throw Error("UPDATE_SOURCE_AUTHENTICATION_UNSUPPORTED");
    const core = await readPluginUpdateCore(ctx, object(pluginUpdates).core);
    const source = createManagedPluginReleaseSource(sourceConfig, {
      trustDirectory: join(directory, "source-trust"),
      resolveAuthentication: async () => ({}),
      fileCommit:
        process.platform === "win32"
          ? await prepareWindowsFileCommit(
              join(directory, "windows-platform"),
              ctx.profileContext.installAnchor,
              core.version,
            )
          : undefined,
    });
    return { core, source };
  };
  let sourceLoading: ReturnType<typeof loadSource> | undefined;
  let restartCheck: ReturnType<typeof setTimeout> | undefined;
  async function reconcile() {
    lifetime.signal.throwIfAborted();
    const bytes = await optionalFile(ownedPath);
    const names: unknown = bytes ? JSON.parse(bytes.toString("utf8")) : [];
    if (!Array.isArray(names) || !names.every(isManagedPluginName))
      throw Error("TEST_PLUGIN_OWNERSHIP_INVALID");
    const owned = new Set<string>(names);
    const installed = await manager.listBundles();
    const setEnabled = async (name: string, enabled: boolean) => {
      const outcome = await manager.setBundleEnabled(name, enabled);
      if (outcome.application !== "applied")
        throw Error("TEST_PLUGIN_ENABLEMENT_" + outcome.application);
    };
    const deactivate = async (keep: ReadonlySet<string>) => {
      for (const bundle of installed)
        if (bundle.enabled && owned.has(bundle.name) && !keep.has(bundle.name))
          await setEnabled(bundle.name, false);
    };
    if (!eligible()) {
      await deactivate(new Set());
      return;
    }
    if (ctx.get("hmr") === undefined) throw Error("TEST_PLUGIN_HOT_RELOAD_UNAVAILABLE");
    const signal = AbortSignal.any([lifetime.signal, business.identitySignal()]);
    const { core, source } = await (sourceLoading ??= loadSource().catch((error) => {
      sourceLoading = undefined;
      throw error;
    }));
    const releases = await source.check(signal);
    await deactivate(new Set(releases.map(({ name }) => name)));
    const archives: { release: PluginRelease<string>; archivePath: string }[] = [];
    for (const release of releases) {
      signal.throwIfAborted();
      const current = installed.find(({ name }) => name === release.name);
      if (current && !owned.has(release.name)) continue;
      if (
        release.dataCompatibility.kind !== "preserve" ||
        !release.supportedCores.some(
          ({ head, version }) => head === core.head && version === core.version,
        )
      )
        continue;
      const compatibility = validatePluginCombination({
        core,
        manifests: [
          {
            ...release,
            peerDependencies: Object.fromEntries(
              Object.entries(release.peerDependencies).filter(([name]) =>
                name.startsWith("@deepseek-ai/"),
              ),
            ),
            dependencies: {},
          },
        ],
      });
      if (compatibility.length) {
        ctx.logger.warn("Test plugin requires a compatible Core", release.name);
        continue;
      }
      try {
        if (current?.version && comparePluginVersions(current.version, release.version) > 0)
          continue;
        if (current?.version !== release.version) {
          const archive = await source.download(release, join(directory, "archives"), signal);
          signal.throwIfAborted();
          source.assertCurrentRelease(release);
          if (!owned.has(release.name)) {
            owned.add(release.name);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await writeFileAtomic(ownedPath, JSON.stringify([...owned]), { mode: 0o600 });
          }
          signal.throwIfAborted();
          archives.push({ release, archivePath: archive });
          continue;
        }
        signal.throwIfAborted();
        if (!current?.enabled) await setEnabled(release.name, true);
      } catch (error) {
        signal.throwIfAborted();
        report(error);
      }
    }
    if (!archives.length) return;
    const staging = await stageTestBundles(ctx, directory, core.version, archives, signal);
    if (staging === "waiting" && !restartCheck && !signal.aborted) {
      restartCheck = setTimeout(() => {
        restartCheck = undefined;
        if (eligible()) schedule();
      }, 2_000);
      restartCheck.unref();
    }
    if (staging !== "direct") return;
    for (const { release, archivePath } of archives) {
      signal.throwIfAborted();
      const outcome = await manager.installBundle(archivePath, { enabled: false });
      if (outcome.application === "restart-required" && outcome.target === release.name) {
        ctx.logger.info("Restart required to apply the test plugin update", release.name);
        continue;
      }
      if (outcome.application !== "applied" || outcome.target !== release.name)
        throw Error("TEST_PLUGIN_INSTALL_" + outcome.application);
      signal.throwIfAborted();
      await setEnabled(release.name, true);
    }
  }
  let running: Promise<void> | undefined;
  let requested = false;
  const schedule = () => {
    requested = true;
    running ??= Promise.resolve()
      .then(async () => {
        while (requested && !lifetime.signal.aborted) {
          requested = false;
          await reconcile().catch(report);
        }
      })
      .finally(() => {
        running = undefined;
        if (requested && !lifetime.signal.aborted) schedule();
      });
  };
  const unwatch = business.watchIdentity(schedule);
  const timer = setInterval(() => {
    if (eligible()) schedule();
  }, refreshIntervalMs);
  timer.unref();
  schedule();
  return () => {
    unwatch();
    clearInterval(timer);
    clearTimeout(restartCheck);
    lifetime.abort();
  };
}
