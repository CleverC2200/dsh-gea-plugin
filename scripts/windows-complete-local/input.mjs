import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { companyPackageNames, comparePluginVersions } from "../../src/shared/plugin-release.mjs";

export const desktopCoreHead = "6f88c3ea2d266ba1825d88bab10d92479a6ffde8";
export const coreArtifactPaths = [
  "package.json",
  "lib/main.js",
  "dsh/package.json",
  ...[
    "dsh",
    "dsh-desktop-host",
    "dsh-app-boot",
    "cordis",
    "dsh-plugin-manager",
    "dsh-atomic-write",
  ].flatMap((name) => [
    `dsh/node_modules/@deepseek-ai/${name}/package.json`,
    ...(name === "dsh" ? [] : [`dsh/node_modules/@deepseek-ai/${name}/lib/index.js`]),
  ]),
  "dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/types/operations.js",
];
const oss = "https://synear-gea.oss-cn-hangzhou.aliyuncs.com";
const validSha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) && value !== "0".repeat(64);

export async function readDesktopInput(file, sourceSha) {
  const input = JSON.parse(await readFile(file, "utf8"));
  const packages = input?.seed?.packages;
  if (
    !Array.isArray(packages) ||
    packages.length !== 3 ||
    new Set(packages.map((row) => row?.name)).size !== 3 ||
    !companyPackageNames.every((name) => packages.some((row) => row?.name === name))
  )
    throw Error("DESKTOP_THREE_PACKAGES_REQUIRED");
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "") || input.geaSourceSha !== sourceSha)
    throw Error("DESKTOP_SOURCE_MISMATCH");
  if (input.schemaVersion !== 1) throw Error("DESKTOP_INPUT_INVALID");
  if (input.pluginSourceSha !== undefined && !/^[a-f0-9]{40}$/.test(input.pluginSourceSha ?? ""))
    throw Error("DESKTOP_PLUGIN_SOURCE_INVALID");
  try {
    if (
      typeof input.desktopVersion !== "string" ||
      !input.desktopVersion.startsWith("0.2.0-rc.2.") ||
      input.desktopVersion.includes("+") ||
      comparePluginVersions(input.desktopVersion, "0.2.0-rc.2.20261018.1") <= 0
    )
      throw Error();
  } catch {
    throw Error("DESKTOP_VERSION_INVALID");
  }
  const core = input.seed.core;
  if (
    ![desktopCoreHead, "8cfb899ccf21d3662421b99b5f4627842ef712ea"].includes(core?.head) ||
    core.version !== "0.2.0-rc.2" ||
    !Array.isArray(core.artifacts) ||
    core.artifacts.length !== coreArtifactPaths.length ||
    new Set(core.artifacts.map((row) => row?.path)).size !== coreArtifactPaths.length ||
    !coreArtifactPaths.every((path) =>
      core.artifacts.some((row) => row.path === path && validSha(row.sha256)),
    )
  )
    throw Error("DESKTOP_CORE_INVALID");
  for (const row of packages) {
    const file = `${row.name.replace(/^@/, "").replace("/", "-")}-${row.version}.tgz`;
    try {
      comparePluginVersions(row.version, row.version);
      if (
        !validSha(row.sha256) ||
        row.url !== `${oss}/plugin-release/packages/${row.sha256}/${file}`
      )
        throw Error();
    } catch {
      throw Error("DESKTOP_ARCHIVE_BINDING_INVALID");
    }
  }
  const source = input.seed.source;
  if (
    source?.channel !== "stable" ||
    source.channelUrl !== `${oss}/plugin-release/channels/plugin-detail-stable.json` ||
    source.authenticationRef !== "anonymous" ||
    JSON.stringify(source.allowed) !==
      JSON.stringify([{ origin: oss, pathPrefix: "/plugin-release/" }]) ||
    source.trustedKeys?.length !== 1 ||
    source.trustedKeys[0].keyId !== "plugin-detail-test-20261015" ||
    source.trustedKeys[0].publicKeyPem !==
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA4yJrjMTO0WzaKJzheHiMpGj5BamQ7eE1Xy3JQp7zIP0=\n-----END PUBLIC KEY-----\n"
  )
    throw Error("DESKTOP_SOURCE_CONFIG_CHANGED");
  return {
    schemaVersion: 1,
    geaSourceSha: input.geaSourceSha,
    ...(input.pluginSourceSha === undefined ? {} : { pluginSourceSha: input.pluginSourceSha }),
    desktopVersion: input.desktopVersion,
    seed: {
      packages: packages.map(({ name, version, url, sha256 }) => ({ name, version, url, sha256 })),
      core: {
        head: core.head,
        version: core.version,
        artifacts: core.artifacts.map(({ path, sha256 }) => ({ path, sha256 })),
      },
      source: {
        channel: source.channel,
        channelUrl: source.channelUrl,
        authenticationRef: source.authenticationRef,
        allowed: source.allowed,
        trustedKeys: source.trustedKeys,
      },
    },
  };
}
export function readDesktopPluginSource(input, checkout) {
  const head = input.pluginSourceSha ?? input.geaSourceSha;
  try {
    if (!/^[a-f0-9]{40}$/.test(head ?? "")) throw Error();
    execFileSync("git", ["merge-base", "--is-ancestor", head, input.geaSourceSha], {
      cwd: checkout,
      stdio: "pipe",
    });
    const manifest = JSON.parse(
      execFileSync("git", ["show", head + ":package.json"], { cwd: checkout, encoding: "utf8" }),
    );
    if (
      manifest.name !== "@cleverc2200/gea-dsh-prototype" ||
      !input.seed.packages.some(
        (row) => row.name === manifest.name && row.version === manifest.version,
      )
    )
      throw Error();
    return { head, name: manifest.name, version: manifest.version };
  } catch {
    throw Error("DESKTOP_GEA_PACKAGE_SOURCE_MISMATCH");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { input: { type: "string" }, "source-sha": { type: "string" } },
  });
  const input = await readDesktopInput(values.input, values["source-sha"]);
  console.log(
    JSON.stringify({
      status: "input-validated",
      built: false,
      desktopVersion: input.desktopVersion,
      geaSourceSha: input.geaSourceSha,
      packages: input.seed.packages,
    }),
  );
}
