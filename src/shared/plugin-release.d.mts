export type CompanyPackageName =
  | "@cleverc2200/dsh-agent-workbench"
  | "dsh-agent-manage"
  | "@cleverc2200/gea-dsh-prototype";
export type UpdatablePackageName = CompanyPackageName | "@cleverc2200/dsh-personal-memory";
export const personalMemoryPackageName: "@cleverc2200/dsh-personal-memory";
export const updatablePackageNames: readonly UpdatablePackageName[];
export const testPluginChannel: "plugin-detail-test";
export function isManagedPluginChannel(
  channel: unknown,
): channel is "stable" | typeof testPluginChannel;
export function isManagedPluginName(name: unknown): name is string;
export type CoreIdentity = { head: string; version: string };
export type FixedCore = CoreIdentity & { sdk: Record<string, string> };
export type PluginManifest = {
  name: string;
  version: string;
  geaPluginUpdateStrategy?: "suite" | "managed-suite";
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional: boolean }>;
  dependencies?: Record<string, string>;
  artifactSha256?: string;
};
export type PluginRelease<Name extends string = UpdatablePackageName> = {
  schema: 1;
  updateStrategy?: "suite" | "managed-suite";
  name: Name;
  version: string;
  artifact: { url: string; size: number; sha256: string };
  supportedCores: CoreIdentity[];
  requires: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional: boolean }>;
  dependencies: Record<string, string>;
  dataCompatibility: { kind: "preserve" } | { kind: "migration-required"; note: string };
  notes: string;
};
export type CombinationFailure = {
  code: string;
  packageName: string;
  dependency?: string;
  range?: string;
  installed?: string | null;
};
export type PluginUpdatePlan =
  | { kind: "ready"; release: PluginRelease }
  | { kind: "current" }
  | { kind: "blocked"; code: string; failures?: CombinationFailure[] };
export const companyPackageNames: readonly CompanyPackageName[];
export function parsePluginRelease(value: unknown): PluginRelease;
export function parseManagedPluginRelease(value: unknown): PluginRelease<string>;
export function validatePluginCombination(input: {
  core: FixedCore;
  manifests: PluginManifest[];
}): CombinationFailure[];
export function planPluginUpdate(input: {
  release: PluginRelease;
  core: FixedCore;
  installed: PluginManifest[];
}): PluginUpdatePlan;
export type PluginSuiteUpdatePlan =
  | { kind: "ready"; releases: PluginRelease[] }
  | { kind: "current" }
  | {
      kind: "blocked";
      code: string;
      packageName?: UpdatablePackageName;
      failures?: CombinationFailure[];
    };
export function planPluginSuiteUpdate(input: {
  releases: PluginRelease[];
  core: FixedCore;
  installed: PluginManifest[];
}): PluginSuiteUpdatePlan;
export const planPluginSuiteVersions: typeof planPluginSuiteUpdate;
export function findPluginUpdatePath(input: {
  core: FixedCore;
  installed: PluginManifest[];
  releases: PluginRelease[];
  firstStep?: UpdatablePackageName;
}): UpdatablePackageName[] | null;
export function projectPluginRelease(input: {
  manifest: PluginManifest;
  artifact: PluginRelease["artifact"];
  supportedCores: CoreIdentity[];
  dataCompatibility: PluginRelease["dataCompatibility"];
  notes: string;
}): PluginRelease;
export function parsePluginManifest(
  value: unknown,
  managed?: boolean,
): Required<
  Pick<
    PluginManifest,
    "name" | "version" | "dependencies" | "peerDependencies" | "peerDependenciesMeta"
  >
> &
  Pick<PluginManifest, "geaPluginUpdateStrategy">;
export function parseInstalledPluginManifest(
  value: unknown,
): ReturnType<typeof parsePluginManifest>;
export function comparePluginVersions(left: string, right: string): number;
export type PluginReleaseReference<Name extends string = UpdatablePackageName> = {
  name: Name;
  url: string;
  sha256: string;
};
export type PluginChannel = {
  schema: 1;
  suite?: true;
  channel: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  releases: PluginReleaseReference[];
  companionReleases?: PluginReleaseReference[];
  optionalReleases?: PluginReleaseReference[];
  managedReleases?: PluginReleaseReference<string>[];
};
export function parsePluginChannel(
  value: unknown,
  options?: { readManagedReleases?: boolean },
): PluginChannel;
export function mergePluginChannelRelease(input: {
  previous: PluginChannel;
  release: PluginReleaseReference;
  revision: number;
  issuedAt: string;
  expiresAt: string;
}): PluginChannel;
export function satisfiesPluginVersion(version: string, range: string): boolean;
