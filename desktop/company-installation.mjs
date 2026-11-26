import { mkdir, readFile, writeFile, rename, lstat, realpath, symlink, rm } from "node:fs/promises";
import { join, relative, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { PluginStore, writePluginStoreJson } from "./plugin-store.mjs";
import { materializeGraph } from "./core-layer.mjs";
import { relocateVirtualStore } from "./copy-graph.mjs";
import { companyPackageNames } from "./company-archives.mjs";
import { companyUpdatePath, readCompanyUpdate } from "./company-update.mjs";

const graphFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "overrides",
  "resolutions",
  "pnpm",
  "packageManager",
];
const graphValues = (manifest) =>
  Object.fromEntries(
    graphFields.filter((key) => Object.hasOwn(manifest, key)).map((key) => [key, manifest[key]]),
  );
const rolledBackSelection = (selection, id) =>
  selection.rollback?.operationId === id &&
  selection.active !== id &&
  selection.active === selection.verified &&
  selection.pending === null &&
  (selection.booting === null || selection.booting === selection.active);
const json = async (path) => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const optional = async (path) =>
  readFile(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const inside = (root, path) => {
  const value = relative(root, path);
  return (
    value === "" ||
    (!isAbsolute(value) && value !== ".." && !value.startsWith("../") && !value.startsWith("..\\"))
  );
};

export class CompanyInstallation {
  constructor(profile, coreHead) {
    if (!isAbsolute(profile) || !/^[a-f0-9]{40}$/.test(coreHead))
      throw Error("GEA_INSTALLATION_INPUT_REQUIRED");
    this.profile = profile;
    this.coreHead = coreHead;
    this.directory = join(profile, "gea/installations", coreHead);
    this.store = new PluginStore({
      data: this.directory,
      baseline: join(this.directory, "baseline"),
      companyCoreHead: coreHead,
      companyProfile: profile,
    });
  }
  async initialize(prepare, { inherit = true } = {}) {
    if (await optional(join(this.directory, "baseline/baseline.json"))) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.store.withLock(async (owner, lockPath) => {
      if (await optional(join(this.directory, "baseline/baseline.json"))) return;
      const stageName = "baseline-" + randomUUID();
      const stage = join(this.directory, stageName);
      await writePluginStoreJson(lockPath, { ...owner, stage: stageName });
      await mkdir(stage, { mode: 0o700 });
      if (inherit) {
        await materializeGraph({ path: this.profile }, stage);
        await relocateVirtualStore(stage, { sourceDirectory: this.profile });
      } else {
        const manifest = await json(join(this.profile, "package.json"));
        for (const field of ["dependencies", "devDependencies", "optionalDependencies"])
          for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
            if (companyPackageNames.includes(name)) delete manifest[field][name];
            else if (typeof spec === "string" && /^(file|link):/.test(spec)) {
              const separator = spec.indexOf(":") + 1;
              manifest[field][name] =
                spec.slice(0, separator) + resolve(this.profile, spec.slice(separator));
            }
          }
        await writePluginStoreJson(join(stage, "package.json"), manifest);
        const workspace = await optional(join(this.profile, "pnpm-workspace.yaml"));
        if (workspace) await writeFile(join(stage, "pnpm-workspace.yaml"), workspace);
        const lock = await optional(join(this.profile, "pnpm-lock.yaml"));
        if (lock) await writeFile(join(stage, "pnpm-lock.yaml"), lock);
      }
      await prepare?.(stage);
      await this.validate(stage);
      await writePluginStoreJson(join(stage, "baseline.json"), {
        schema: 1,
        coreHead: this.coreHead,
      });
      await rename(stage, this.store.baseline);
    });
  }
  async validate(directory) {
    const manifest = await json(join(directory, "package.json"));
    const load = createRequire(join(directory, "package.json"));
    for (const name of companyPackageNames) {
      const pkg = await json(join(directory, "node_modules", name, "package.json"));
      if (!manifest.dependencies?.[name] || pkg.name !== name || typeof pkg.version !== "string")
        throw Error("GEA_INSTALLATION_INCOMPLETE");
      for (const entry of [name, name + "/client"]) {
        let resolved;
        try {
          resolved = await realpath(load.resolve(entry));
        } catch (error) {
          if (["MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ENOENT"].includes(error.code))
            throw Error("GEA_INSTALLATION_INCOMPLETE");
          throw error;
        }
        if (!inside(await realpath(join(directory, "node_modules")), resolved))
          throw Error("GEA_INSTALLATION_INCOMPLETE");
      }
    }
  }
  async prepare(id, install, signal, { testPlugin = false } = {}) {
    const source = graphValues(await json(join(this.profile, "package.json")));
    const receipt = await this.store.prepare({
      id,
      signal,
      queueActivation: true,
      testPlugin,
      install: async (stage, controls) => {
        const manifest = await json(join(this.profile, "package.json"));
        if (!isDeepStrictEqual(graphValues(manifest), source))
          throw Error("GEA_INSTALLATION_BASE_CHANGED");
        await writePluginStoreJson(join(stage, "package.json"), manifest);
        const workspace = await optional(join(this.profile, "pnpm-workspace.yaml"));
        if (workspace) await writeFile(join(stage, "pnpm-workspace.yaml"), workspace);
        await install(stage, controls);
        await this.validate(stage);
        await writePluginStoreJson(join(stage, "activation.json"), { schema: 1, source });
      },
    });
    return receipt;
  }
  async preparationIdle() {
    return (await this.store.recoverPreparation()) !== "busy";
  }
  async hasPendingActivation() {
    const state = await this.store.status();
    return state.pending != null || (state.booting != null && state.booting !== state.verified);
  }
  async pendingTestPluginActivation() {
    const { pending } = await this.store.status();
    return (await this.store.isTestPluginVersion(pending)) ? pending : null;
  }
  async hasTestPluginActivation() {
    const { pending, booting, verified } = await this.store.status();
    return (
      (await this.store.isTestPluginVersion(pending)) ||
      (booting !== verified && (await this.store.isTestPluginVersion(booting)))
    );
  }
  async activationState(id) {
    const selection = await this.store.status();
    return selection.pending === id
      ? "pending"
      : selection.active === id
        ? "active"
        : rolledBackSelection(selection, id)
          ? "rolled-back"
          : "unavailable";
  }
  async recoverRollback(id) {
    return this.store.withSelectionLock(async () => {
      const selection = await this.store.status();
      if (!rolledBackSelection(selection, id)) return false;
      await this.failOperation(id, selection.rollback.diagnostic);
      return true;
    });
  }
  async beginBoot({ activatePending = true } = {}) {
    await this.preparationIdle();
    const before = await this.store.status();
    if (before.pending) {
      const activation = await json(
        join(this.store.root, "versions", before.pending, "activation.json"),
      );
      const current = graphValues(await json(join(this.profile, "package.json")));
      if (!isDeepStrictEqual(activation.source, current))
        await this.store.withSelectionLock(async () => {
          const state = await this.store.status();
          if (state.pending === before.pending) {
            await writePluginStoreJson(join(this.store.root, "selection.json"), {
              ...state,
              pending: null,
              error: "GEA_INSTALLATION_BASE_CHANGED",
            });
            await this.failOperation(before.pending, "GEA_INSTALLATION_BASE_CHANGED");
          }
        });
    }
    const selected = await this.store.beginBoot({ activatePending });
    if (before.booting && before.active !== selected.id)
      await this.failOperation(before.active, "PREVIOUS_BOOT_INTERRUPTED");
    await this.mount(selected);
    return selected;
  }
  async restoreBaselineSelection() {
    const baseline = await json(join(this.store.baseline, "baseline.json"));
    if (baseline.schema !== 1 || baseline.coreHead !== this.coreHead)
      throw Error("GEA_INSTALLATION_CORE_MISMATCH");
    await this.validate(this.store.baseline);
    await this.store.withSelectionLock(async () => {
      try {
        await this.store.status();
        return;
      } catch (error) {
        if (error.message !== "PLUGIN_SELECTION_INVALID") throw error;
      }
      const path = join(this.store.root, "selection.json");
      const original = await readFile(path);
      await writeFile(path + ".before-recovery-" + randomUUID(), original, {
        flag: "wx",
        mode: 0o600,
      });
      await writePluginStoreJson(path, {
        active: "baseline",
        verified: "baseline",
        previous: null,
        booting: null,
        pending: null,
        dataSchema: this.store.dataSchema,
        referencesUncertain: true,
        error: "PLUGIN_SELECTION_INVALID",
      });
    });
    return this.beginBoot({ activatePending: false });
  }
  async verifiedMounted() {
    const state = await this.store.status();
    if ((state.dataSchema ?? 1) !== this.store.dataSchema) throw Error("DATA_SCHEMA_INCOMPATIBLE");
    if (!state.verified || state.active !== state.verified) return null;
    const marker = await json(join(this.profile, "gea/installation.json"));
    if (marker.schema !== 1 || marker.coreHead !== this.coreHead || marker.graphId !== state.active)
      return null;
    const selected = await this.store.selected();
    const directory = await realpath(selected.path);
    if (!inside(await realpath(this.directory), directory)) return null;
    if (
      selected.id === "baseline" &&
      (await json(join(directory, "baseline.json"))).coreHead !== this.coreHead
    )
      return null;
    if (
      (await realpath(join(this.profile, "node_modules"))) !==
      (await realpath(join(directory, "node_modules")))
    )
      return null;
    if (
      !isDeepStrictEqual(
        graphValues(await json(join(this.profile, "package.json"))),
        graphValues(await json(join(directory, "package.json"))),
      )
    )
      return null;
    await this.validate(directory);
    return selected;
  }
  async mount(selected) {
    const directory = await realpath(selected.path);
    if (!inside(await realpath(this.directory), directory))
      throw Error("GEA_INSTALLATION_PATH_INVALID");
    await this.validate(directory);
    const modules = join(this.profile, "node_modules");
    const target = join(directory, "node_modules");
    const entry = await lstat(modules).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const actual = entry ? await realpath(modules).catch(() => null) : null;
    const marker = await optional(join(this.profile, "gea/installation.json"));
    let mounted;
    try {
      mounted = marker && JSON.parse(marker.toString("utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (
      actual === (await realpath(target)) &&
      mounted?.schema === 1 &&
      mounted.coreHead === this.coreHead &&
      mounted.graphId === selected.id
    )
      return;
    const current = await optional(join(this.profile, "package.json"));
    const previousLock = await optional(join(this.profile, "pnpm-lock.yaml"));
    const recovery = join(this.directory, "mount-before-" + randomUUID());
    await mkdir(recovery, { mode: 0o700 });
    for (const [name, bytes] of [
      ["package.json", current],
      ["pnpm-lock.yaml", previousLock],
      ["installation.json", marker],
    ])
      if (bytes) await writeFile(join(recovery, name), bytes, { flag: "wx", mode: 0o600 });
    if (actual !== (await realpath(target))) {
      const next = join(this.profile, ".node_modules-" + randomUUID());
      await symlink(target, next, process.platform === "win32" ? "junction" : "dir");
      if (entry) {
        if (entry.isSymbolicLink()) {
          if (actual && !inside(await realpath(join(this.profile, "gea/installations")), actual))
            throw Error("GEA_INSTALLATION_LINK_UNOWNED");
          await rm(modules);
        } else {
          if (!entry.isDirectory()) throw Error("GEA_INSTALLATION_PATH_INVALID");
          await rename(modules, join(this.directory, "legacy-node_modules-" + randomUUID()));
        }
      }
      await rename(next, modules);
    }
    const manifest = current ? JSON.parse(current.toString("utf8").replace(/^\uFEFF/, "")) : {};
    const graph = await json(join(directory, "package.json"));
    const merged = { ...manifest };
    for (const key of graphFields) {
      if (Object.hasOwn(graph, key)) merged[key] = graph[key];
      else delete merged[key];
    }
    if (!current) merged.dsh = graph.dsh;
    await writePluginStoreJson(join(this.profile, "package.json"), merged);
    const lock = await optional(join(directory, "pnpm-lock.yaml"));
    if (lock) {
      const temporary = join(this.profile, ".pnpm-lock-" + randomUUID());
      await writeFile(temporary, lock, { mode: 0o600, flag: "wx" });
      await rename(temporary, join(this.profile, "pnpm-lock.yaml"));
    }
    await mkdir(join(this.profile, "gea"), { recursive: true, mode: 0o700 });
    await writePluginStoreJson(join(this.profile, "gea/installation.json"), {
      schema: 1,
      coreHead: this.coreHead,
      graphId: selected.id,
    });
  }
  async confirmRuntime(proofs) {
    const selected = await this.store.selected();
    const profile = await json(join(this.profile, "package.json"));
    const memory = "@cleverc2200/dsh-personal-memory";
    const required = [
      ...companyPackageNames,
      ...(profile.dependencies?.[memory] && profile.dsh?.profile?.bundles?.includes(memory)
        ? [memory]
        : []),
    ];
    for (const name of required) {
      const manifest = await json(join(selected.path, "node_modules", name, "package.json"));
      const proof = proofs.find((row) => row.name === name);
      if (
        proof?.host.kind !== "active" ||
        proof?.client.kind !== "observed" ||
        proof.host.stamp.version !== manifest.version ||
        proof.client.stamp.version !== manifest.version ||
        (await realpath(proof.resolvedDir)) !==
          (await realpath(join(selected.path, "node_modules", name)))
      )
        return false;
    }
    const state = await this.store.status();
    if (state.active !== selected.id) return false;
    if (state.booting === selected.id) return this.store.confirmBoot(selected.id);
    return state.verified === selected.id && !state.booting;
  }
  collectGarbage() {
    return this.store.collectGarbage();
  }
  async rollback(reason) {
    const previous = (await this.store.status()).active;
    const fallback = await this.store.failBoot(reason);
    if (fallback !== previous) await this.failOperation(previous, reason);
    return { changed: fallback !== previous, fallback };
  }
  async failOperation(id, diagnostic) {
    const runtime = join(this.profile, "gea/plugin-updates");
    try {
      const company = await readCompanyUpdate(this.profile);
      if (company && id === "desktop-" + company.id) {
        const path = companyUpdatePath(this.profile);
        await writeFile(path + ".before-boot-failure-" + randomUUID(), await readFile(path), {
          flag: "wx",
          mode: 0o600,
        });
        await writePluginStoreJson(path, { ...company, phase: "failed", diagnostic });
      }
      const pointer = await optional(join(runtime, "latest.json"));
      if (!pointer) return;
      const latest = JSON.parse(pointer.toString("utf8"));
      if (latest.id !== id) return;
      const path = join(runtime, "operations", id, "receipt.json");
      const original = await readFile(path);
      const receipt = JSON.parse(original.toString("utf8"));
      if (receipt.installationId !== id) return;
      await writeFile(
        join(runtime, "operations", id, "receipt.before-boot-failure-" + randomUUID() + ".json"),
        original,
        { flag: "wx", mode: 0o600 },
      );
      await writePluginStoreJson(path, {
        ...receipt,
        stage: "failed",
        diagnostic,
        completionProof: null,
        completionProofs: undefined,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await writePluginStoreJson(
        join(this.directory, "operation-failure-" + randomUUID() + ".json"),
        { id, diagnostic, receiptDiagnostic: error.code ?? "INVALID_RECEIPT" },
      );
    }
  }
  async ownsModules(path) {
    const selected = await this.store.selected();
    return (await realpath(path)) === (await realpath(join(selected.path, "node_modules")));
  }
}

export async function openCompanyInstallation(profile) {
  const marker = await optional(join(profile, "gea/installation.json"));
  if (!marker) return null;
  const record = JSON.parse(marker.toString("utf8"));
  if (record.schema !== 1) throw Error("GEA_INSTALLATION_STATE_INVALID");
  const installation = new CompanyInstallation(profile, record.coreHead);
  await installation.ownsModules(join(profile, "node_modules")).then((owned) => {
    if (!owned) throw Error("GEA_INSTALLATION_GRAPH_MISMATCH");
  });
  return installation;
}
