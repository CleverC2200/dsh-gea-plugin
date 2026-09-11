import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { prepareDshSource } from "./dsh-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await prepareDshSource(root);
await mkdir("lib", { recursive: true });
await build({
  entryPoints: ["src/host.ts"],
  bundle: true,
  packages: "external",
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "lib/host.js",
});
const output = await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["react"],
  loader: { ".css": "text" },
});
const code = output.outputFiles[0].text;
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:'@cleverc2200/gea-dsh-prototype',factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}});\n`,
);

await build({
  entryPoints: ["src/workbench-entry.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "lib/workbench.js",
  loader: { ".css": "text" },
});
