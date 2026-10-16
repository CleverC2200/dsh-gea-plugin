/** Emit one immutable release from the final tar manifest. Does not publish or update a channel. */
import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readPluginUpdateCore } from "../src/host/plugin-update-core.ts";
import { inspectPluginArchive } from "../src/host/plugin-release-source.ts";
import { projectPluginRelease } from "../src/shared/plugin-release.mjs";
import { findSupportedCore } from "./supported-cores.mjs";
const { values } = parseArgs({
  options: {
    archive: { type: "string" },
    metadata: { type: "string" },
    destination: { type: "string" },
    "desktop-core-proof": { type: "string" },
  },
});
if (
  ![values.archive, values.metadata, values.destination].every(
    (value) => typeof value === "string" && isAbsolute(value),
  )
)
  throw Error("RELEASE_ABSOLUTE_INPUTS_REQUIRED");
let desktopCore;
if (values["desktop-core-proof"] !== undefined) {
  if (!isAbsolute(values["desktop-core-proof"])) throw Error("RELEASE_ABSOLUTE_INPUTS_REQUIRED");
  const proof = JSON.parse(await readFile(values["desktop-core-proof"], "utf8"));
  if (proof?.kind !== "desktop" || typeof proof.root !== "string" || !isAbsolute(proof.root))
    throw Error("UPDATE_CORE_PROVENANCE_REQUIRED");
  // The resolver comes from this tool's fixed SDK, never executable code from the proof root.
  const { Context } = await import("@deepseek-ai/cordis");
  const { PluginPackages } = await import("@deepseek-ai/dsh-app-boot");
  const context = new Context();
  try {
    await context.plugin(PluginPackages);
    desktopCore = await readPluginUpdateCore(
      {
        profileContext: {
          installAnchor: join(proof.root, "dsh/node_modules/@deepseek-ai/dsh/package.json"),
        },
        fiber: {
          entry: {
            parent: {
              tree: { ctx: { baseUrl: pathToFileURL(join(proof.root, "dsh/package.json")).href } },
            },
          },
        },
        get: (name) => context.get(name),
      },
      proof,
    );
  } finally {
    await context.fiber.dispose();
  }
}
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
    published: false,
  }),
);
