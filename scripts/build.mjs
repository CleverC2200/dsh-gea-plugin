import { holdBuildAdmission } from "./build-admission.mjs";
import { build, context } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "all" },
    watch: { type: "boolean", default: false },
  },
});
const selected = values.target === "all" ? ["host", "client"] : values.target.split(",");
for (const name of selected) {
  if (!["host", "client"].includes(name)) {
    throw new Error("UNKNOWN_BUILD_TARGET: " + name);
  }
}
holdBuildAdmission({ operation: values.watch ? "watch" : "build" });
execFileSync(process.execPath, ["scripts/generate-plugin-package-version.mjs"], {
  stdio: "inherit",
});
// One-shot and watch builds use identical wrappers and retain output on errors.
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

const targets = {
  host: [
    {
      entryPoints: ["src/host.ts"],
      bundle: true,
      packages: "external",
      format: "esm",
      platform: "node",
      target: "node22",
      outdir: "lib",
    },
  ],
  client: [
    {
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
      plugins: [clientOutput("lib/client.js", "'@cleverc2200/gea-dsh-prototype'")],
    },
  ],
};

const contexts = [];
try {
  for (const name of new Set(selected)) {
    for (const options of targets[name]) {
      if (values.watch) {
        const instance = await context(options);
        contexts.push(instance);
        await instance.watch();
      } else {
        await build(options);
      }
    }
  }
} catch (error) {
  await Promise.all(contexts.map((instance) => instance.dispose()));
  throw error;
}
if (values.watch) {
  console.log("Watching: " + [...new Set(selected)].join(", "));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.all(contexts.map((instance) => instance.dispose()));
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
