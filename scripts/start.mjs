/** Start the current source composition in an isolated, configured DSH profile. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readDeployment } from "./deployment.mjs";
import { runSourceProfile } from "./start-isolated-validation.mjs";
import { readSourceSelection, requireSourceInputs } from "./source-profile.mjs";
import { admitSourceWindow } from "./window-admission.mjs";
const root = resolve(import.meta.dirname, "..");
try {
  const { values } = parseArgs({
    options: {
      window: { type: "string" },
      case: { type: "string" },
      owner: { type: "string" },
      "freeze-sha256": { type: "string" },
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
      "pnpm start --window <open-window.json> --case <case> --owner <owner> --freeze-sha256 <frozen SHA-256> --config <deployment.json> [--sources <fixed-source-records.json>] [--runtime <isolated directory>] [--port <port or 0>] [--dev]",
    );
  else {
    const runtime = resolve(values.runtime ?? ".runtime/workbench-development");
    const core = resolve(root, "../../official-latest-standard");
    const window = { file: values.window, case: values.case, owner: values.owner, freezeSha256: values["freeze-sha256"] };
    await admitSourceWindow({ window, mode: "source-host", core, runtime, config: resolve(values.config ?? "gea.config.json"), sourcesFile: values.sources });
    const sources = values.sources
      ? JSON.parse(
          await (
            await import("node:fs/promises")
          ).readFile(values.sources, "utf8"),
        )
      : undefined;
    if ((await readSourceSelection(runtime)) === undefined)
      requireSourceInputs(sources);
    const deployment = await readDeployment(
      resolve(values.config ?? "gea.config.json"),
      { resolveCredentials: false, credentialEnv: {} },
    );
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw Error("GEA_PORT_INVALID");
    await runSourceProfile(
      core,
      runtime,
      true,
      deployment,
      port,
      {
        sources,
        window,
        config: resolve(values.config ?? "gea.config.json"),
        dev: values.dev,
      },
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
