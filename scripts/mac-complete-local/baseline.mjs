export const macBaseline = Object.freeze({
  coreHead: "8cfb899ccf21d3662421b99b5f4627842ef712ea",
  url: "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/8cfb899ccf21d3662421b99b5f4627842ef712ea/desktop/GEA-Desktop-0.2.0-rc.2.20261020.5-mac-arm64-local.dmg",
  sha256: "37176852122eea5a326f958ad96a240a12aadcb7fbb6166070cbacff0ec6b5db",
});

export function assertMacBaseline(coreHead, baseline = macBaseline) {
  if (baseline.coreHead !== coreHead)
    throw Error(
      `DESKTOP_MAC_BASELINE_CORE_MISMATCH: rebuild the complete macOS baseline from Core ${coreHead} and update scripts/mac-complete-local/baseline.mjs before repackaging plugins; existing baseline uses ${baseline.coreHead}`,
    );
}
