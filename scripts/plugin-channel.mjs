import { createHash } from "node:crypto";
import { parsePluginChannel, mergePluginChannelRelease } from "../src/shared/plugin-release.mjs";
import { runPluginReleasePreflight } from "./plugin-release-preflight.mjs";
export { mergePluginChannelRelease };
export async function createPluginSuiteChannel({
  previous,
  preflightInput,
  references,
  revision,
  issuedAt,
  expiresAt,
  desktopCore,
}) {
  const checked = await runPluginReleasePreflight(preflightInput, {
    desktopCore,
  });
  const channel = parsePluginChannel(previous);
  if (
    !checked.targets.some(
      ({ release }) =>
        release.name === "@cleverc2200/gea-dsh-prototype" && release.updateStrategy === "suite",
    )
  )
    throw Error("CHANNEL_SUITE_UPDATER_REQUIRED");
  if (!Number.isSafeInteger(revision) || revision <= channel.revision)
    throw Error("CHANNEL_REVISION_REQUIRED");
  if (!Array.isArray(references) || references.length !== checked.targets.length)
    throw Error("CHANNEL_SUITE_TARGET_MISMATCH");
  for (const { release } of checked.targets) {
    const hash = createHash("sha256")
      .update(JSON.stringify(release, null, 2) + "\n")
      .digest("hex");
    if (references.filter((row) => row.name === release.name && row.sha256 === hash).length !== 1)
      throw Error("CHANNEL_SUITE_TARGET_MISMATCH");
  }
  return parsePluginChannel({
    schema: 1,
    suite: true,
    channel: channel.channel,
    revision,
    issuedAt,
    expiresAt,
    releases: references.filter((row) => row.name === "@cleverc2200/gea-dsh-prototype"),
    companionReleases: references.filter((row) => row.name !== "@cleverc2200/gea-dsh-prototype"),
  });
}
export function encodePluginChannel({ payload }) {
  const channel = parsePluginChannel(payload);
  return {
    payloadBase64: Buffer.from(JSON.stringify(channel)).toString("base64"),
  };
}
