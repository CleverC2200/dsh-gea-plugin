import { holdBuildAdmission } from "./build-admission.mjs";
import { build, context } from "esbuild";
import { clientBuildOptions } from "./client-build.mjs";
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
  client: [clientBuildOptions("lib/client.js")],
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
