/** Real source-profile launcher for tests whose external services are loopback fixtures. */
import { resolve } from "node:path";
import { readDeployment } from "../scripts/deployment.mjs";
import { runSourceProfile } from "../scripts/start-isolated-validation.mjs";

const [configPath, runtime] = process.argv.slice(2);
const deployment = await readDeployment(configPath);
for (const endpoint of [
  deployment.geaBaseUrl,
  ...Object.values(deployment.geaEnvironments ?? {}),
  deployment.analysis.baseUrl,
].filter(Boolean)) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname))
    throw Error("SOURCE_TEST_REQUIRES_LOOPBACK_SERVICES");
}
process.env.DSH_HOME = resolve(runtime, "home");
process.env.DSH_TELEMETRY_DISABLED = "1";
await runSourceProfile(
  resolve(import.meta.dirname, "../../deepseek-harness"),
  resolve(runtime),
  true,
  deployment,
);
