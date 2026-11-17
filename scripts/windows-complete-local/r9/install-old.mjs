import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const { installCompanyPackages } = await import(pathToFileURL(input.helperFile));
const result = await installCompanyPackages({
  root: input.root,
  support: input.support,
  home: input.home,
  profile: input.profile,
  store: input.store,
  packages: input.artifacts.map((row) => row.file),
  offline: false,
  strictPeers: true,
});
assert.equal(result.exitCode, 0, "OFFICIAL_OLD_PROFILE_INSTALL_FAILED");
