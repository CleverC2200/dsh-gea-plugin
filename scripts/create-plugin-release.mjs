/** Emit one immutable release from the final tar manifest. Does not publish or update a channel. */
import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { inspectPluginArchive } from "../src/host/plugin-release-source.ts";
import { projectPluginRelease } from "../src/shared/plugin-release.mjs";
import { findSupportedCore } from "./supported-cores.mjs";
import { runPluginReleasePreflight, readReleaseDesktopCore } from "./plugin-release-preflight.mjs";
const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    metadata: { type: "string" },
    destination: { type: "string" },
    "desktop-core-proof": { type: "string" },
    preflight: { type: "string" },
  },
});
if (
  ![values.archive, values.metadata, values.destination].every(
    (value) => typeof value === "string" && isAbsolute(value),
  )
)
  throw Error("RELEASE_ABSOLUTE_INPUTS_REQUIRED");
if (!values.preflight || !isAbsolute(values.preflight))
  throw Error("RELEASE_PREFLIGHT_INPUT_REQUIRED");
const desktopCore = await readReleaseDesktopCore(values["desktop-core-proof"]);
const metadata = JSON.parse(await readFile(values.metadata, "utf8"));
if (
  !Array.isArray(metadata.supportedCores) ||
  !metadata.supportedCores.length ||
  !metadata.supportedCores.every(
    (core) =>
      findSupportedCore(core) ||
      (desktopCore && core?.head === desktopCore.head && core?.version === desktopCore.version),
  )
)
  throw Error("RELEASE_CORE_UNSUPPORTED");
const bytes = await readFile(values.archive);
const release = projectPluginRelease({
  manifest: await inspectPluginArchive(values.archive),
  artifact: {
    url: metadata.artifactUrl,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  },
  supportedCores: metadata.supportedCores,
  dataCompatibility: metadata.dataCompatibility,
  notes: metadata.notes,
});
const preflight = await runPluginReleasePreflight(values.preflight, { desktopCore });
const archivePath = await realpath(values.archive),
  metadataPath = await realpath(values.metadata);
let bound = false;
for (const target of preflight.targets) {
  if (
    (await realpath(target.archive)) === archivePath &&
    (await realpath(target.metadata)) === metadataPath &&
    JSON.stringify(target.release) === JSON.stringify(release)
  )
    bound = true;
}
if (!bound) throw Error("RELEASE_PREFLIGHT_TARGET_MISMATCH");
const content = Buffer.from(JSON.stringify(release, null, 2) + "\n");
const sha256 = createHash("sha256").update(content).digest("hex");
await mkdir(values.destination, { recursive: false, mode: 0o700 });
const path = join(values.destination, sha256 + ".release.json");
await writeFile(path, content, { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify({
    status: "release-projected",
    name: release.name,
    version: release.version,
    path,
    sha256,
    preflight,
    published: false,
  }),
);
