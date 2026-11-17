import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const magics = new Set([
  "cafebabe",
  "cafebabf",
  "cefaedfe",
  "cffaedfe",
  "feedface",
  "feedfacf",
  "bebafeca",
  "bfbafeca",
]);

export async function signAdHocRuntime(root, entitlements) {
  let count = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const handle = await open(file, "r"),
          header = Buffer.alloc(4);
        try {
          await handle.read(header, 0, 4, 0);
        } finally {
          await handle.close();
        }
        if (!magics.has(header.toString("hex"))) continue;
        await run("/usr/bin/codesign", [
          "--force",
          "--sign",
          "-",
          "--timestamp=none",
          "--entitlements",
          entitlements,
          file,
        ]);
        await run("/usr/bin/codesign", ["--verify", "--strict", file]);
        count++;
      }
    }
  }
  await visit(root);
  console.log(`Ad-hoc signed and verified ${count} native runtime files`);
  return count;
}

export async function createAdHocPreparation(core) {
  const original = join(core, "apps/desktop/scripts/prepare-dsh.ts");
  let source = await readFile(original, "utf8");
  const entitlements = JSON.stringify(join(core, "apps/desktop/scripts/macos-entitlements.plist"));
  for (const root of ["DSH_OUTPUT_ROOT", "join(RUNTIME_ROOT, 'primary-runtime')"]) {
    const before = `signMacOSRuntime(${root}, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env), target.arch, join(BUILD_PATHS.root, 'signature-cache'))`;
    assert.equal(source.split(before).length, 2, "MAC_PREPARATION_ADAPTER_DRIFT");
    source = source.replace(before, `signAdHocRuntime(${root}, ${entitlements})`);
  }
  source = source
    .replace(
      /\b(from\s+|import\s*\()(['"])(\.{1,2}\/[^'"\n]+)\2/g,
      (_, prefix, quote, specifier) =>
        `${prefix}${quote}${pathToFileURL(resolve(dirname(original), specifier)).href}${quote}`,
    )
    .replaceAll("import.meta.dirname", JSON.stringify(dirname(original)))
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(original).href));
  return `import {signAdHocRuntime} from ${JSON.stringify(import.meta.url)};\n` + source;
}
