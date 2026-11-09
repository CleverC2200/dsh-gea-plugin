import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  adaptCompanyMacFactory,
  configureSignedCompanyMac,
  companyMacDownloadPrefix,
  companyMacUpdateUrl,
  runSignedMacBuild,
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

test("manual company distribution needs signing and notarization but no upstream update services", async (t) => {
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
    update: undefined,
    identity: "company",
    notary: "API",
  });
  assert.equal(
    new URL(companyMacDownloadPrefix).hostname,
    "synear-gea.oss-cn-hangzhou.aliyuncs.com",
  );
  assert.throws(() => adaptCompanyMacFactory("different Core factory"), /ADAPTER_DRIFT/);
});

test("signed DMG retains Core identity verification and Apple notarization hooks without ZIP or publishing", async () => {
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
  assert.deepEqual(config.mac, { ...base.mac, target: ["dmg"] });
  assert.equal(config.publish, null);
  assert.equal(config.dmg.writeUpdateInfo, false);
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
      mac: { identity: "company", hardenedRuntime: true, notarize: true },
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
