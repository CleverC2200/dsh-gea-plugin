import semver from "semver";

export const companyPackageNames = Object.freeze([
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
]);

/** Validate the whole resulting graph, including consumers that are not being replaced. */
export function validatePluginCombination({ core, manifests }) {
  const failures = [];
  const versions = new Map(Object.entries(core.sdk));
  for (const manifest of manifests) {
    if (versions.has(manifest.name))
      failures.push({ code: "DUPLICATE_PACKAGE", packageName: manifest.name });
    versions.set(manifest.name, manifest.version);
  }
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const version = versions.get(name);
      if (!version && manifest.peerDependenciesMeta?.[name]?.optional === true) continue;
      if (!version || !semver.satisfies(version, range))
        failures.push({
          code: "PEER_INCOMPATIBLE",
          packageName: manifest.name,
          dependency: name,
          range,
          installed: version ?? null,
        });
    }
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (
        companyPackageNames.includes(name) &&
        (!versions.has(name) || !semver.satisfies(versions.get(name), range))
      )
        failures.push({
          code: "DEPENDENCY_INCOMPATIBLE",
          packageName: manifest.name,
          dependency: name,
          range,
          installed: versions.get(name) ?? null,
        });
    }
  }
  return failures;
}
export function planPluginUpdate({ release, core, installed }) {
  const current = installed.find((manifest) => manifest.name === release.name);
  if (!current) return { kind: "blocked", code: "PACKAGE_NOT_INSTALLED" };
  if (
    !release.supportedCores.some(
      (target) => target.head === core.head && target.version === core.version,
    )
  )
    return { kind: "blocked", code: "CORE_UNSUPPORTED" };
  const comparison = semver.compare(release.version, current.version);
  if (comparison < 0) return { kind: "blocked", code: "DOWNGRADE_FORBIDDEN" };
  if (comparison === 0) {
    if (current.artifactSha256 && current.artifactSha256 !== release.artifact.sha256)
      return { kind: "blocked", code: "SAME_VERSION_CONTENT_MISMATCH" };
    return { kind: "current" };
  }
  if (release.dataCompatibility.kind !== "preserve")
    return { kind: "blocked", code: "DATA_MIGRATION_REQUIRED" };
  const candidate = {
    name: release.name,
    version: release.version,
    peerDependencies: release.peerDependencies,
    peerDependenciesMeta: release.peerDependenciesMeta,
    dependencies: release.dependencies,
  };
  const failures = validatePluginCombination({
    core,
    manifests: installed.map((manifest) => (manifest.name === release.name ? candidate : manifest)),
  });
  return failures.length
    ? { kind: "blocked", code: "COMBINATION_INCOMPATIBLE", failures }
    : { kind: "ready", release };
}

/** Release metadata is a projection of the final packed manifest, never a rewritten peer graph. */
export function projectPluginRelease({
  manifest,
  artifact,
  supportedCores,
  dataCompatibility,
  notes,
}) {
  const peers = manifest.peerDependencies ?? {};
  return parsePluginRelease({
    schema: 1,
    name: manifest.name,
    version: manifest.version,
    artifact,
    supportedCores: supportedCores.map(({ head, version }) => ({
      head,
      version,
    })),
    requires: Object.fromEntries(
      Object.entries(peers).filter(([name]) => companyPackageNames.includes(name)),
    ),
    peerDependencies: peers,
    peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
    dependencies: manifest.dependencies ?? {},
    dataCompatibility,
    notes,
  });
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => {
  throw Error("RELEASE_INVALID");
};
function ranges(value) {
  if (!record(value)) fail();
  for (const [name, range] of Object.entries(value))
    if (!name || typeof range !== "string" || !semver.validRange(range)) fail();
  return structuredClone(value);
}
export function parsePluginRelease(value) {
  if (
    !record(value) ||
    value.schema !== 1 ||
    !companyPackageNames.includes(value.name) ||
    !semver.valid(value.version)
  )
    fail();
  const artifact = value.artifact;
  if (
    !record(artifact) ||
    typeof artifact.url !== "string" ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  )
    fail();
  const url = new URL(artifact.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.split("/").includes(artifact.sha256)
  )
    fail();
  if (!Array.isArray(value.supportedCores) || !value.supportedCores.length) fail();
  const supportedCores = value.supportedCores.map((core) => {
    if (!record(core) || !/^[a-f0-9]{40}$/.test(core.head) || !semver.valid(core.version)) fail();
    return { head: core.head, version: core.version };
  });
  if (new Set(supportedCores.map((core) => core.head)).size !== supportedCores.length) fail();
  const { peerDependencies, dependencies, peerDependenciesMeta } = parsePluginManifest(value);
  const requires = ranges(value.requires);
  const projected = Object.fromEntries(
    Object.entries(peerDependencies).filter(([name]) => companyPackageNames.includes(name)),
  );
  if (
    JSON.stringify(Object.entries(projected).sort()) !==
    JSON.stringify(Object.entries(requires).sort())
  )
    fail();
  const data = value.dataCompatibility;
  if (
    !record(data) ||
    !["preserve", "migration-required"].includes(data.kind) ||
    (data.kind === "migration-required" && (typeof data.note !== "string" || !data.note.trim()))
  )
    fail();
  if (typeof value.notes !== "string") fail();
  return {
    schema: 1,
    name: value.name,
    version: value.version,
    artifact: {
      url: artifact.url,
      size: artifact.size,
      sha256: artifact.sha256,
    },
    supportedCores,
    requires,
    peerDependencies,
    peerDependenciesMeta,
    dependencies,
    dataCompatibility:
      data.kind === "preserve"
        ? { kind: "preserve" }
        : { kind: "migration-required", note: data.note },
    notes: value.notes,
  };
}

/** Parse final publication graph once; unknown wire objects do not enter planning. */
export function parsePluginManifest(value) {
  if (!record(value) || !companyPackageNames.includes(value.name) || !semver.valid(value.version))
    fail();
  const peerDependencies = ranges(value.peerDependencies ?? {}),
    dependencies = ranges(value.dependencies ?? {});
  const peerDependenciesMeta = {};
  if (!record(value.peerDependenciesMeta ?? {})) fail();
  for (const [name, meta] of Object.entries(value.peerDependenciesMeta ?? {})) {
    if (
      !record(meta) ||
      typeof meta.optional !== "boolean" ||
      !Object.hasOwn(peerDependencies, name)
    )
      fail();
    peerDependenciesMeta[name] = { optional: meta.optional };
  }
  return {
    name: value.name,
    version: value.version,
    peerDependencies,
    peerDependenciesMeta,
    dependencies,
  };
}
export function comparePluginVersions(left, right) {
  return semver.compare(left, right);
}
export function parsePluginChannel(value) {
  if (
    !record(value) ||
    value.schema !== 1 ||
    typeof value.channel !== "string" ||
    !value.channel ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Array.isArray(value.releases) ||
    value.releases.length !== companyPackageNames.length
  )
    throw Error("SOURCE_CHANNEL_INVALID");
  for (const date of [value.issuedAt, value.expiresAt]) {
    if (
      typeof date !== "string" ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString() !== date
    )
      throw Error("SOURCE_CHANNEL_TIME_INVALID");
  }
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt))
    throw Error("SOURCE_CHANNEL_TIME_INVALID");
  const releases = value.releases.map((reference) => {
    if (
      !record(reference) ||
      !companyPackageNames.includes(reference.name) ||
      typeof reference.url !== "string" ||
      !/^[a-f0-9]{64}$/.test(reference.sha256)
    )
      throw Error("SOURCE_CHANNEL_INVALID");
    const url = new URL(reference.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[%\\]/.test(reference.url) ||
      !url.pathname.split("/").includes(reference.sha256)
    )
      throw Error("SOURCE_URL_FORBIDDEN");
    return {
      name: reference.name,
      url: reference.url,
      sha256: reference.sha256,
    };
  });
  if (new Set(releases.map((reference) => reference.name)).size !== companyPackageNames.length)
    throw Error("SOURCE_CHANNEL_INVALID");
  return {
    schema: 1,
    channel: value.channel,
    revision: value.revision,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    releases,
  };
}
/** Produce the complete next signed payload locally; publishing owns the atomic channel replacement. */
export function mergePluginChannelRelease({ previous, release, revision, issuedAt, expiresAt }) {
  const channel = parsePluginChannel(previous);
  if (!channel.releases.some((reference) => reference.name === release.name))
    throw Error("SOURCE_CHANNEL_INVALID");
  if (!Number.isSafeInteger(revision) || revision <= channel.revision)
    throw Error("CHANNEL_REVISION_REQUIRED");
  return parsePluginChannel({
    ...channel,
    revision,
    issuedAt,
    expiresAt,
    releases: channel.releases.map((reference) =>
      reference.name === release.name ? release : reference,
    ),
  });
}
export function satisfiesPluginVersion(version, range) {
  return semver.satisfies(version, range);
}
