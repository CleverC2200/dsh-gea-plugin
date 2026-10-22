import { createHash, createPrivateKey, sign } from "node:crypto";
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
  const checked = await runPluginReleasePreflight(preflightInput, { desktopCore });
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
/** Explicit private key input only; this helper performs no storage or network writes. */
export function signPluginChannel({ payload, keyId, privateKeyPem }) {
  const channel = parsePluginChannel(payload),
    key = createPrivateKey(privateKeyPem);
  if (typeof keyId !== "string" || !keyId || key.asymmetricKeyType !== "ed25519")
    throw Error("CHANNEL_SIGNING_KEY_INVALID");
  const bytes = Buffer.from(JSON.stringify(channel));
  return {
    keyId,
    payloadBase64: bytes.toString("base64"),
    signatureBase64: sign(null, bytes, key).toString("base64"),
  };
}
