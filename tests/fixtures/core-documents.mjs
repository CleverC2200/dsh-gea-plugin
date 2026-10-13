import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { businessDeploymentPatch, readDeployment } from "../../scripts/deployment.mjs";

/** Core startup owns its Workspace; keep its Documents lookup inside this fresh fixture. */
export function prepareCoreDocuments({ coreOnly = false } = {}) {
  return async ({ runtime, config, credentialEnv }) => {
    const patch = [
      {
        id: "workspace-controller",
        config: { documentsDirectory: resolve(runtime, "documents") },
      },
    ];
    if (!coreOnly) {
      const deployment = await readDeployment(config, {
        resolveCredentials: false,
        credentialEnv,
      });
      const model = businessDeploymentPatch(
        deployment,
        resolve(import.meta.dirname, "../.."),
        runtime,
        { bundle: true, workspace: resolve(runtime, "workspace") },
      ).find((row) => row.id === "agent-default-model");
      assert.ok(model, "the fresh Source fixture must retain its public model default");
      patch.push(model);
    }
    const profile = resolve(runtime, "home/profiles/plugin-split-validation");
    await mkdir(profile, { recursive: true });
    await writeFile(resolve(profile, "cordis.patch.yml"), JSON.stringify(patch), { flag: "wx" });
  };
}
