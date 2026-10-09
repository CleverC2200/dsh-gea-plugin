/** Real source-profile launcher for tests whose external services are loopback fixtures. */
import { resolve } from "node:path";
import { readDeployment } from "../scripts/deployment.mjs";
import { runSourceProfile } from "../scripts/start-isolated-validation.mjs";

const [configPath, runtime, mode, windowRequestPath] = process.argv.slice(2);
const { readFile } = await import("node:fs/promises");
if (!windowRequestPath) throw Error("WINDOW_DECLARATION_REQUIRED");
const window = JSON.parse(await readFile(windowRequestPath, "utf8"));
const deployment =
  mode === "native-only"
    ? undefined
    : await readDeployment(configPath, {
        resolveCredentials: false,
        credentialEnv: {},
      });
for (const endpoint of [
  deployment?.geaBaseUrl,
  ...Object.values(deployment?.geaEnvironments ?? {}),
  deployment?.analysis.baseUrl,
].filter(Boolean)) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname))
    throw Error("SOURCE_TEST_REQUIRES_LOOPBACK_SERVICES");
}
await runSourceProfile(
  resolve(import.meta.dirname, "../../../official-latest-standard"),
  resolve(runtime),
  mode !== "native-only",
  deployment,
  0,
  {
    window,
    ...(mode !== "native-only" ? { config: configPath } : {}),
    sources: process.env.GEA_TEST_SOURCE_INPUTS
      ? JSON.parse(
          await (
            await import("node:fs/promises")
          ).readFile(process.env.GEA_TEST_SOURCE_INPUTS, "utf8"),
        )
      : undefined,
  },
);
