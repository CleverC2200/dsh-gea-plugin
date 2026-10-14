import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-app-boot";
import { realpath } from "node:fs/promises";
import { companyPackageNames } from "../shared/plugin-release.mjs";
import { compiledPackageStamp, updateObject } from "../shared/plugin-update-wire.ts";
import type { RuntimePackageProof } from "../shared/plugin-update-state.ts";

/** Read already-mounted namespaces using their public Loader import and callback identity. */
export async function readHostPluginModules(ctx: Context): Promise<RuntimePackageProof[]> {
  const proofs: RuntimePackageProof[] = [];
  for (const name of companyPackageNames) {
    const matches = [...ctx.loader.entries()].filter(
      (entry) => entry.options.name === name && !entry.disabled,
    );
    let proof: RuntimePackageProof = {
      name,
      resolvedDir: "",
      host: { kind: "unverified", reason: "HOST_MODULE_NOT_ACTIVE" },
      client: { kind: "unverified", reason: "CLIENT_OBSERVATION_MISSING" },
    };
    const entry = matches.length === 1 ? matches[0] : undefined,
      fiber = entry?.fiber;
    if (entry && fiber?.state === 2) {
      try {
        const namespace = updateObject(await entry.parent.tree.import(entry.options.name));
        const plugin = ctx.loader.unwrapExports(namespace);
        if (
          entry.fiber !== fiber ||
          fiber.state !== 2 ||
          ctx.registry.resolve(plugin) !== fiber.runtime?.callback
        )
          throw Error("HOST_MODULE_IDENTITY_CHANGED");
        const base = entry.parent.tree.ctx.baseUrl;
        const resolved = base ? ctx.get("pluginPackages")?.packageOf(name, base) : undefined;
        if (!resolved) throw Error("HOST_PACKAGE_RESOLUTION_MISSING");
        const resolvedDir = await realpath(resolved.dir);
        if (
          entry.fiber !== fiber ||
          fiber.state !== 2 ||
          ctx.registry.resolve(plugin) !== fiber.runtime?.callback
        )
          throw Error("HOST_MODULE_IDENTITY_CHANGED");
        proof = {
          ...proof,
          resolvedDir,
          host: {
            kind: "active",
            stamp: compiledPackageStamp(namespace.pluginPackageVersion, name),
            identity: `${entry.id}:${fiber.uid}`,
          },
        };
      } catch {
        proof = { ...proof, host: { kind: "unverified", reason: "HOST_MODULE_PROOF_UNAVAILABLE" } };
      }
    }
    proofs.push(proof);
  }
  return proofs;
}
