/** Build an isolated static mock demo; no GEA configuration or credentials are loaded. */
import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(".runtime/dms-demo");
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["demos/dms/main.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: resolve(output, "main.js"),
});
await copyFile("demos/dms/index.html", resolve(output, "index.html"));
console.log(output);
