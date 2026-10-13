/** Frozen official installations and their SDK peers, shared by build and delivery checks. */
import registry from "./supported-cores.json" with { type: "json" };
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const supportedCores = registry;
export const coreIdentity = ({ head, version }) => ({ head, version });
export function findSupportedCore(identity) {
  return registry.find(
    (core) => core.head === identity?.head && core.version === identity?.version,
  );
}
export function sdkVersion(core, name) {
  return core.sdk[name] ?? (/^@deepseek-ai\/dsh(?:-|$)/.test(name) ? core.version : undefined);
}
export function sdkPeerRange(name) {
  const versions = registry.map((core) => sdkVersion(core, name));
  return versions.every(Boolean) ? [...new Set(versions)].join(" || ") : undefined;
}
export function validSdkPeers(manifest) {
  return Object.entries(manifest.peerDependencies ?? {}).every(
    ([name, range]) =>
      !name.startsWith("@deepseek-ai/") ||
      (sdkPeerRange(name) !== undefined && range === sdkPeerRange(name)),
  );
}
export function supportsRegisteredCores(manifest) {
  const targets = manifest.supportedCores;
  return Boolean(
    findSupportedCore(manifest.core) &&
    Array.isArray(targets) &&
    targets.length === registry.length &&
    registry.every(
      (core) =>
        targets.filter((target) => target.head === core.head && target.version === core.version)
          .length === 1,
    ),
  );
}

/** Admit an isolated official source using the shared SDK verifier and the single GEA registry. */
export async function readSupportedCore(core) {
  const head = execFileSync("git", ["-C", core, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const cli = JSON.parse(await readFile(join(core, "apps/cli/package.json"), "utf8"));
  const registered = findSupportedCore({ head, version: cli.version });
  if (!registered) throw Error("FIXED_OFFICIAL_INPUT_REQUIRED: unregistered Core head/version");
  const { verifyOfficialSource } =
    await import("../../dsh-agent-manage/scripts/prepare-official-sdk.mjs");
  verifyOfficialSource(core, { coreHead: head });
  return registered;
}
