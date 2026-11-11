import { build } from "esbuild";
const { outputFiles } = await build({
  stdin: {
    contents:
      "export { GeaRequestCapture } from './src/host/request-capture.ts'; export { GeaApiLogCenter } from './src/host/api-log.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
export const { GeaRequestCapture, GeaApiLogCenter } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
