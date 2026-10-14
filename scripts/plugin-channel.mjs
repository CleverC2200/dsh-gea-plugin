import { createPrivateKey, sign } from "node:crypto";
import { parsePluginChannel, mergePluginChannelRelease } from "../src/shared/plugin-release.mjs";
export { mergePluginChannelRelease };
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
