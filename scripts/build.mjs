import { build, context } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "all" },
    watch: { type: "boolean", default: false },
  },
});
const selected =
  values.target === "all"
    ? ["host", "client", "workbench", "example"]
    : values.target.split(",");
for (const name of selected) {
  if (!["host", "client", "workbench", "example"].includes(name)) {
    throw new Error("UNKNOWN_BUILD_TARGET: " + name);
  }
}

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

const targets = {
  host: [
    {
      entryPoints: ["src/host.ts", "src/skill-reference.ts"],
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
      external: ["react"],
      loader: { ".css": "text", ".png": "dataurl" },
      plugins: [
        clientOutput("lib/client.js", "'@cleverc2200/gea-dsh-prototype'"),
      ],
    },
  ],
  workbench: [
    {
      entryPoints: ["src/workbench-entry.tsx"],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outfile: "lib/workbench.js",
      loader: { ".css": "css", ".module.css": "local-css", ".png": "dataurl" },
    },
  ],
  example: [
    {
      entryPoints: ["packages/workbench-example/src/host.ts"],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: "packages/workbench-example/lib/host.js",
    },
    {
      entryPoints: ["packages/workbench-example/src/client.tsx"],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "browser",
      external: ["react"],
      plugins: [
        clientOutput(
          "packages/workbench-example/lib/client.js",
          '"@cleverc2200/dsh-workbench-example"',
        ),
      ],
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
