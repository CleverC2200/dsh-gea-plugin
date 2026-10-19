import { createHash, createPublicKey, verify, randomUUID, type KeyObject } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  companyPackageNames,
  parsePluginRelease,
  parsePluginManifest,
  comparePluginVersions,
  parsePluginChannel,
  type PluginRelease,
  type PluginManifest,
} from "../shared/plugin-release.mjs";

import type { PluginUpdateFileCommit } from "./plugin-update-windows.ts";
const run = promisify(execFile);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (code: string): never => {
  throw Error(code);
};
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("SOURCE_SCHEMA_INVALID");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string =>
  typeof value === "string" && value.length > 0 ? value : fail("SOURCE_SCHEMA_INVALID");
const sha = (value: unknown): string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : fail("SOURCE_SCHEMA_INVALID");
const json = (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString("utf8"));
const base64 = (value: unknown): Buffer => {
  const encoded = text(value),
    bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return fail("SOURCE_BASE64_INVALID");
  return bytes;
};

export type PluginReleaseSourceConfig = {
  channel: string;
  channelUrl: string;
  authenticationRef: string;
  allowed: { origin: string; pathPrefix: string }[];
  trustedKeys: { keyId: string; publicKeyPem: string }[];
};
export type PluginReleaseSourceDependencies = {
  resolveAuthentication: (
    reference: string,
    url: string,
    signal?: AbortSignal,
  ) => Promise<Record<string, string>>;
  fetch?: typeof globalThis.fetch;
  trustDirectory: string;
  fileCommit?: PluginUpdateFileCommit;
  now?: () => number;
};

/** Configuration and credentials stay in Host; only verified release projections cross to the client. */
export function parsePluginReleaseSourceConfig(raw: unknown): PluginReleaseSourceConfig {
  const value = object(raw);
  if (
    !Array.isArray(value.allowed) ||
    !value.allowed.length ||
    !Array.isArray(value.trustedKeys) ||
    !value.trustedKeys.length
  )
    return fail("SOURCE_CONFIG_INVALID");
  const allowed = value.allowed.map((row: unknown) => {
    const rule = object(row),
      origin = text(rule.origin),
      pathPrefix = text(rule.pathPrefix),
      url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      !pathPrefix.startsWith("/") ||
      !pathPrefix.endsWith("/") ||
      /[%?#\\]|\.\./.test(pathPrefix)
    )
      return fail("SOURCE_CONFIG_INVALID");
    return { origin, pathPrefix };
  });
  const trustedKeys = value.trustedKeys.map((row: unknown) => {
    const key = object(row),
      keyId = text(key.keyId),
      publicKeyPem = text(key.publicKeyPem);
    if (createPublicKey(publicKeyPem).asymmetricKeyType !== "ed25519")
      return fail("SOURCE_KEY_INVALID");
    return { keyId, publicKeyPem };
  });
  if (new Set(trustedKeys.map((key) => key.keyId)).size !== trustedKeys.length)
    return fail("SOURCE_CONFIG_INVALID");
  const config = {
    channel: text(value.channel),
    channelUrl: text(value.channelUrl),
    authenticationRef: text(value.authenticationRef),
    allowed,
    trustedKeys,
  };
  allowedUrl(config.channelUrl, config);
  return config;
}
function allowedUrl(
  value: string,
  config: PluginReleaseSourceConfig,
  immutableSha?: string,
): string {
  if (/%|\\/.test(value)) return fail("SOURCE_URL_FORBIDDEN");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%|\\/.test(url.pathname) ||
    !config.allowed.some(
      (rule) => rule.origin === url.origin && url.pathname.startsWith(rule.pathPrefix),
    ) ||
    (immutableSha && !url.pathname.split("/").includes(immutableSha))
  )
    return fail("SOURCE_URL_FORBIDDEN");
  return url.href;
}
async function boundedBytes(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!response.body) return fail("SOURCE_BODY_MISSING");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return fail("SOURCE_SIZE_LIMIT");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** tar only lists or streams named files; no archive content is extracted to disk. */
export async function inspectPluginArchive(
  path: string,
  signal?: AbortSignal,
): Promise<PluginManifest> {
  const options = {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGKILL" as const,
    encoding: "utf8" as const,
    signal,
  };
  const entries = (await run("tar", ["-tzf", path], options)).stdout.trim().split(/\r?\n/);
  if (
    new Set(entries).size !== entries.length ||
    entries.some(
      (file) =>
        !file.startsWith("package/") ||
        /[\\\r\t]/.test(file) ||
        file.split("/").some((part) => part === ".." || part === ".") ||
        file.includes("//") ||
        file.includes("/node_modules/"),
    )
  )
    return fail("SOURCE_ARCHIVE_INVALID");
  const listing = (await run("tar", ["-tvzf", path], options)).stdout.trim().split(/\r?\n/);
  if (listing.length !== entries.length || listing.some((line) => !["-", "d"].includes(line[0])))
    return fail("SOURCE_ARCHIVE_LINK_FORBIDDEN");
  if (!entries.includes("package/package.json")) return fail("SOURCE_ARCHIVE_MANIFEST_MISSING");
  const value = object(
    JSON.parse((await run("tar", ["-xOf", path, "package/package.json"], options)).stdout),
  );
  const name = text(value.name);
  if (!companyPackageNames.some((company) => company === name))
    return fail("SOURCE_ARCHIVE_IDENTITY_INVALID");
  const exports = object(value.exports),
    dsh = object(value.dsh),
    bundle = object(dsh.bundle);
  object(dsh.client);
  function runtimeExport(declaration: unknown): string | undefined {
    if (typeof declaration === "string") return declaration;
    for (const [condition, target] of Object.entries(object(declaration))) {
      if (["node", "import", "default", "require"].includes(condition)) {
        const selected = runtimeExport(target);
        if (selected) return selected;
      }
    }
    return undefined;
  }
  for (const key of [".", "./client"]) {
    const target = runtimeExport(exports[key]);
    if (
      typeof target !== "string" ||
      !target.startsWith("./") ||
      target.split("/").includes("..") ||
      !entries.includes("package/" + target.slice(2))
    )
      return fail("SOURCE_ARCHIVE_EXPORT_MISSING");
  }
  const patch = text(bundle.patch);
  if (
    !patch.startsWith("./") ||
    patch.split("/").includes("..") ||
    !entries.includes("package/" + patch.slice(2))
  )
    return fail("SOURCE_ARCHIVE_BUNDLE_MISSING");
  const projection = parsePluginManifest(value);
  if (
    value.scripts ||
    value.devDependencies ||
    value.workspaces ||
    value.pnpm ||
    value.overrides ||
    value.resolutions ||
    value.optionalDependencies
  )
    return fail("SOURCE_ARCHIVE_INSTALL_GRAPH_UNSUPPORTED");
  return {
    name: projection.name,
    version: projection.version,
    peerDependencies: projection.peerDependencies,
    peerDependenciesMeta: projection.peerDependenciesMeta,
    dependencies: projection.dependencies,
  };
}
function sameGraph(manifest: PluginManifest, release: PluginRelease): boolean {
  const sorted = (value: unknown) =>
    JSON.stringify(Object.entries(object(value ?? {})).sort(([a], [b]) => a.localeCompare(b)));
  return (
    manifest.name === release.name &&
    manifest.version === release.version &&
    sorted(manifest.peerDependencies) === sorted(release.peerDependencies) &&
    sorted(manifest.peerDependenciesMeta) === sorted(release.peerDependenciesMeta) &&
    sorted(manifest.dependencies) === sorted(release.dependencies)
  );
}

export function createPluginReleaseSource(
  rawConfig: unknown,
  dependencies: PluginReleaseSourceDependencies,
) {
  const config = parsePluginReleaseSourceConfig(rawConfig);
  const keys = new Map<string, KeyObject>(
    config.trustedKeys.map((key) => [key.keyId, createPublicKey(key.publicKeyPem)]),
  );
  if (!isAbsolute(dependencies.trustDirectory)) return fail("SOURCE_TRUST_ABSOLUTE_REQUIRED");
  let verified = new Map<string, string>(),
    generation = 0,
    verifiedUntil = 0;
  let checks: Promise<unknown> = Promise.resolve();
  const receiptPath = join(dependencies.trustDirectory, "approved-channel.json");
  async function previousReceipt(): Promise<Record<string, unknown> | null> {
    try {
      const directory = await lstat(dependencies.trustDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        return fail("SOURCE_TRUST_INVALID");
      const entry = await lstat(receiptPath);
      if (!entry.isFile() || entry.isSymbolicLink()) return fail("SOURCE_TRUST_INVALID");
      const receipt = object(json(await readFile(receiptPath)));
      if (
        receipt.schema !== 1 ||
        !Number.isSafeInteger(receipt.revision) ||
        Number(receipt.revision) < 1 ||
        receipt.channel !== config.channel ||
        !Array.isArray(receipt.releases) ||
        receipt.releases.length === 0 ||
        receipt.releases.length > companyPackageNames.length
      )
        return fail("SOURCE_TRUST_INVALID");
      sha(receipt.payloadSha256);
      const names = new Set<string>();
      for (const row of receipt.releases) {
        const release = object(row),
          manifest = parsePluginManifest({
            name: release.name,
            version: release.version,
          });
        if (names.has(manifest.name)) return fail("SOURCE_TRUST_INVALID");
        names.add(manifest.name);
        sha(release.sha256);
      }
      return receipt;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  async function saveReceipt(receipt: unknown) {
    await mkdir(dependencies.trustDirectory, { recursive: true, mode: 0o700 });
    const entry = await lstat(dependencies.trustDirectory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return fail("SOURCE_TRUST_INVALID");
    await chmod(dependencies.trustDirectory, 0o700);
    const partial = join(dependencies.trustDirectory, randomUUID() + ".partial");
    try {
      const file = await open(partial, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(receipt) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      await commitFile(partial, receiptPath);
      const directory =
        process.platform === "win32" ? null : await open(dependencies.trustDirectory, "r");
      try {
        await directory?.sync();
      } finally {
        await directory?.close();
      }
    } finally {
      await rm(partial, { force: true });
    }
  }
  async function commitFile(from: string, to: string) {
    if (process.platform !== "win32") return rename(from, to);
    if (!dependencies.fileCommit) throw Error("UPDATE_WINDOWS_STORAGE_UNAVAILABLE");
    await dependencies.fileCommit.replace(from, to);
  }
  async function request(url: string, signal?: AbortSignal): Promise<Response> {
    const approved = allowedUrl(url, config);
    signal?.throwIfAborted();
    const headers = await dependencies.resolveAuthentication(
      config.authenticationRef,
      approved,
      signal,
    );
    const response = await (dependencies.fetch ?? globalThis.fetch)(approved, {
      headers,
      signal,
      redirect: "error",
    });
    if (!response.ok || (response.url && response.url !== approved))
      return fail("SOURCE_HTTP_FAILED");
    return response;
  }
  async function performCheck(current: number, signal?: AbortSignal): Promise<PluginRelease[]> {
    try {
      const envelope = object(
        json(await boundedBytes(await request(config.channelUrl, signal), 1024 * 1024, signal)),
      );
      const key = keys.get(text(envelope.keyId));
      if (!key) return fail("SOURCE_KEY_UNTRUSTED");
      const payload = base64(envelope.payloadBase64),
        signature = base64(envelope.signatureBase64);
      if (!verify(null, payload, key, signature)) return fail("SOURCE_SIGNATURE_INVALID");
      const channel = parsePluginChannel(json(payload));
      if (channel.channel !== config.channel) return fail("SOURCE_CHANNEL_INVALID");
      const now = (dependencies.now ?? Date.now)();
      const issuedAt = typeof channel.issuedAt === "string" ? Date.parse(channel.issuedAt) : NaN;
      const expiresAt = typeof channel.expiresAt === "string" ? Date.parse(channel.expiresAt) : NaN;
      if (
        !Number.isSafeInteger(channel.revision) ||
        Number(channel.revision) < 1 ||
        !Number.isFinite(issuedAt) ||
        !Number.isFinite(expiresAt) ||
        issuedAt > now + 300_000 ||
        expiresAt <= now ||
        expiresAt <= issuedAt
      )
        return fail("SOURCE_CHANNEL_TIME_INVALID");
      const previous = await previousReceipt(),
        payloadSha256 = hash(payload);
      if (
        previous &&
        (Number(channel.revision) < Number(previous.revision) ||
          (channel.revision === previous.revision && payloadSha256 !== previous.payloadSha256))
      )
        return fail("SOURCE_CHANNEL_REPLAY");
      const releases: PluginRelease[] = [];
      for (const row of [...channel.releases, ...(channel.companionReleases ?? [])]) {
        const reference = object(row),
          name = text(reference.name),
          releaseHash = sha(reference.sha256);
        if (
          !companyPackageNames.some((company) => company === name) ||
          releases.some((release) => release.name === name)
        )
          return fail("SOURCE_CHANNEL_INVALID");
        const url = allowedUrl(text(reference.url), config, releaseHash);
        const bytes = await boundedBytes(await request(url, signal), 1024 * 1024, signal);
        if (hash(bytes) !== releaseHash) return fail("SOURCE_RELEASE_HASH_MISMATCH");
        const release = parsePluginRelease(json(bytes));
        if (release.name !== name) return fail("SOURCE_RELEASE_IDENTITY_MISMATCH");
        allowedUrl(release.artifact.url, config, release.artifact.sha256);
        if (previous) {
          const old = (previous.releases as unknown[])
            .map(object)
            .find((row) => row.name === release.name);
          if (old) {
            if (typeof old.version !== "string" || typeof old.sha256 !== "string")
              return fail("SOURCE_TRUST_INVALID");
            // A temporarily absent release keeps its durable version and digest approval.
            const comparison = comparePluginVersions(release.version, old.version);
            if (comparison < 0) return fail("SOURCE_VERSION_ROLLBACK");
            if (comparison === 0 && release.artifact.sha256 !== old.sha256)
              return fail("SOURCE_SAME_VERSION_CONTENT_MISMATCH");
          }
        }
        releases.push(release);
      }
      if (current !== generation) return fail("SOURCE_CHECK_SUPERSEDED");
      signal?.throwIfAborted();
      const approved = new Map(
        ((previous?.releases ?? []) as unknown[]).map((raw) => {
          const release = object(raw);
          return [text(release.name), release] as const;
        }),
      );
      for (const release of releases)
        approved.set(release.name, {
          name: release.name,
          version: release.version,
          sha256: release.artifact.sha256,
        });
      await saveReceipt({
        schema: 1,
        channel: config.channel,
        revision: channel.revision,
        payloadSha256,
        issuedAt: channel.issuedAt,
        expiresAt: channel.expiresAt,
        releases: [...approved.values()],
      });
      signal?.throwIfAborted();
      if (current !== generation) return fail("SOURCE_CHECK_SUPERSEDED");
      if ((dependencies.now ?? Date.now)() >= expiresAt) return fail("SOURCE_CHANNEL_TIME_INVALID");
      verifiedUntil = expiresAt;
      verified = new Map(releases.map((release) => [release.name, JSON.stringify(release)]));
      return releases;
    } catch (error) {
      if (current === generation) verified.clear();
      throw error;
    }
  }
  function check(signal?: AbortSignal): Promise<PluginRelease[]> {
    const current = ++generation;
    verified.clear();
    const result = checks.then(() => performCheck(current, signal));
    checks = result.catch(() => undefined);
    return result;
  }
  function assertCurrentRelease(release: PluginRelease): void {
    if ((dependencies.now ?? Date.now)() >= verifiedUntil) {
      verified.clear();
      return fail("SOURCE_APPROVAL_EXPIRED");
    }
    if (verified.get(release.name) !== JSON.stringify(release))
      return fail("SOURCE_RELEASE_NOT_VERIFIED");
  }
  async function download(
    release: PluginRelease,
    cacheDirectory: string,
    signal?: AbortSignal,
  ): Promise<string> {
    assertCurrentRelease(release);
    if (!isAbsolute(cacheDirectory)) return fail("SOURCE_CACHE_ABSOLUTE_REQUIRED");
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    if (
      !(await lstat(cacheDirectory)).isDirectory() ||
      (await lstat(cacheDirectory)).isSymbolicLink()
    )
      return fail("SOURCE_CACHE_INVALID");
    await chmod(cacheDirectory, 0o700);
    const target = join(cacheDirectory, release.artifact.sha256 + ".tgz");
    async function validate(path: string) {
      const entry = await lstat(path);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.size !== release.artifact.size ||
        hash(await readFile(path)) !== release.artifact.sha256
      )
        return fail("SOURCE_ARTIFACT_HASH_MISMATCH");
      if (!sameGraph(await inspectPluginArchive(path, signal), release))
        return fail("SOURCE_ARCHIVE_RELEASE_MISMATCH");
    }
    try {
      await validate(target);
      await chmod(target, 0o600);
      return target;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (release.artifact.size > 256 * 1024 * 1024) return fail("SOURCE_SIZE_LIMIT");
    const partial = join(cacheDirectory, release.artifact.sha256 + "." + randomUUID() + ".partial");
    try {
      const response = await request(
        allowedUrl(release.artifact.url, config, release.artifact.sha256),
        signal,
      );
      const bytes = await boundedBytes(response, release.artifact.size, signal);
      if (bytes.length !== release.artifact.size || hash(bytes) !== release.artifact.sha256)
        return fail("SOURCE_ARTIFACT_HASH_MISMATCH");
      const file = await open(partial, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await validate(partial);
      signal?.throwIfAborted();
      await commitFile(partial, target);
      const directory = process.platform === "win32" ? null : await open(cacheDirectory, "r");
      try {
        await directory?.sync();
      } finally {
        await directory?.close();
      }
      return target;
    } finally {
      await rm(partial, { force: true });
    }
  }
  return { check, download, assertCurrentRelease };
}
