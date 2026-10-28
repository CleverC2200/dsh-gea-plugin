export const macBaseline = Object.freeze({
  coreHead: "a0c0d2ff884b1808eccb9bb254a1659281364d7d",
  url: "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/db85af3c71bf7825e6546eef45daf72028dd957f/desktop/GEA-Desktop-0.2.0-rc.2.20261024.3-mac-arm64-local.dmg",
  sha256: "663ced21d557d0776a507c4ee369e0abe6c21471d19e898d67c753f69bee1282",
});

export function assertMacBaseline(coreHead, baseline = macBaseline) {
  if (baseline.coreHead !== coreHead)
    throw Error(
      `DESKTOP_MAC_BASELINE_CORE_MISMATCH: rebuild the complete macOS baseline from Core ${coreHead} and update scripts/mac-complete-local/baseline.mjs before repackaging plugins; existing baseline uses ${baseline.coreHead}`,
    );
}
