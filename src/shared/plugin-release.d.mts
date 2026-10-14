export type CompanyPackageName =
  | "@cleverc2200/dsh-agent-workbench"
  | "dsh-agent-manage"
  | "@cleverc2200/gea-dsh-prototype";
export type CoreIdentity = { head: string; version: string };
export type FixedCore = CoreIdentity & { sdk: Record<string, string> };
export type PluginManifest = {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional: boolean }>;
  dependencies?: Record<string, string>;
  artifactSha256?: string;
};
export type PluginRelease = {
  schema: 1;
  name: CompanyPackageName;
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
export function validatePluginCombination(input: {
  core: FixedCore;
  manifests: PluginManifest[];
}): CombinationFailure[];
export function planPluginUpdate(input: {
  release: PluginRelease;
  core: FixedCore;
  installed: PluginManifest[];
}): PluginUpdatePlan;
export function projectPluginRelease(input: {
  manifest: PluginManifest;
  artifact: PluginRelease["artifact"];
  supportedCores: CoreIdentity[];
  dataCompatibility: PluginRelease["dataCompatibility"];
  notes: string;
}): PluginRelease;
export function parsePluginManifest(
  value: unknown,
): Required<
  Pick<
    PluginManifest,
    "name" | "version" | "dependencies" | "peerDependencies" | "peerDependenciesMeta"
  >
>;
export function comparePluginVersions(left: string, right: string): number;
export type PluginReleaseReference = {
  name: CompanyPackageName;
  url: string;
  sha256: string;
};
export type PluginChannel = {
  schema: 1;
  channel: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  releases: PluginReleaseReference[];
};
export function parsePluginChannel(value: unknown): PluginChannel;
export function mergePluginChannelRelease(input: {
  previous: PluginChannel;
  release: PluginReleaseReference;
  revision: number;
  issuedAt: string;
  expiresAt: string;
}): PluginChannel;
export function satisfiesPluginVersion(version: string, range: string): boolean;
