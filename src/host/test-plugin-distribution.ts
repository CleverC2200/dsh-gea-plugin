import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-plugin-manager";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import {
  companyPackageNames,
  comparePluginVersions,
  isManagedPluginName,
  validatePluginCombination,
} from "../shared/plugin-release.mjs";
import type { Business } from "./business.ts";
import {
  createManagedPluginReleaseSource,
  parsePluginReleaseSourceConfig,
} from "./plugin-release-source.ts";
import { readPluginUpdateCore } from "./plugin-update-core.ts";
import { object, optionalFile } from "./plugin-update-profile.ts";
import { prepareWindowsFileCommit } from "./plugin-update-windows.ts";
import { stageTestBundles, type TestBundleArchive } from "./test-plugin-installation.ts";
import { createTestPluginRuntime } from "./test-plugin-runtime.ts";

const refreshIntervalMs = 120_000;
type Identity = Pick<
  Business,
  "status" | "watchIdentity" | "identitySignal" | "assertTestPluginIdentity"
>;

export function mountTestPluginDistribution(
  ctx: Context,
  business: Identity,
  rawSource: unknown,
  pluginUpdates: unknown,
  directory: string,
): () => void {
  const lifetime = new AbortController();
  const manager = ctx.pluginManager;
  const runtime = createTestPluginRuntime(ctx);
  const archiveDirectory = join(directory, "archives");
  const noBundles = new Set<string>();
  const profileDependencies = async () =>
    object(
      object(JSON.parse(await readFile(join(ctx.profileContext.dir, "package.json"), "utf8")))
        .dependencies ?? {},
    );
  const managedArchive = (spec: unknown) => {
    if (typeof spec !== "string" || !spec.startsWith("file:")) return;
    const path = normalize(spec.slice(5));
    if (
      isAbsolute(path) &&
      dirname(path) === archiveDirectory &&
      /^[a-f0-9]{64}\.tgz$/.test(basename(path))
    )
      return path;
  };
  let migrated = false;
  const migrateLegacySelection = async () => {
    if (migrated) return;
    const bytes = await optionalFile(join(directory, "managed-bundles.json"));
    if (bytes) {
      const names: unknown = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(names) || !names.every(isManagedPluginName))
        throw Error("TEST_PLUGIN_OWNERSHIP_INVALID");
      const dependencies = await profileDependencies();
      for (const bundle of await manager.listBundles()) {
        if (
          !bundle.enabled ||
          !names.includes(bundle.name) ||
          !managedArchive(dependencies[bundle.name])
        )
          continue;
        lifetime.signal.throwIfAborted();
        const outcome = await manager.setBundleEnabled(bundle.name, false);
        if (outcome.application !== "applied") throw Error("TEST_PLUGIN_LEGACY_DISABLE_FAILED");
      }
    }
    migrated = true;
  };
  let mountedIdentity: AbortSignal | undefined;
  const eligible = () => {
    const status = business.status();
    return status.environment === "test" && status.authenticated;
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
    await migrateLegacySelection();
    if (!eligible()) return;
    mountedIdentity = business.identitySignal();
    const signal = AbortSignal.any([lifetime.signal, mountedIdentity]);
    const { core, source } = await (sourceLoading ??= loadSource().catch((error) => {
      sourceLoading = undefined;
      throw error;
    }));
    let releases: Awaited<ReturnType<typeof source.check>>;
    try {
      await business.assertTestPluginIdentity(signal);
      releases = await source.check(AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
    } catch (error) {
      runtime.retain(noBundles);
      throw error;
    }
    signal.throwIfAborted();
    const installed = await manager.listBundles();
    const dependencies = await profileDependencies();
    const authorized = new Set<string>();
    const companyManifests = installed.flatMap(({ name, version }) =>
      version && companyPackageNames.some((company) => company === name) ? [{ name, version }] : [],
    );
    const archives: TestBundleArchive[] = [];
    for (const release of releases) {
      signal.throwIfAborted();
      const current = installed.find(({ name }) => name === release.name);
      const spec = dependencies[release.name];
      const path = managedArchive(spec);
      if ((current || spec !== undefined) && !path) continue;
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
          ...companyManifests,
          {
            ...release,
            peerDependencies: Object.fromEntries(
              Object.entries(release.peerDependencies).filter(
                ([name]) =>
                  name.startsWith("@deepseek-ai/") ||
                  companyPackageNames.some((company) => company === name),
              ),
            ),
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
        if (path && current?.version && runtime.has(release.name)) authorized.add(release.name);
        const archive = await source.download(
          release,
          archiveDirectory,
          AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        );
        signal.throwIfAborted();
        source.assertCurrentRelease(release);
        if (current?.version !== release.version || path !== archive) {
          archives.push({ release, archivePath: archive, previousSpec: spec });
          continue;
        }
        if (current.enabled) throw Error("TEST_PLUGIN_PERSISTENT_SELECTION");
        await runtime.activate(release.name, signal);
        authorized.add(release.name);
      } catch (error) {
        signal.throwIfAborted();
        report(error);
      }
    }
    runtime.retain(authorized);
    if (!archives.length) return;
    const staging = await stageTestBundles(
      ctx,
      directory,
      core,
      archives,
      () => {
        signal.throwIfAborted();
        for (const { release } of archives) source.assertCurrentRelease(release);
      },
      signal,
    );
    if (staging === "waiting" && !restartCheck && !signal.aborted) {
      restartCheck = setTimeout(() => {
        restartCheck = undefined;
        if (eligible()) schedule();
      }, 2_000);
      restartCheck.unref();
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
  const unwatch = business.watchIdentity(() => {
    if (mountedIdentity !== business.identitySignal() || !eligible()) runtime.retain(noBundles);
    schedule();
  });
  const timer = setInterval(schedule, refreshIntervalMs);
  timer.unref();
  schedule();
  return () => {
    unwatch();
    clearInterval(timer);
    clearTimeout(restartCheck);
    lifetime.abort();
    runtime.retain(noBundles);
  };
}
