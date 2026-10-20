import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runPluginReleasePreflight, readReleaseDesktopCore } from "./plugin-release-preflight.mjs";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    "base-tag": { type: "string" },
    desktop: { type: "boolean" },
    "desktop-core-proof": { type: "string" },
  },
});
if (values.desktop) {
  const base = values["base-tag"];
  if (!base) throw Error("RELEASE_BASE_TAG_REQUIRED");
  const run = (...command) =>
    execFileSync(command[0], command.slice(1), { encoding: "utf8" }).trim();
  if (run("git", "status", "--porcelain")) throw Error("RELEASE_DIRTY");
  const manifest = JSON.parse(readFileSync("desktop/package.json", "utf8"));
  const previous = JSON.parse(run("git", "show", `${base}:desktop/package.json`));
  if (manifest.version === previous.version) throw Error(`VERSION_UNCHANGED: ${manifest.version}`);
  console.log(
    JSON.stringify({
      baseTag: base,
      baseCommit: run("git", "rev-parse", base),
      head: run("git", "rev-parse", "HEAD"),
      version: manifest.version,
    }),
  );
} else {
  console.log(
    JSON.stringify(
      await runPluginReleasePreflight(values.input, {
        desktopCore: await readReleaseDesktopCore(values["desktop-core-proof"]),
      }),
    ),
  );
}
