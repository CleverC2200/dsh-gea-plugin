import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { desktopCoreHead } from "./input.mjs";
import { companyWindowsUpdateUrl } from "./signing.mjs";
import { readOnlineUpgradeTarget, verifyOnlineUpgradeFeed } from "./online-upgrade-input.mjs";

const bytes = Buffer.from("published signed installer fixture");
const options = {
  sourceSha: "1".repeat(40),
  baselineVersion: "0.2.0-rc.2.20261030.2",
};
const receipt = (brand = "Synear-GEA", version = "0.2.0-rc.2.20261116.1") => ({
  status: "packaged-and-runtime-smoke-passed",
  unsigned: false,
  geaSha: options.sourceSha,
  coreSha: desktopCoreHead,
  coreSourceUnchanged: true,
  windowsHost: "win32-x64",
  packaged: { version },
  artifact: `${brand}-${version}-win-x64-signed.exe`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  windowsSigning: {
    updateUrl: companyWindowsUpdateUrl,
    fingerprint: Array(32).fill("AB").join(":"),
  },
});

test("online qualification freezes either published branding and version from the original build", () => {
  for (const [brand, version] of [
    ["GEA-Desktop", "0.2.0-rc.2.20261102.3"],
    ["Synear-GEA", "0.2.0-rc.2.20261116.1"],
  ]) {
    const build = receipt(brand, version);
    const target = readOnlineUpgradeTarget(build, options);
    assert.equal(target.version, version);
    assert.equal(target.artifact, build.artifact);
    assert.equal(target.sha256, build.sha256);
    assert.equal(target.feedUrl, `${companyWindowsUpdateUrl}nightly.yml`);
    build.packaged.version = "0.2.0-rc.2.20261117.1";
    assert.equal(target.version, version);
  }
});

test("online qualification refuses failed, unsigned, foreign, stale or incomplete build receipts", () => {
  for (const change of [
    (r) => {
      r.status = "failed";
    },
    (r) => {
      r.unsigned = true;
    },
    (r) => {
      r.geaSha = "2".repeat(40);
    },
    (r) => {
      r.coreSha = "2".repeat(40);
    },
    (r) => {
      r.coreSourceUnchanged = false;
    },
    (r) => {
      r.windowsHost = "darwin-arm64";
    },
    (r) => {
      r.packaged.version = options.baselineVersion;
    },
    (r) => {
      r.artifact = "../installer.exe";
    },
    (r) => {
      r.sha256 = "0".repeat(64);
    },
    (r) => {
      r.size = 0;
    },
    (r) => {
      r.windowsSigning.updateUrl = "https://example.invalid/";
    },
    (r) => {
      delete r.windowsSigning.fingerprint;
    },
  ]) {
    const build = receipt();
    change(build);
    assert.throws(() => readOnlineUpgradeTarget(build, options), /DESKTOP_ONLINE_TARGET_INVALID/);
  }
});

test("a newer or different live feed cannot change the frozen installer selected for acceptance", () => {
  const target = {
    ...readOnlineUpgradeTarget(receipt(), options),
    sha512: createHash("sha512").update(bytes).digest("base64"),
  };
  const metadata = {
    version: target.version,
    path: target.artifact,
    sha512: target.sha512,
    files: [{ url: target.artifact, sha512: target.sha512, size: target.size }],
  };
  verifyOnlineUpgradeFeed(stringify(metadata), target);
  for (const change of [
    (r) => {
      r.version = "0.2.0-rc.2.20261117.1";
    },
    (r) => {
      r.path = "another.exe";
    },
    (r) => {
      r.files[0].url = "another.exe";
    },
    (r) => {
      r.files[0].size++;
    },
    (r) => {
      r.files[0].sha512 = "different";
    },
    (r) => {
      r.sha512 = "different";
    },
    (r) => {
      r.files.push({ ...r.files[0] });
    },
  ]) {
    const altered = structuredClone(metadata);
    change(altered);
    assert.throws(
      () => verifyOnlineUpgradeFeed(stringify(altered), target),
      /DESKTOP_ONLINE_FEED_CHANGED/,
    );
  }
  assert.throws(() => verifyOnlineUpgradeFeed("[", target), /DESKTOP_ONLINE_FEED_CHANGED/);
});
