import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-client-modules/client";
import { companyPackageNames } from "./shared/plugin-release.mjs";
import {
  compiledPackageStamp,
  parseUpdateClientStatus,
  updateObject,
  type UpdateClientReport,
  type UpdateClientStatus,
} from "./shared/plugin-update-wire.ts";
import type { PluginUpdateRow } from "./shared/plugin-update-state.ts";

/** Observe compiled exports that the public client Loader has actually activated. */
export function readClientPluginModules(
  ctx: Context,
): UpdateClientReport["modules"] {
  const modules = ctx.get("modules");
  if (!modules || modules.entries.state.getSnapshot().syncing) return [];
  const observed: UpdateClientReport["modules"] = [];
  for (const name of companyPackageNames) {
    const matches = [...ctx.loader.entries()].filter(
      (entry) => entry.options.name === name && !entry.disabled,
    );
    const entry = matches.length === 1 ? matches[0] : undefined,
      fiber = entry?.fiber,
      record = modules.loadCache.get(name);
    if (
      !entry ||
      fiber?.state !== 2 ||
      !record ||
      modules.entries.state
        .getSnapshot()
        .failures.some((failure) => failure.id === name)
    )
      continue;
    try {
      const namespace = updateObject(record.exports);
      if (
        ctx.registry.resolve(ctx.loader.unwrapExports(namespace)) !==
        fiber.runtime?.callback
      )
        continue;
      const revision = modules.manifest.modules.find(
        (row) => row.id === name,
      )?.rev;
      if (revision)
        observed.push({
          stamp: compiledPackageStamp(namespace.pluginPackageVersion, name),
          identity: `${entry.id}:${fiber.uid}`,
          desiredArtifactRevision: revision,
        });
    } catch {
      /* An unversioned or failed module remains an absent client observation. */
    }
  }
  return observed;
}

export type PluginDetailUpdateSnapshot = {
  items: PluginUpdateRow[];
  checking: boolean;
  submitting: string | null;
  transportError: "check" | "status" | "unknown" | null;
};
const activeStages: PluginUpdateRow["state"][] = [
  "checking",
  "downloading",
  "waiting-lock",
  "snapshotting",
  "accepted",
  "installing",
  "verifying",
  "restoring",
  "pending-restart",
  "unknown",
];
export const pluginUpdateBusy = (items: PluginUpdateRow[]) =>
  items.some((row) => activeStages.includes(row.state));

/** Detail views share requests; closing the last view releases its check and polling. */
export function createPluginDetailUpdates(ctx: Context) {
  const listeners = new Set<() => void>();
  let snapshot: PluginDetailUpdateSnapshot = {
    items: [],
    checking: false,
    submitting: null,
    transportError: null,
  };
  let status: UpdateClientStatus | undefined;
  let page:
    | {
        lifetime: AbortController;
        identity: string;
        refs: number;
        timer?: ReturnType<typeof setTimeout>;
        poll?: Promise<void>;
      }
    | undefined;
  let checking: Promise<void> | undefined,
    submitting: Promise<void> | undefined;
  let disposed = false;
  const publish = (patch: Partial<PluginDetailUpdateSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const request = async (
    action: string,
    payload: object,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const response = await fetch(`/api/gea/plugin-updates/${action}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const result = updateObject(await response.json());
    signal.throwIfAborted();
    if (!response.ok || result.ok !== true)
      throw Error("UPDATE_TRANSPORT_FAILED");
    return result.value;
  };
  const signalFor = (owner: NonNullable<typeof page>) =>
    AbortSignal.any([
      owner.lifetime.signal,
      AbortSignal.timeout(status?.checkTimeoutMs ?? 5000),
    ]);
  const refresh = async (
    owner: NonNullable<typeof page>,
    signal = signalFor(owner),
  ) => {
    const next = parseUpdateClientStatus(
      await request("status", { pageIdentity: owner.identity }, signal),
    );
    if (page !== owner) return;
    if (
      !status ||
      status.hostProcessIdentity !== next.hostProcessIdentity ||
      next.revision >= status.revision
    ) {
      status = next;
      publish({ items: next.items, transportError: null });
    }
    const modules = readClientPluginModules(ctx);
    if (
      modules.length &&
      next.items.some((row) => row.runningHostVersion !== null)
    )
      await request(
        "observed",
        {
          hostProcessIdentity: next.hostProcessIdentity,
          pageIdentity: owner.identity,
          nonce: next.challenge,
          modules,
        },
        signal,
      ).catch(() => {
        signal.throwIfAborted();
      });
  };
  const tick = async (owner: NonNullable<typeof page>) => {
    try {
      await refresh(owner);
    } catch {
      if (!owner.lifetime.signal.aborted) publish({ transportError: "status" });
    }
    if (page === owner && !owner.lifetime.signal.aborted)
      owner.timer = setTimeout(() => {
        owner.poll = tick(owner);
      }, status?.pollIntervalMs ?? 2000);
  };
  const close = (owner: NonNullable<typeof page>) => {
    if (page !== owner) return;
    clearTimeout(owner.timer);
    owner.lifetime.abort();
    page = undefined;
    publish({ checking: false });
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retain() {
      if (disposed) return () => {};
      if (!page) {
        page = {
          lifetime: new AbortController(),
          identity: crypto.randomUUID(),
          refs: 0,
        };
        page.poll = tick(page);
      }
      const owner = page;
      owner.refs++;
      return () => {
        if (--owner.refs === 0) close(owner);
      };
    },
    check(): Promise<void> {
      if (checking) return checking;
      const owner = page;
      if (!owner || submitting || pluginUpdateBusy(snapshot.items))
        return Promise.resolve();
      publish({ checking: true, transportError: null });
      const run = async () => {
        try {
          if (!status) await refresh(owner);
          await request("check", {}, signalFor(owner));
          await refresh(owner);
        } catch {
          if (!owner.lifetime.signal.aborted && page === owner)
            publish({ transportError: "check" });
        } finally {
          if (page === owner) publish({ checking: false });
        }
      };
      checking = run().finally(() => {
        checking = undefined;
      });
      return checking;
    },
    update(name: string): Promise<void> {
      if (submitting) return submitting;
      const row = snapshot.items.find((row) => row.packageName === name);
      if (
        !page ||
        snapshot.checking ||
        pluginUpdateBusy(snapshot.items) ||
        row?.state !== "available" ||
        !row.planId
      )
        return Promise.resolve();
      publish({ submitting: name, transportError: null });
      const run = async () => {
        try {
          // The Host owns an accepted operation, independent of the detail page lifetime.
          await request(
            "update",
            { packageName: row.packageName, planId: row.planId },
            AbortSignal.timeout(status?.checkTimeoutMs ?? 5000),
          );
        } catch {
          publish({
            transportError: "unknown",
            items: snapshot.items.map((item) =>
              item.packageName === name ? { ...item, state: "unknown" } : item,
            ),
          });
        } finally {
          publish({ submitting: null });
        }
        if (page)
          await refresh(page).catch(() => {
            publish({ transportError: "status" });
          });
      };
      submitting = run().finally(() => {
        submitting = undefined;
      });
      return submitting;
    },
    async dispose() {
      disposed = true;
      listeners.clear();
      const owner = page;
      if (owner) close(owner);
      await Promise.all([checking, owner?.poll]);
    },
  };
}
