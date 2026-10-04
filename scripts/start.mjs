/** Start the current source composition in an isolated, configured DSH profile. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { readDeployment } from "./deployment.mjs";
import { runSourceProfile } from "./start-isolated-validation.mjs";
const root = resolve(import.meta.dirname, "..");
try {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      sources: { type: "string" },
      runtime: { type: "string" },
      port: { type: "string", default: "3198" },
      dev: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help)
    console.log(
      "pnpm start --config <deployment.json> [--runtime <isolated directory>] [--port <port or 0>] [--dev]",
    );
  else {
    const deployment = await readDeployment(
      resolve(values.config ?? "gea.config.json"),
    );
    const runtime = resolve(values.runtime ?? ".runtime/workbench-development");
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw Error("GEA_PORT_INVALID");
    await mkdir(resolve(runtime, "home"), { recursive: true, mode: 0o700 });
    process.env.DSH_HOME = resolve(runtime, "home");
    process.env.DSH_TELEMETRY_DISABLED = "1";
    if (values.dev) process.env.GEA_WEB_LOGIN_PERSIST = "1";
    await runSourceProfile(
      resolve(root, "../../official-latest-standard"),
      runtime,
      true,
      deployment,
      port,
      {
        sources: values.sources
          ? JSON.parse(
              await (
                await import("node:fs/promises")
              ).readFile(values.sources, "utf8"),
            )
          : undefined,
      },
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
