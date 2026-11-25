import { lstat, readFile, readdir, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { physicalFs } from "./physical-fs.mjs";
import { companyPackageNames } from "./company-archives.mjs";
import { parseCompanyUpdate } from "./company-update.mjs";
import { preparationWorkerStopped } from "./plugin-store-lock.mjs";

const automatic = /^channel-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const companyAutomatic =
  /^(?:desktop-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$|^bundled-[a-f0-9]{32}(?:-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?$/i;
const trashName = /^gc-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const stageName = /^staging-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const preparationEntries = new Set([
  "node_modules",
  "packages",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "activation.json",
  "version.json",
  "layer.json",
  "preparation-failure.json",
  ".plugin-manager",
]);
const optional = async (file) => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
async function directory(path) {
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink()) throw Error("PLUGIN_STORAGE_UNSAFE_PATH");
}
async function receiptFile(path) {
  const metadata = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw Error("INVALID_RECEIPT");
  return optional(path);
}
async function ownedReceipt(root, ...parts) {
  try {
    for (let index = 0; index < parts.length; index++)
      await directory(join(root, ...parts.slice(0, index)));
    return await receiptFile(join(root, ...parts));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function completedOperation(operation, id, versions) {
  if (
    operation?.schema !== 2 ||
    operation.id !== id ||
    operation.installationId !== id ||
    operation.stage !== "completed"
  )
    return false;
  const targets = operation.targets ?? [operation];
  const proofs = operation.targets ? operation.completionProofs : [operation.completionProof];
  return (
    Array.isArray(targets) &&
    targets.length > 0 &&
    Array.isArray(proofs) &&
    targets.length === proofs.length &&
    targets.every((target, index) => {
      const proof = proofs[index];
      return (
        companyPackageNames.includes(target.packageName) &&
        typeof target.targetVersion === "string" &&
        versions[target.packageName] === target.targetVersion &&
        /^[a-f0-9]{64}$/.test(target.targetSha256) &&
        typeof proof?.processIdentity === "string" &&
        proof.processIdentity !== operation.processIdentity &&
        proof.host?.kind === "active" &&
        proof.client?.kind === "observed" &&
        [proof.host, proof.client].every(
          (entry) =>
            entry.stamp?.name === target.packageName &&
            entry.stamp.version === target.targetVersion,
        ) &&
        proof.client.binding?.hostProcessIdentity === proof.processIdentity
      );
    })
  );
}
async function legacyCompanyOwned(store, path, id, receipt) {
  const activation = await receiptFile(join(path, "activation.json"));
  if (
    activation?.schema !== 1 ||
    !activation.source ||
    typeof activation.source !== "object" ||
    !companyPackageNames.every(
      (name) =>
        typeof activation.source.dependencies?.[name] === "string" &&
        typeof receipt.versions?.[name] === "string",
    )
  )
    return false;
  const lock = await readFile(join(path, "pnpm-lock.yaml")).catch((error) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  });
  if (createHash("sha256").update(lock).digest("hex") !== receipt.lockSha256) return false;
  if (id.startsWith("bundled-")) {
    const attempt = await ownedReceipt(join(store.root, ".."), id.slice(0, 40) + ".json");
    return attempt?.id === id && attempt.stage === "prepared";
  }
  if (id.startsWith("desktop-")) {
    const operationId = id.slice("desktop-".length);
    for (const name of ["company-update-" + operationId + ".json", "company-update.json"]) {
      const record = await ownedReceipt(store.companyProfile, "gea", "plugin-updates", name);
      if (!record || record.id !== operationId) continue;
      const operation = parseCompanyUpdate(record);
      if (
        operation.phase === "completed" &&
        operation.targets.every(
          (target) =>
            receipt.versions[target.name] === target.version &&
            target.supportedCores.some((core) => core.head === store.companyCoreHead),
        )
      )
        return true;
    }
    return false;
  }
  return completedOperation(
    await ownedReceipt(
      store.companyProfile,
      "gea",
      "plugin-updates",
      "operations",
      id,
      "receipt.json",
    ),
    id,
    receipt.versions,
  );
}
async function failedCompanyMaterials(store, stage) {
  const path = join(store.root, stage);
  await directory(path);
  const failurePath = join(path, "preparation-failure.json");
  const failure = await receiptFile(failurePath);
  if (
    failure?.state !== "failed" ||
    !companyAutomatic.test(failure.id) ||
    failure.ownership?.schema !== 1 ||
    failure.ownership.kind !== "company-update" ||
    failure.ownership.coreHead !== store.companyCoreHead ||
    failure.writer?.stage !== stage ||
    !(await preparationWorkerStopped(
      store.root,
      failure.writer,
      (await lstat(failurePath)).mtimeMs,
    ))
  )
    return null;
  const contents = await readdir(path, { withFileTypes: true });
  if (contents.some((item) => !preparationEntries.has(item.name) || item.isSymbolicLink()))
    return null;
  return contents;
}
function protect(state, ids, depth = 0) {
  if (!state || typeof state !== "object" || depth > 8) return;
  for (const key of ["active", "previous", "verified", "booting", "pending"])
    if (typeof state[key] === "string") ids.add(state[key]);
  protect(state.upgradedFrom, ids, depth + 1);
}

export async function collectPluginStorage(
  store,
  { canCollect = async () => true, collectCores = !store.companyCoreHead, dryRun = false } = {},
) {
  let plan;
  try {
    const withLock = dryRun ? async (action) => action() : store.withLock.bind(store);
    const withSelectionLock = dryRun
      ? async (action) => action()
      : store.withSelectionLock.bind(store);
    plan = await withLock(
      async () =>
        withSelectionLock(async () => {
          await directory(store.root);
          const state = await store.status();
          if (
            state.booting ||
            state.error ||
            state.referencesUncertain ||
            state.active !== state.verified
          )
            return { skipped: "boot-not-verified" };

          await store.selected();
          let companyCoreHead;
          if (store.companyCoreHead) {
            await directory(store.baseline);
            const baseline = await ownedReceipt(
              store.companyProfile,
              "gea",
              "installations",
              store.companyCoreHead,
              "baseline",
              "baseline.json",
            );
            if (
              baseline?.schema !== 1 ||
              !/^[a-f0-9]{40}$/.test(store.companyCoreHead) ||
              baseline.coreHead !== store.companyCoreHead ||
              resolve(store.root) !==
                join(
                  store.companyProfile,
                  "gea",
                  "installations",
                  store.companyCoreHead,
                  "plugins",
                ) ||
              resolve(store.baseline) !== join(store.root, "..", "baseline")
            )
              return { skipped: "invalid-company-ownership" };
            companyCoreHead = baseline.coreHead;
          }
          const eligible = async (path, id, receipt) => {
            if (receipt?.id !== id || receipt.state !== "prepared" || receipt.pinned === true)
              return false;
            if (companyCoreHead) {
              if (
                !companyAutomatic.test(id) ||
                (receipt.layout === "layered"
                  ? receipt.coreDataSchema !== store.dataSchema
                  : receipt.dataSchema !== store.dataSchema)
              )
                return false;
              if (receipt.ownership) {
                if (
                  receipt.ownership.schema !== 1 ||
                  receipt.ownership.kind !== "company-update" ||
                  receipt.ownership.coreHead !== companyCoreHead
                )
                  return false;
              } else if (!(await legacyCompanyOwned(store, path, id, receipt))) return false;
            } else if (!automatic.test(id)) return false;
            return canCollect(path, id, receipt);
          };
          const update = await optional(join(store.root, "update-state.json"));
          if (["downloading", "installing", "restarting"].includes(update?.phase))
            return { skipped: "update-in-progress" };
          const ids = new Set(["baseline"]);
          protect(state, ids);
          if (typeof update?.pending === "string" && update.phase === "pending")
            ids.add(update.pending);
          const versions = join(store.root, "versions"),
            trash = join(store.root, "trash");
          try {
            await directory(versions);
          } catch (error) {
            if (error.code === "ENOENT") return { skipped: "no-versions" };
            throw error;
          }
          if (!dryRun) {
            await mkdir(trash, { recursive: true, mode: 0o700 });
            await directory(trash);
          }
          const candidates = [];
          const retained = [];
          for (const entry of await readdir(versions, { withFileTypes: true })) {
            const id = entry.name;
            if (ids.has(id) || !entry.isDirectory() || entry.isSymbolicLink()) {
              retained.push(id);
              continue;
            }
            const path = join(versions, id);
            try {
              await directory(path);
              const receiptPath = join(path, "version.json");
              const receipt = await receiptFile(receiptPath);
              if (!(await eligible(path, id, receipt))) {
                retained.push(id);
                continue;
              }
              if (dryRun) {
                candidates.push({ id });
                continue;
              }
              const token = randomUUID(),
                target = join(trash, "gc-" + token),
                marker = target + ".json";
              await writeFile(marker, JSON.stringify({ schema: 1, id, token }), {
                flag: "wx",
                mode: 0o600,
              });
              try {
                await rename(path, target);
                candidates.push({ id, path: target, marker });
              } catch (error) {
                await rm(marker, { force: true });
                throw error;
              }
            } catch {
              retained.push(id);
            }
          }
          if (companyCoreHead)
            for (const entry of await readdir(store.root, { withFileTypes: true })) {
              if (!stageName.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
                continue;
              const path = join(store.root, entry.name);
              try {
                const contents = await failedCompanyMaterials(store, entry.name);
                if (!contents) {
                  retained.push(entry.name);
                  continue;
                }
                for (const item of contents) {
                  if (
                    !["node_modules", "packages"].includes(item.name) ||
                    !item.isDirectory() ||
                    item.isSymbolicLink()
                  )
                    continue;
                  const id = entry.name + "/" + item.name;
                  if (dryRun) {
                    candidates.push({ id, kind: "staging" });
                    continue;
                  }
                  const token = randomUUID(),
                    target = join(trash, "gc-" + token),
                    marker = target + ".json";
                  await writeFile(
                    marker,
                    JSON.stringify({
                      schema: 1,
                      kind: "staging",
                      id,
                      token,
                      coreHead: companyCoreHead,
                    }),
                    {
                      flag: "wx",
                      mode: 0o600,
                    },
                  );
                  try {
                    await rename(join(path, item.name), target);
                    candidates.push({ id, kind: "staging", path: target, marker });
                  } catch {
                    await rm(marker, { force: true });
                  }
                }
              } catch {
                retained.push(entry.name);
              }
            }
          const coreIds = new Set();
          let coreInventoryValid = true;
          try {
            if ((await readdir(store.root)).some((name) => name.startsWith("staging-")))
              coreInventoryValid = false;
            for (const entry of await readdir(versions, { withFileTypes: true })) {
              if (!entry.isDirectory() || entry.isSymbolicLink()) {
                coreInventoryValid = false;
                continue;
              }
              const receipt = await optional(join(versions, entry.name, "version.json"));
              if (!receipt || receipt.id !== entry.name) {
                coreInventoryValid = false;
                continue;
              }
              if (receipt.coreId) coreIds.add(receipt.coreId);
            }
            const preparedCore = await store.corePromise;
            if (preparedCore) coreIds.add(preparedCore.id);
            const cores = join(store.root, "cores");
            try {
              await directory(cores);
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
            if (!dryRun && collectCores && coreInventoryValid)
              for (const entry of await readdir(cores).catch((error) => {
                if (error.code === "ENOENT") return [];
                throw error;
              })) {
                if (!/^[a-f0-9]{64}$/.test(entry) || coreIds.has(entry)) continue;
                const path = join(cores, entry);
                await directory(path);
                const metadata = await optional(join(path, "core.json"));
                if (
                  metadata?.schema !== 1 ||
                  metadata.id !== entry ||
                  !/^[a-f0-9]{64}$/.test(metadata.archiveSha256 ?? "")
                )
                  continue;
                const token = randomUUID(),
                  target = join(trash, "gc-" + token),
                  marker = target + ".json";
                await writeFile(
                  marker,
                  JSON.stringify({ schema: 1, kind: "core", id: entry, token }),
                  { flag: "wx", mode: 0o600 },
                );
                try {
                  await rename(path, target);
                  candidates.push({ id: entry, kind: "core", path: target, marker });
                } catch {
                  await rm(marker, { force: true });
                }
              }
          } catch {
            coreInventoryValid = false;
          }

          for (const entry of await readdir(trash, { withFileTypes: true }).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          })) {
            if (!trashName.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink())
              continue;
            const path = join(trash, entry.name);
            if (candidates.some((c) => c.path === path)) continue;
            try {
              await directory(path);
              const marker = path + ".json";
              const stat = await lstat(marker);
              if (!stat.isFile() || stat.isSymbolicLink()) continue;
              const owner = await optional(marker);
              if (owner?.schema === 1 && entry.name === "gc-" + owner.token) {
                if (
                  owner.kind === "core" &&
                  collectCores &&
                  coreInventoryValid &&
                  /^[a-f0-9]{64}$/.test(owner.id) &&
                  !coreIds.has(owner.id)
                )
                  candidates.push({ id: owner.id, kind: "core", path, marker });
                else if (
                  owner.kind === "staging" &&
                  companyCoreHead &&
                  owner.coreHead === companyCoreHead &&
                  typeof owner.id === "string" &&
                  stageName.test(owner.id.split("/")[0]) &&
                  ["node_modules", "packages"].includes(owner.id.split("/")[1]) &&
                  owner.id.split("/").length === 2 &&
                  (await failedCompanyMaterials(store, owner.id.split("/")[0]))
                )
                  candidates.push({ id: owner.id, kind: "staging", path, marker });
                else if (
                  owner.kind === undefined &&
                  !ids.has(owner.id) &&
                  (await eligible(path, owner.id, await receiptFile(join(path, "version.json"))))
                )
                  candidates.push({ id: owner.id, path, marker });
              }
            } catch {}
          }
          return { candidates, retained };
        }),
      { purpose: "maintenance" },
    );
  } catch (error) {
    return {
      skipped: error.message === "PLUGIN_UPDATE_BUSY" ? "store-busy" : "invalid-storage-state",
      removed: [],
      failed: [],
    };
  }
  if (plan.skipped) return { ...plan, removed: [], failed: [] };
  if (dryRun)
    return {
      removed: [],
      failed: [],
      candidates: plan.candidates.map((item) => item.id),
      retained: plan.retained,
    };

  const removed = [],
    coresRemoved = [],
    stagingRemoved = [],
    failed = [];
  for (const item of plan.candidates) {
    try {
      await physicalFs.rm(item.path, { recursive: true, force: false, maxRetries: 0 });
      await rm(item.marker, { force: true });
      (item.kind === "core"
        ? coresRemoved
        : item.kind === "staging"
          ? stagingRemoved
          : removed
      ).push(item.id);
    } catch {
      failed.push(item.id);
    }
  }
  return { removed, coresRemoved, stagingRemoved, failed, retained: plan.retained };
}

export async function pruneUnreferencedArchives(graph) {
  let declarations = "";
  for (const name of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]) {
    try {
      declarations += "\n" + (await readFile(join(graph, name), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const root = join(graph, "packages");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  await directory(root);
  const removed = [];
  for (const entry of entries) {
    if (
      entry.isFile() &&
      /^[a-f0-9]{64}\.tgz$/.test(entry.name) &&
      !declarations.includes(entry.name)
    ) {
      await rm(join(root, entry.name));
      removed.push(entry.name);
    }
  }
  return removed;
}
