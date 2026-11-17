export const macBaseline = Object.freeze({
  coreHead: "6156856b3a33ad2d408c2cf8162df1b32371c3d7",
  url: "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/6156856b3a33ad2d408c2cf8162df1b32371c3d7/desktop/GEA-Desktop-0.2.0-rc.2.20261103.2-mac-arm64-core615-baseline.dmg",
  sha256: "1b906dd068b9ad1ad5ef1ad2e3299efbe18fc1c208630ca8a3eaf2cddc75c6fa",
});

export function assertMacBaseline(coreHead, baseline = macBaseline) {
  if (baseline.coreHead !== coreHead)
    throw Error(
      `DESKTOP_MAC_BASELINE_CORE_MISMATCH: rebuild the complete macOS baseline from Core ${coreHead} and update scripts/mac-complete-local/baseline.mjs before repackaging plugins; existing baseline uses ${baseline.coreHead}`,
    );
}
