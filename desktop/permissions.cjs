/** Clipboard writes belong only to the current local workbench, never other origins. */
exports.allowPermission = (contents, permission, requestingUrl, origin, owner) => {
  if (!contents || contents !== owner || !origin || permission !== 'clipboard-sanitized-write') return false;
  try { return new URL(requestingUrl).origin === origin && new URL(contents.getURL()).origin === origin; }
  catch { return false; }
};
