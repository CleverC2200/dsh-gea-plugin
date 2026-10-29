import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function clientOutput(file, id) {
  return {
    name: "client-output",
    setup(builder) {
      builder.onEnd(async (result) => {
        if (result.errors.length) return;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(
          file,
          "window.__ModuleLoader__.load({id:" +
            id +
            ",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n" +
            result.outputFiles[0].text +
            "\nreturn module.exports;}});\n",
        );
      });
    },
  };
}

const clientExternals = [
  "react",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-primitives",
];

export function clientBuildOptions(output) {
  return {
    entryPoints: ["src/client.tsx"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external: clientExternals,
    loader: {
      ".css": "text",
      ".png": "dataurl",
      ".html": "text",
      ".txt": "text",
    },
    plugins: [clientOutput(output, "'@cleverc2200/gea-dsh-prototype'")],
  };
}
