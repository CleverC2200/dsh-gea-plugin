import type { ProfileContext } from "@deepseek-ai/dsh-app-boot";
import { classifyInstallFailure, type PluginRegistries } from "@deepseek-ai/dsh-plugin-manager";
import { registryArguments, viewProfilePackage } from "@deepseek-ai/dsh-plugin-manager/operations";
import {
  NPMMIRROR_REGISTRY,
  OFFICIAL_NPM_REGISTRY,
  registryPlan,
} from "@deepseek-ai/dsh-plugin-manager/registry";
import { join } from "node:path";
import { sha256 } from "./plugin-update-profile.ts";

const publicMirrors = [
  NPMMIRROR_REGISTRY,
  "https://repo.huaweicloud.com/repository/npm/",
  "https://mirrors.cloud.tencent.com/npm/",
];

function registryFailure(log: string, timedOut?: boolean, cause?: unknown) {
  if (/\b(?:E40[13]|ERR_PNPM_FETCH_40[13]|401 Unauthorized|403 Forbidden)\b/i.test(log))
    return "authorization";
  if (/could not be checked against minimumReleaseAge \(GET .*: fetch failed\)/.test(log))
    return "network";
  return classifyInstallFailure({ log, timedOut, cause });
}

export function retryPluginInstallFromRegistry(log: string, timedOut?: boolean) {
  if (
    /\b(?:ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE|EINTEGRITY|ERR_PNPM_TRUST_DOWNGRADE|ERR_PNPM_TARBALL_URL_MISMATCH)\b|within the minimumReleaseAge cutoff|publish timestamp is not a valid date/.test(
      log,
    )
  )
    return false;
  const failure = registryFailure(log, timedOut);
  return (
    failure === "network" ||
    failure === "timeout" ||
    failure === "not-found" ||
    failure === "no-matching-version"
  );
}

export async function planPluginInstallRegistries(
  profile: Pick<ProfileContext, "dir" | "packageManager">,
  configured: PluginRegistries,
  cacheDirectory: string,
  signal: AbortSignal,
): Promise<string[][]> {
  const primary = configured.registry ?? configured.resolved;
  const defaultFallback =
    configured.fallbackRegistries.length === 1 &&
    configured.fallbackRegistries[0] === NPMMIRROR_REGISTRY &&
    (primary === OFFICIAL_NPM_REGISTRY || primary === NPMMIRROR_REGISTRY);
  const plan = registryPlan(undefined, {
    ...configured,
    fallbackRegistries: defaultFallback ? publicMirrors : configured.fallbackRegistries,
  });
  const original = registryArguments(plan[0] ?? null);
  if (plan.length < 2) return [original];
  const argumentsByRegistry = plan.map((candidate, index) =>
    index === 0
      ? original
      : [
          ...registryArguments(candidate),
          "--config.cache-dir=" + join(cacheDirectory, sha256(candidate ?? "")),
        ],
  );
  for (const [index, registry] of plan.entries()) {
    signal.throwIfAborted();
    const probe = await viewProfilePackage(profile.dir, "zod", {
      ...profile.packageManager,
      registry,
      signal,
      timeoutMs: 5000,
    });
    signal.throwIfAborted();
    if (probe.exitCode === 0) {
      const candidates = argumentsByRegistry.slice(index);
      return index === 0 ? candidates : [...candidates, original];
    }
    const failure = registryFailure(
      probe.stderr + "\n" + probe.stdout,
      probe.timedOut,
      probe.cause,
    );
    if (failure === "not-found" || failure === "no-matching-version") {
      if (index === 0) return argumentsByRegistry;
      continue;
    }
    if (failure !== "network" && failure !== "timeout") return [original];
  }
  return [original];
}
