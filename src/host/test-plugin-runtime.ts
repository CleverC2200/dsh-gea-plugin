import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  bundlePatchPaths,
  composeEntries,
  loadOverlayPatches,
  readProfileManifest,
} from "@deepseek-ai/dsh-app-boot";
import type { Context } from "@deepseek-ai/cordis";
import type { Entry } from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-client-modules";

export function createTestPluginRuntime(ctx: Context) {
  const loader = ctx.loader;
  const entries = new Map<string, { id: string; revoke: () => unknown }>();
  const remove = (name: string) => {
    const current = entries.get(name);
    if (current === undefined) return;
    entries.delete(name);
    void current.revoke();
    loader.root.remove(current.id);
  };
  return {
    has(name: string) {
      return entries.has(name);
    },
    retain(names: ReadonlySet<string>) {
      for (const name of entries.keys()) if (!names.has(name)) remove(name);
    },
    async activate(name: string, signal: AbortSignal) {
      if (entries.has(name)) return;
      if ([...loader.entries()].some((entry) => entry.options.name === name))
        throw Error("TEST_PLUGIN_ENTRY_ALREADY_PRESENT");
      const parentUrl = loader.root.tree.ctx.baseUrl;
      const resolved = parentUrl && ctx.get("pluginPackages")?.packageOf(name, parentUrl);
      const profilePackage = await realpath(join(ctx.profileContext.dir, "node_modules", name));
      if (!resolved || (await realpath(resolved.dir)) !== profilePackage)
        throw Error("TEST_PLUGIN_ENTRY_RESOLUTION_MISMATCH");
      const manifest = readProfileManifest("dsh", profilePackage);
      const bundle = manifest.dsh?.bundle;
      if (bundle === undefined) throw Error("TEST_PLUGIN_BUNDLE_MISSING");
      const patches = bundlePatchPaths(profilePackage, bundle).flatMap((file) =>
        loadOverlayPatches("dsh", file),
      );
      const [row, ...extra] = composeEntries([patches]);
      if (
        !row ||
        row.name !== name ||
        extra.length ||
        row.disabled ||
        row.group ||
        row.config !== undefined
      )
        throw Error("TEST_PLUGIN_BUNDLE_NOT_ADDITIVE");
      const id = "gea-test-" + createHash("sha256").update(name).digest("hex").slice(0, 24);
      signal.throwIfAborted();
      if (Object.hasOwn(loader.store, id)) throw Error("TEST_PLUGIN_ENTRY_ALREADY_PRESENT");
      const service = "gea-test-plugin-" + randomUUID();
      const admission = { id, revoke: ctx.reflect.provide(service, true, () => !signal.aborted) };
      entries.set(name, admission);
      let entry: Entry | undefined;
      try {
        const options = { id, name, inject: [service] };
        const operation = loader.root.create(options);
        entry = loader.store[id];
        await operation;
        if (entry?.fiber) await entry.fiber.await();
        signal.throwIfAborted();
        if (
          entry?.fiber?.state !== 2 ||
          (manifest.dsh?.client && !ctx.get("clientModules")?.clientPath(name))
        )
          throw Error("TEST_PLUGIN_RUNTIME_UNCONFIRMED");
      } catch (error) {
        if (entries.get(name) === admission) remove(name);
        else if (entry?.fiber) entry.fiber.dispose();
        throw error;
      }
    },
  };
}
