import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

export const companyMacDownloadPrefix =
  "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/";

export const companyMacUpdateUrl =
  "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/mac-arm64/";

export function adaptCompanyMacFactory(source) {
  for (const before of [
    "const policy = resolveDesktopPolicyEnvironment(env)",
    "const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)",
  ]) {
    assert.equal(source.split(before).length, 2, "SIGNED_MAC_CONFIG_ADAPTER_DRIFT");
    source = source.replace(
      before,
      before.slice(0, before.indexOf("=")) +
        (before.startsWith("const update")
          ? "= " + JSON.stringify({ publicUrl: companyMacUpdateUrl })
          : "= undefined"),
    );
  }
  return source;
}

export function configureSignedCompanyMac(config, geaSha) {
  assert.ok(config.mac?.identity && config.mac.identity !== "-", "MAC_RELEASE_IDENTITY_REQUIRED");
  for (const name of ["hardenedRuntime", "forceCodeSigning", "notarize"])
    assert.equal(config.mac[name], true, "MAC_RELEASE_SECURITY_REQUIRED: " + name);
  for (const name of ["afterPack", "afterSign", "artifactBuildCompleted"])
    assert.equal(typeof config[name], "function", "MAC_RELEASE_VERIFIER_REQUIRED: " + name);
  return {
    ...config,
    artifactName: "GEA-Desktop-${version}-mac-${arch}-signed.${ext}",
    extraMetadata: {
      ...config.extraMetadata,
      geaBrandingCommit: geaSha,
      dshLocalTestBuild: false,
      dshLocalPackaging: "company-core-full-three-plugin-developer-id",
    },
    mac: { ...config.mac, target: ["dmg", "zip"] },
    dmg: { ...config.dmg, sign: true, writeUpdateInfo: true },
    publish: [{ provider: "generic", url: companyMacUpdateUrl, channel: "nightly" }],
  };
}

export function finalizeCompanyMacUpdateManifest(manifest, version, zip, dmg) {
  assert.equal(manifest.version, version, "MAC_UPDATE_VERSION_MISMATCH");
  assert.equal(manifest.path, zip.name, "MAC_UPDATE_ZIP_REQUIRED");
  assert.deepEqual(
    manifest.files.map(({ url }) => url).sort(),
    [zip.name, dmg.name].sort(),
    "MAC_UPDATE_FILES_MISMATCH",
  );
  const archived = manifest.files.find(({ url }) => url === zip.name);
  assert.equal(archived.size, zip.size, "MAC_UPDATE_ZIP_SIZE_MISMATCH");
  assert.equal(archived.sha512, zip.sha512, "MAC_UPDATE_ZIP_HASH_MISMATCH");
  assert.equal(manifest.sha512, zip.sha512, "MAC_UPDATE_ZIP_HASH_MISMATCH");
  return {
    ...manifest,
    files: manifest.files.map((file) =>
      file.url === dmg.name ? { ...file, size: dmg.size, sha512: dmg.sha512 } : file,
    ),
  };
}

export function companyMacSigningDirectory(environment = process.env) {
  return environment.GEA_MAC_SIGNING_CONFIG_DIR
    ? resolve(environment.GEA_MAC_SIGNING_CONFIG_DIR)
    : join(homedir(), "Library/Application Support/GEA/signing");
}

export async function withCompanyMacSigning(core, environment, action) {
  const desktop = join(resolve(core), "apps/desktop");
  const load = (name) => import(pathToFileURL(join(desktop, "scripts", name)).href);
  const { loadDesktopPackageEnvironment } = await load("desktop-package-environment.mjs");
  const {
    resolveDesktopAppId,
    resolveMacOSSigningEnvironment,
    resolveMacOSNotarizationEnvironment,
  } = await load("desktop-release-environment.mjs");
  const { withMacOSSigningKeychain } = await load("macos-signing-keychain.mjs");
  const settings = loadDesktopPackageEnvironment(
    "darwin",
    environment,
    companyMacSigningDirectory(environment),
  );
  assert.equal(
    resolveDesktopAppId(settings),
    "com.cleverc2200.gea.desktop",
    "COMPANY_MAC_APP_ID_MISMATCH",
  );
  const expected = resolveMacOSSigningEnvironment(settings);
  const strategies = [
    ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
    ["APPLE_KEYCHAIN_PROFILE", "APPLE_KEYCHAIN"],
  ];
  assert.equal(
    strategies.filter((names) => names.some((name) => settings[name] !== undefined)).length,
    1,
    "CONFIGURE_ONE_MAC_NOTARIZATION_STRATEGY",
  );
  const credentials = resolveMacOSNotarizationEnvironment(settings);
  for (const file of [settings.CSC_LINK, credentials.appleApiKey, credentials.keychain].filter(
    Boolean,
  )) {
    assert.ok((await stat(file)).isFile(), "MAC_SIGNING_FILE_REQUIRED");
    await access(file, constants.R_OK);
  }
  await withMacOSSigningKeychain(settings, (child) => action(child, expected));
}

export async function runSignedMacBuild(core, gea, input, flags = [], environment = process.env) {
  assert.ok(
    flags.every((flag) => ["--plan", "--candidate", "--online-update"].includes(flag)),
    "UNSUPPORTED_SIGNED_MAC_OPTION",
  );
  await withCompanyMacSigning(
    core,
    environment,
    (child) =>
      new Promise((done, reject) => {
        const childProcess = spawn(
          process.execPath,
          [
            fileURLToPath(new URL("./full-source.mjs", import.meta.url)),
            resolve(core),
            resolve(gea),
            resolve(input),
            ...flags,
          ],
          {
            cwd: resolve(core),
            env: {
              ...child,
              GEA_MAC_SIGNED: "1",
              GEA_MAC_ONLINE_UPDATE: "1",
            },
            stdio: "inherit",
          },
        );
        childProcess.once("error", reject);
        childProcess.once("close", (code, signal) =>
          code === 0 ? done() : reject(Error(`SIGNED_MAC_BUILD_FAILED (${signal ?? code})`)),
        );
      }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [core, gea, input, ...flags] = process.argv.slice(2);
  if (core && gea === "--check") {
    await withCompanyMacSigning(core, process.env, async (_child, expected) => {
      console.log(
        JSON.stringify({
          status: "signing-probe-passed",
          ...expected,
          distribution: "dmg-and-online-update",
          downloadPrefix: companyMacDownloadPrefix,
        }),
      );
    });
  } else {
    assert.ok(
      core && gea && input,
      "Usage: node signing.mjs <core> --check | <core> <gea> <input> [--plan] [--candidate] [--online-update]",
    );
    await runSignedMacBuild(core, gea, input, flags);
  }
}
