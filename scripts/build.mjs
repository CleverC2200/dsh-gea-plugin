import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

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
  loader: { ".css": "css", ".module.css": "local-css", ".png": "dataurl" },
});

await mkdir("packages/agent-workbench/lib", { recursive: true });
await build({
  entryPoints: ["packages/agent-workbench/src/host.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: "packages/agent-workbench/lib/host.js",
});
const workbench = await build({
  entryPoints: ["packages/agent-workbench/src/client.ts"],
  bundle: true,
  write: false,
  outfile: "client.js",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["react", "@deepseek-ai/dsh-client-store"],
  loader: { ".module.css": "local-css" },
});
const workbenchCode = workbench.outputFiles.find((file) =>
  file.path.endsWith(".js"),
).text;
const workbenchCss =
  workbench.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
await writeFile(
  "packages/agent-workbench/lib/client.js",
  `window.__ModuleLoader__.load({id:"@cleverc2200/dsh-agent-workbench",factory:(require)=>{var module={exports:{}};var exports=module.exports;const style=document.createElement("style");style.textContent=${JSON.stringify(workbenchCss)};document.head.append(style);\n${workbenchCode}\nreturn module.exports;}});\n`,
);

await mkdir("packages/workbench-example/lib", { recursive: true });
await build({
  entryPoints: ["packages/workbench-example/src/host.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: "packages/workbench-example/lib/host.js",
});
const example = await build({
  entryPoints: ["packages/workbench-example/src/client.tsx"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  external: ["react"],
});
await writeFile(
  "packages/workbench-example/lib/client.js",
  `window.__ModuleLoader__.load({id:"@cleverc2200/dsh-workbench-example",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${example.outputFiles[0].text}\nreturn module.exports;}});\n`,
);

execFileSync(
  process.execPath,
  [
    "node_modules/typescript/bin/tsc",
    "-p",
    "packages/agent-workbench/tsconfig.json",
  ],
  { stdio: "inherit" },
);
