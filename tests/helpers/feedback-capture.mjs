import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["src/host/request-capture.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
export const { GeaRequestCapture } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
