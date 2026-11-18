import semver from "semver";
import { parse } from "yaml";
import { desktopCoreHead, resolveDesktopAcceptanceSource } from "./input.mjs";
import { companyWindowsUpdateUrl } from "./signing.mjs";

export function readOnlineUpgradeTarget(
  build,
  { sourceSha, qualifiedSourceSha, checkout, baselineVersion },
) {
  const source = resolveDesktopAcceptanceSource(sourceSha, qualifiedSourceSha, checkout);
  const version = build?.packaged?.version;
  if (
    build?.status !== "packaged-and-runtime-smoke-passed" ||
    build.unsigned !== false ||
    build.geaSha !== source ||
    build.coreSha !== desktopCoreHead ||
    build.coreSourceUnchanged !== true ||
    build.windowsHost !== "win32-x64" ||
    !semver.valid(version) ||
    !semver.valid(baselineVersion) ||
    !semver.gt(version, baselineVersion) ||
    !["GEA-Desktop", "Synear-GEA"].some(
      (brand) => build.artifact === `${brand}-${version}-win-x64-signed.exe`,
    ) ||
    !/^[a-f0-9]{64}$/.test(build.sha256 ?? "") ||
    build.sha256 === "0".repeat(64) ||
    !Number.isSafeInteger(build.size) ||
    build.size <= 0 ||
    build.windowsSigning?.updateUrl !== companyWindowsUpdateUrl ||
    !/^[a-f0-9]{2}(?::[a-f0-9]{2}){31}$/i.test(build.windowsSigning?.fingerprint ?? "")
  )
    throw Error("DESKTOP_ONLINE_TARGET_INVALID");
  return Object.freeze({
    version,
    artifact: build.artifact,
    sha256: build.sha256,
    size: build.size,
    sourceSha: source,
    coreSha: build.coreSha,
    fingerprint: build.windowsSigning.fingerprint.toUpperCase(),
    feedUrl: `${companyWindowsUpdateUrl}nightly.yml`,
  });
}

export function verifyOnlineUpgradeFeed(metadata, target) {
  let feed;
  try {
    feed = parse(metadata);
  } catch {
    throw Error("DESKTOP_ONLINE_FEED_CHANGED");
  }
  if (
    feed?.version !== target.version ||
    feed.path !== target.artifact ||
    !Array.isArray(feed.files) ||
    feed.files.length !== 1 ||
    feed.files[0]?.url !== target.artifact ||
    feed.files[0]?.size !== target.size ||
    typeof target.sha512 !== "string" ||
    Buffer.from(target.sha512, "base64").length !== 64 ||
    feed.sha512 !== target.sha512 ||
    feed.files[0]?.sha512 !== target.sha512
  )
    throw Error("DESKTOP_ONLINE_FEED_CHANGED");
}
