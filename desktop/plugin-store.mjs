import { mkdir, readFile, rename, open, lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { relocateVirtualStore } from "./copy-graph.mjs";
import { randomUUID, createHash } from "node:crypto";
import { recoverPluginStoreLock, withPluginStoreLock } from "./plugin-store-lock.mjs";
import { collectPluginStorage, pruneUnreferencedArchives } from "./plugin-storage.mjs";
import {
  readCoreLayout,
  readCachedCore,
  ensureCoreCache,
  materializeGraph,
  compactGraph,
} from "./core-layer.mjs";

function versionId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id) || id === "baseline")
    throw Error("INVALID_VERSION_ID");
  return id;
}
async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
function compatibleReceipt(receipt, schema) {
  return receipt.layout === "layered"
    ? receipt.coreDataSchema === schema && receipt.dataSchema === `layered-v1:${schema}`
    : (receipt.dataSchema ?? 1) === schema;
}
export async function writePluginStoreJson(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
export class PluginStore {
  constructor({ data, baseline, dataSchema = 1, companyCoreHead, companyProfile }) {
    this.root = join(resolve(data), "plugins");
    this.baseline = resolve(baseline);
    this.dataSchema = dataSchema;
    this.companyCoreHead = companyCoreHead;
    this.companyProfile = companyProfile;
  }
  async withLock(action, options) {
    return withPluginStoreLock(this.root, action, options);
  }
  async withSelectionLock(action) {
    return withPluginStoreLock(join(this.root, "selection"), action);
  }
  async collectGarbage() {
    if (this.maintenanceTask) return this.maintenanceTask;
    const task = collectPluginStorage(this);
    this.maintenanceTask = task;
    try {
      return await task;
    } finally {
      if (this.maintenanceTask === task) this.maintenanceTask = undefined;
    }
  }
  async status() {
    try {
      const state = await json(join(this.root, "selection.json"));
      const valid = (id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id);
      if (
        !state ||
        !valid(state.active) ||
        ["previous", "verified", "pending", "booting"].some(
          (key) => state[key] != null && !valid(state[key]),
        ) ||
        (this.companyCoreHead &&
          state.rollback != null &&
          (typeof state.rollback !== "object" ||
            !valid(state.rollback.operationId) ||
            typeof state.rollback.diagnostic !== "string" ||
            state.rollback.diagnostic.length === 0))
      )
        throw Error("PLUGIN_SELECTION_INVALID");
      return state;
    } catch (error) {
      if (error.code !== "ENOENT") throw Error("PLUGIN_SELECTION_INVALID");
      const versions = this.companyCoreHead
        ? await readdir(join(this.root, "versions"), { withFileTypes: true }).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          })
        : [];
      return {
        active: "baseline",
        previous: null,
        ...(versions.some((entry) => entry.isDirectory() || entry.isSymbolicLink())
          ? { referencesUncertain: true }
          : {}),
      };
    }
  }
  async selected() {
    const { active } = await this.status();
    if (active === "baseline") {
      const layout = await readCoreLayout(this.baseline);
      return {
        id: active,
        path: this.baseline,
        ...(layout ? { core: { path: layout.path, metadata: layout.layout } } : {}),
      };
    }
    versionId(active);
    const path = join(this.root, "versions", active);
    const receipt = await json(join(path, "version.json"));
    if (receipt.id !== active || receipt.state !== "prepared")
      throw Error("PLUGIN_VERSION_NOT_PREPARED");
    if (!compatibleReceipt(receipt, this.dataSchema)) throw Error("DATA_SCHEMA_INCOMPATIBLE");
    if (receipt.layout === "layered") {
      const core = await readCachedCore(this.root, receipt.coreId),
        layer = await json(join(path, "layer.json"));
      if (
        layer.schema !== 1 ||
        layer.coreId !== core.id ||
        JSON.stringify(layer.packages) !== JSON.stringify(core.metadata.packages)
      )
        throw Error("PLUGIN_LAYER_INVALID");
      return { id: active, path, receipt, core };
    }
    return { id: active, path, receipt };
  }
  async prepare({
    id,
    install,
    signal,
    queueActivation = false,
    testPlugin = false,
    commitActivation,
  }) {
    versionId(id);
    await mkdir(join(this.root, "versions"), { recursive: true, mode: 0o700 });
    return this.withLock(async (owner, lockPath) => {
      const stageName = "staging-" + randomUUID();
      const stage = join(this.root, stageName);
      const preparation = { ...owner, stage: stageName };
      try {
        await writePluginStoreJson(lockPath, preparation);
        if (this.companyCoreHead)
          await this.withSelectionLock(async () => {
            const path = join(this.root, "selection.json");
            try {
              await lstat(path);
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              await writePluginStoreJson(path, await this.status());
            }
          });
        const current = await this.selected();
        await mkdir(stage, { recursive: true, mode: 0o700 });

        await materializeGraph(current, stage, { signal });
        signal?.throwIfAborted();
        await relocateVirtualStore(stage, { sourceDirectory: current.path, storeRoot: this.root });
        await install(stage, {
          registerProcess: async (workerPid) => {
            preparation.workerPid = workerPid;
            await writePluginStoreJson(lockPath, preparation);
          },
        });
        await relocateVirtualStore(stage);
        await pruneUnreferencedArchives(stage);
        const manifest = await json(join(stage, "package.json"));
        if (
          manifest.desktopDataSchema !== undefined &&
          manifest.desktopDataSchema !== this.dataSchema
        )
          throw Error("DATA_SCHEMA_UNSUPPORTED");
        const versions = {};
        for (const name of Object.keys(manifest.dependencies ?? {})) {
          const pkg = await json(join(stage, "node_modules", name, "package.json"));
          if (pkg.desktopDataSchema !== undefined && pkg.desktopDataSchema !== this.dataSchema)
            throw Error("DATA_SCHEMA_UNSUPPORTED");
          versions[name] = pkg.version;
        }
        const lockBytes = await readFile(join(stage, "pnpm-lock.yaml")).catch((error) => {
          if (error.code === "ENOENT") return Buffer.alloc(0);
          throw error;
        });
        if (!this.corePromise)
          this.corePromise = ensureCoreCache(this.baseline, this.root).catch((error) => {
            this.corePromise = undefined;
            throw error;
          });
        const core = await this.corePromise;
        signal?.throwIfAborted();
        const layout = await compactGraph(stage, core);
        signal?.throwIfAborted();

        const schema =
          layout.layout === "layered"
            ? { dataSchema: `layered-v1:${this.dataSchema}`, coreDataSchema: this.dataSchema }
            : { dataSchema: this.dataSchema };
        const receipt = {
          id,
          state: "prepared",
          ...(testPlugin ? { testPlugin: true } : {}),
          ...schema,
          createdAt: new Date().toISOString(),
          dependencies: manifest.dependencies ?? {},
          versions,
          lockSha256: createHash("sha256").update(lockBytes).digest("hex"),
          ...layout,
          ...(this.companyCoreHead
            ? { ownership: { schema: 1, kind: "company-update", coreHead: this.companyCoreHead } }
            : {}),
        };
        await writePluginStoreJson(join(stage, "version.json"), receipt);

        const destination = join(this.root, "versions", id);
        try {
          await lstat(destination);
          throw Error("PLUGIN_VERSION_EXISTS");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const commit = async () => {
          signal?.throwIfAborted();
          await rename(stage, destination);
          if (queueActivation) await this.queueActivation(id, signal);
        };
        if (commitActivation) await commitActivation(commit);
        else await commit();
        return receipt;
      } catch (error) {
        await writePluginStoreJson(join(stage, "preparation-failure.json"), {
          id,
          state: "failed",
          code: /^[A-Z][A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "PLUGIN_PREPARATION_FAILED",
          ...(this.companyCoreHead
            ? {
                ownership: { schema: 1, kind: "company-update", coreHead: this.companyCoreHead },
                writer: preparation,
              }
            : {}),
        }).catch(() => undefined);
        throw error;
      }
    });
  }
  async recoverPreparation() {
    return recoverPluginStoreLock(this.root);
  }
  async isTestPluginVersion(id) {
    if (!id || id === "baseline") return false;
    versionId(id);
    const receipt = await json(join(this.root, "versions", id, "version.json"));
    if (receipt.id !== id) throw Error("PLUGIN_VERSION_NOT_PREPARED");
    return receipt.testPlugin === true;
  }
  async queueActivation(id, signal) {
    versionId(id);
    const receipt = await json(join(this.root, "versions", id, "version.json"));
    if (
      receipt.id !== id ||
      receipt.state !== "prepared" ||
      !compatibleReceipt(receipt, this.dataSchema)
    )
      throw Error("PLUGIN_VERSION_NOT_PREPARED");
    return this.withSelectionLock(async () => {
      const state = await this.status();
      if (this.companyCoreHead) {
        const trial = state.booting !== state.verified ? state.booting : null;
        for (const candidate of [state.pending, trial])
          if (
            candidate &&
            candidate !== id &&
            (receipt.testPlugin === true || (await this.isTestPluginVersion(candidate)))
          )
            throw Error("UPDATE_OPERATION_BLOCKED");
      }
      signal?.throwIfAborted();
      await writePluginStoreJson(join(this.root, "selection.json"), { ...state, pending: id });
    });
  }
  async beginBoot({ activatePending = false } = {}) {
    return this.withSelectionLock(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      let state = await this.status();
      if (this.dataSchema === 2 && (state.dataSchema ?? 1) === 1) {
        state = {
          active: "baseline",
          previous: null,
          verified: "baseline",
          booting: null,
          dataSchema: 2,
          upgradedFrom: state,
        };
        await writePluginStoreJson(join(this.root, "selection.json"), state);
      }
      if ((state.dataSchema ?? 1) !== this.dataSchema) throw Error("DATA_SCHEMA_INCOMPATIBLE");

      if (state.booting) {
        const fallback = state.verified ?? state.previous ?? "baseline";
        state = {
          ...state,
          active: fallback,
          ...(this.companyCoreHead && fallback !== state.active
            ? { rollback: { operationId: state.active, diagnostic: "PREVIOUS_BOOT_INTERRUPTED" } }
            : {}),
          previous: state.active,
          booting: null,
          error: "PREVIOUS_BOOT_INTERRUPTED",
        };
        await writePluginStoreJson(join(this.root, "selection.json"), state);
      }
      if (activatePending && state.pending) {
        versionId(state.pending);
        const receipt = await json(join(this.root, "versions", state.pending, "version.json"));
        if (
          receipt.id !== state.pending ||
          receipt.state !== "prepared" ||
          !compatibleReceipt(receipt, this.dataSchema)
        )
          throw Error("PLUGIN_VERSION_NOT_PREPARED");
        state = {
          ...state,
          active: state.pending,
          previous: state.active,
          verified: state.verified ?? state.active,
          pending: null,
          ...(this.companyCoreHead ? { rollback: null } : {}),
        };
      }
      await writePluginStoreJson(join(this.root, "selection.json"), {
        ...state,
        booting: state.active,
      });
      return this.selected();
    });
  }
  async confirmBoot(expectedId) {
    return this.withSelectionLock(async () => {
      const state = await this.status();
      if (expectedId !== undefined && (state.active !== expectedId || state.booting !== expectedId))
        return false;
      await writePluginStoreJson(join(this.root, "selection.json"), {
        ...state,
        booting: null,
        verified: state.active,
        error: null,
        ...(this.companyCoreHead ? { rollback: null } : {}),
        dataSchema: this.dataSchema,
      });
      return true;
    });
  }
  async failBoot(reason) {
    return this.withSelectionLock(async () => {
      const state = await this.status();
      const fallback = state.verified ?? state.previous ?? "baseline";
      await writePluginStoreJson(join(this.root, "selection.json"), {
        ...state,
        active: fallback,
        ...(this.companyCoreHead && fallback !== state.active
          ? { rollback: { operationId: state.active, diagnostic: reason } }
          : {}),
        previous: state.active,
        pending: null,
        booting: null,
        error: reason,
      });
      return fallback;
    });
  }
  async activate(id) {
    return this.withSelectionLock(async () => {
      const current = await this.status();
      if ((current.dataSchema ?? 1) !== this.dataSchema)
        throw Error("DATA_SCHEMA_INCOMPATIBLE: preserve data; restore a compatible application");
      if (id !== "baseline") {
        versionId(id);
        const receipt = await json(join(this.root, "versions", id, "version.json"));
        if (receipt.id !== id || receipt.state !== "prepared")
          throw Error("PLUGIN_VERSION_NOT_PREPARED");
        if (!compatibleReceipt(receipt, this.dataSchema)) throw Error("DATA_SCHEMA_INCOMPATIBLE");
      }
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const state = await this.status();
      await writePluginStoreJson(join(this.root, "selection.json"), {
        ...state,
        active: id,
        previous: state.active,
        verified: state.verified ?? state.active,
        booting: null,
        ...(this.companyCoreHead ? { rollback: null } : {}),
      });
    });
  }
}
