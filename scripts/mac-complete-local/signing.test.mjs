import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, stat, lstat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  adaptCompanyMacFactory,
  configureSignedCompanyMac,
  companyMacDownloadPrefix,
  companyMacUpdateUrl,
  runSignedMacBuild,
  companyMacSigningDirectory,
} from "./signing.mjs";

test("unknown options cannot turn a requested plan into an actual build", async () => {
  await assert.rejects(
    runSignedMacBuild("missing-core", "missing-gea", "missing-input", ["--plna"]),
    /UNSUPPORTED_SIGNED_MAC_OPTION/,
  );
});

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), "gea-mac-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "factory.mjs");
  await writeFile(path, adaptCompanyMacFactory(source));
  return import(pathToFileURL(path).href);
}

test("default company distribution retains signing and notarization without upstream services", async (t) => {
  const { create } = await fixture(
    t,
    `
export function create(env) {
  const policy = resolveDesktopPolicyEnvironment(env)
  const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  if (!env.identity) throw Error('missing signing identity');
  if (!env.notary) throw Error('missing notarization credentials');
  return {policy, update, identity: env.identity, notary: env.notary};
}`,
  );
  assert.throws(() => create({}), /missing signing identity/);
  assert.throws(() => create({ identity: "company" }), /missing notarization credentials/);
  assert.deepEqual(create({ identity: "company", notary: "API" }), {
    policy: undefined,
    update: { publicUrl: companyMacUpdateUrl },
    identity: "company",
    notary: "API",
  });
  assert.equal(
    new URL(companyMacDownloadPrefix).hostname,
    "synear-gea.oss-cn-hangzhou.aliyuncs.com",
  );
  assert.throws(() => adaptCompanyMacFactory("different Core factory"), /ADAPTER_DRIFT/);
});

test("default signed delivery retains Core verification and Apple rejection without unsigned fallback", async () => {
  const calls = [];
  const base = {
    mac: {
      identity: "company",
      hardenedRuntime: true,
      forceCodeSigning: true,
      entitlements: "/core/entitlements.plist",
      signIgnore: ["pre-signed-native-runtime"],
      notarize: true,
      target: ["dmg", "zip"],
    },
    dmg: { sign: true },
    extraMetadata: { main: "official-main.cjs", dshBuildCommit: "core" },
    afterPack: async () => calls.push("runtime-integrity"),
    afterSign: async () => calls.push("identity-verification"),
    artifactBuildCompleted: async ({ file }) => {
      calls.push("notarize:" + file);
      throw Error("Apple rejected DMG");
    },
    publish: [{ provider: "generic", url: "https://upstream.example/" }],
  };
  const config = configureSignedCompanyMac(base, "gea");
  assert.deepEqual(config.mac, base.mac);
  assert.deepEqual(config.publish, [
    { provider: "generic", url: companyMacUpdateUrl, channel: "nightly" },
  ]);
  assert.equal(config.dmg.writeUpdateInfo, true);
  assert.throws(
    () => configureSignedCompanyMac({ ...base, mac: { ...base.mac, identity: "-" } }, "gea"),
    /IDENTITY_REQUIRED/,
  );
  assert.throws(
    () => configureSignedCompanyMac({ ...base, mac: { ...base.mac, notarize: false } }, "gea"),
    /SECURITY_REQUIRED/,
  );
  assert.throws(
    () => configureSignedCompanyMac({ ...base, artifactBuildCompleted: undefined }, "gea"),
    /VERIFIER_REQUIRED/,
  );
  assert.match(config.artifactName, /signed/);
  assert.equal(config.extraMetadata.main, "official-main.cjs");
  assert.equal(config.extraMetadata.dshLocalTestBuild, false);
  await config.afterPack();
  await config.afterSign();
  await assert.rejects(config.artifactBuildCompleted({ file: "company.dmg" }), /Apple rejected/);
  assert.deepEqual(calls, ["runtime-integrity", "identity-verification", "notarize:company.dmg"]);
  assert.deepEqual(base.mac.target, ["dmg", "zip"]);
});

test("online company packages retain sealed updater configuration and signed ZIP delivery", async (t) => {
  const source = `
export function create(env) {
  const policy = resolveDesktopPolicyEnvironment(env)
  const update = unsigned ? undefined : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  return {policy, update};
}`;
  const root = await mkdtemp(join(tmpdir(), "gea-mac-online-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "factory.mjs");
  await writeFile(path, adaptCompanyMacFactory(source, true));
  const { create } = await import(pathToFileURL(path).href);
  assert.deepEqual(create({}), { policy: undefined, update: { publicUrl: companyMacUpdateUrl } });
  const afterPack = () => {};
  const afterSign = () => {};
  const artifactBuildCompleted = () => {};
  const config = configureSignedCompanyMac(
    {
      mac: { identity: "company", hardenedRuntime: true, forceCodeSigning: true, notarize: true },
      dmg: {},
      afterPack,
      afterSign,
      artifactBuildCompleted,
    },
    "gea",
    true,
  );
  assert.deepEqual(config.mac.target, ["dmg", "zip"]);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.deepEqual(config.publish, [
    { provider: "generic", url: companyMacUpdateUrl, channel: "nightly" },
  ]);
  assert.equal(config.dmg.writeUpdateInfo, true);
  assert.equal(config.afterPack, afterPack);
  assert.equal(config.afterSign, afterSign);
  assert.equal(config.artifactBuildCompleted, artifactBuildCompleted);
});

test("default package commands use the retained private signing directory", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.scripts["package:desktop:mac"],
    "node scripts/mac-complete-local/signing.mjs",
  );
  assert.equal(
    companyMacSigningDirectory({}),
    join(homedir(), "Library/Application Support/GEA/signing"),
  );
  assert.equal(
    companyMacSigningDirectory({ GEA_MAC_SIGNING_CONFIG_DIR: "/private/ci-signing" }),
    "/private/ci-signing",
  );
});

import { prepareMacSigningCredentials, cleanupMacSigningCredentials } from "./ci-signing.mjs";

async function signingFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-ci-signing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    RUNNER_TEMP: root,
    GEA_MACOS_SIGNING_P12_BASE64: Buffer.from("certificate fixture").toString("base64"),
    GEA_MACOS_NOTARY_KEY_BASE64: Buffer.from("API private key fixture").toString("base64"),
    GEA_MACOS_SIGNING_ENV: [
      "DSH_DESKTOP_APP_ID=com.cleverc2200.gea.desktop",
      "DSH_DESKTOP_MACOS_SIGNING_IDENTITY=company",
      "DSH_DESKTOP_MACOS_TEAM_ID=TEAM",
      "CSC_LINK=developer-id-application.p12",
      "CSC_KEY_PASSWORD=private-fixture-password",
      "APPLE_API_KEY=AuthKey.p8",
      "APPLE_API_KEY_ID=KEY",
      "APPLE_API_ISSUER=ISSUER",
    ].join("\n"),
  };
}

test("CI materializes credentials privately and removes only its owned configuration", async (t) => {
  const env = await signingFixture(t);
  const dir = await prepareMacSigningCredentials(env);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  for (const name of [".env.macos", "developer-id-application.p12", "AuthKey.p8"])
    assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(dir, ".env.macos"), "utf8"), env.GEA_MACOS_SIGNING_ENV);
  await assert.rejects(prepareMacSigningCredentials(env), { code: "EEXIST" });
  await cleanupMacSigningCredentials(env);
  await assert.rejects(lstat(dir), { code: "ENOENT" });
  await cleanupMacSigningCredentials(env);
});

test("missing or malformed credentials refuse signing before writing secret files", async (t) => {
  const env = await signingFixture(t);
  const dir = join(env.RUNNER_TEMP, "gea-macos-signing");
  for (const bad of [
    { ...env, GEA_MACOS_SIGNING_P12_BASE64: undefined },
    { ...env, GEA_MACOS_NOTARY_KEY_BASE64: "!invalid!" },
    {
      ...env,
      GEA_MACOS_SIGNING_ENV: env.GEA_MACOS_SIGNING_ENV.replace("AuthKey.p8", "/outside/AuthKey.p8"),
    },
  ]) {
    await assert.rejects(prepareMacSigningCredentials(bad));
    await assert.rejects(lstat(dir), { code: "ENOENT" });
  }
});
