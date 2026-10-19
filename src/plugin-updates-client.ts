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
export function readClientPluginModules(ctx: Context): UpdateClientReport["modules"] {
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
      modules.entries.state.getSnapshot().failures.some((failure) => failure.id === name)
    )
      continue;
    try {
      const namespace = updateObject(record.exports);
      if (ctx.registry.resolve(ctx.loader.unwrapExports(namespace)) !== fiber.runtime?.callback)
        continue;
      const revision = modules.manifest.modules.find((row) => row.id === name)?.rev;
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
  notice: {
    kind: "progress" | "pending-restart" | "completed" | "restored" | "failed" | "unconfirmed";
    sequence: number;
  } | null;
};
export const pluginUpdateObservationMs = 120_000;
const operationStages: PluginUpdateRow["state"][] = [
  "downloading",
  "waiting-lock",
  "snapshotting",
  "accepted",
  "installing",
  "verifying",
  "restoring",
  "pending-restart",
];
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

export function createPluginDetailUpdates(ctx: Context) {
  const listeners = new Set<() => void>();
  let snapshot: PluginDetailUpdateSnapshot = {
    items: [],
    checking: false,
    submitting: null,
    transportError: null,
    notice: null,
  };
  let status: UpdateClientStatus | undefined;
  let page:
    | {
        lifetime: AbortController;
        identity: string;
        refs: number;
        timer?: ReturnType<typeof setTimeout>;
        poll?: Promise<void>;
        recovering: number;
        check?: AbortController;
        awaitingClient?: boolean;
        observation?: { names: readonly string[]; timer: ReturnType<typeof setTimeout> };
      }
    | undefined;
  let checking: Promise<void> | undefined, submitting: Promise<void> | undefined;
  let disposed = false;
  let resumed = false;
  let noticeKind: NonNullable<PluginDetailUpdateSnapshot["notice"]>["kind"] | undefined;
  let noticeSequence = 0;
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
    if (!response.ok || result.ok !== true) throw Error("UPDATE_TRANSPORT_FAILED");
    return result.value;
  };
  const signalFor = (owner: NonNullable<typeof page>) =>
    AbortSignal.any([owner.lifetime.signal, AbortSignal.timeout(status?.checkTimeoutMs ?? 5000)]);
  const notify = (kind: NonNullable<PluginDetailUpdateSnapshot["notice"]>["kind"]) => {
    if (noticeKind === kind) return;
    noticeKind = kind;
    publish({ notice: { kind, sequence: ++noticeSequence } });
  };
  const endObservation = (owner: NonNullable<typeof page>) => {
    clearTimeout(owner.observation?.timer);
    owner.observation = undefined;
    if (!owner.refs && !owner.recovering) close(owner);
  };
  const observe = (owner: NonNullable<typeof page>, names: readonly string[]) => {
    if (owner.observation || disposed) return;
    noticeKind = undefined;
    owner.observation = {
      names,
      timer: setTimeout(() => {
        notify("unconfirmed");
        endObservation(owner);
      }, pluginUpdateObservationMs),
    };
  };
  const reflectObservation = (owner: NonNullable<typeof page>) => {
    if (!owner.observation || page !== owner) return;
    const rows = owner.observation.names.map((name) =>
      snapshot.items.find((row) => row.packageName === name),
    );
    if (
      !owner.awaitingClient &&
      rows.every(
        (row) => row && ["pending-restart", "completed", "restored", "failed"].includes(row.state),
      )
    ) {
      notify(
        rows.some((row) => row?.state === "pending-restart")
          ? "pending-restart"
          : rows.some((row) => row?.state === "failed")
            ? "failed"
            : rows.some((row) => row?.state === "restored")
              ? "restored"
              : "completed",
      );
      endObservation(owner);
    } else
      notify(
        rows.some((row) => row?.state === "unknown") ||
          !rows.some((row) => row && operationStages.includes(row.state))
          ? "unconfirmed"
          : "progress",
      );
  };
  const publishStatus = (next: UpdateClientStatus) => {
    if (
      !status ||
      status.hostProcessIdentity !== next.hostProcessIdentity ||
      next.revision >= status.revision
    ) {
      status = next;
      publish({ items: next.items, transportError: null });
      return true;
    }
    return false;
  };
  const refresh = async (
    owner: NonNullable<typeof page>,
    signal = signalFor(owner),
    recovering = false,
  ) => {
    const next = parseUpdateClientStatus(
      await request("status", { pageIdentity: owner.identity }, signal),
    );
    if (page !== owner) return;
    publishStatus(next);
    if (recovering && owner.recovering) {
      owner.recovering = 0;
      const names = snapshot.items
        .filter((row) => operationStages.includes(row.state))
        .map((row) => row.packageName);
      if (names.length) observe(owner, names);
    }
    const confirming = snapshot.items.filter(
      (row) =>
        row.state === "pending-restart" &&
        row.candidateVersion !== null &&
        row.runningHostVersion === row.candidateVersion,
    );
    owner.awaitingClient = confirming.length > 0;
    const modules = readClientPluginModules(ctx);
    let acknowledged = false;
    if (modules.length && next.items.some((row) => row.runningHostVersion !== null)) {
      await request(
        "observed",
        {
          hostProcessIdentity: next.hostProcessIdentity,
          pageIdentity: owner.identity,
          nonce: next.challenge,
          modules,
        },
        signal,
      )
        .then(() => {
          acknowledged = true;
        })
        .catch(() => {
          signal.throwIfAborted();
        });
    }
    if (
      acknowledged &&
      confirming.length &&
      confirming.every((row) =>
        modules.some(
          (module) =>
            module.stamp.name === row.packageName && module.stamp.version === row.candidateVersion,
        ),
      )
    ) {
      const confirmed = parseUpdateClientStatus(
        await request("status", { pageIdentity: owner.identity }, signal),
      );
      if (page !== owner) return;
      if (publishStatus(confirmed)) owner.awaitingClient = false;
    }
    reflectObservation(owner);
  };
  const tick = async (owner: NonNullable<typeof page>) => {
    try {
      await refresh(owner, signalFor(owner), true);
      if (page !== owner) return;
    } catch {
      if (!owner.lifetime.signal.aborted) {
        publish({ transportError: "status" });
        if (owner.observation) notify("unconfirmed");
      }
      if (owner.recovering) owner.recovering--;
    }
    if (!owner.refs && !owner.observation && !owner.recovering) close(owner);
    if (page === owner && !owner.lifetime.signal.aborted)
      owner.timer = setTimeout(() => {
        owner.poll = tick(owner);
      }, status?.pollIntervalMs ?? 2000);
  };
  const close = (owner: NonNullable<typeof page>) => {
    if (page !== owner) return;
    clearTimeout(owner.timer);
    clearTimeout(owner.observation?.timer);
    owner.lifetime.abort();
    page = undefined;
    publish({ checking: false });
  };
  const submitRows = (names: readonly string[]): Promise<void> => {
    if (submitting) return submitting;
    const rows = names.map((name) => snapshot.items.find((row) => row.packageName === name));
    const selected = rows.filter(
      (row): row is PluginUpdateRow & { planId: string } =>
        row?.state === "available" && typeof row.planId === "string",
    );
    if (
      !page ||
      snapshot.checking ||
      pluginUpdateBusy(snapshot.items) ||
      selected.length !== names.length ||
      !selected.length ||
      new Set(names).size !== names.length
    )
      return Promise.resolve();
    publish({ submitting: names.join(","), transportError: null });
    observe(page, names);
    notify("progress");
    const run = async () => {
      try {
        await request(
          names.length === 1 ? "update" : "update-all",
          names.length === 1
            ? { packageName: selected[0]?.packageName, planId: selected[0]?.planId }
            : {
                plans: selected.map((row) => ({
                  packageName: row.packageName,
                  planId: row.planId,
                })),
              },
          AbortSignal.timeout(status?.checkTimeoutMs ?? 5000),
        );
      } catch {
        if (page?.observation) notify("unconfirmed");
        publish({
          transportError: "unknown",
          items: snapshot.items.map((item) =>
            names.includes(item.packageName) ? { ...item, state: "unknown" } : item,
          ),
        });
      } finally {
        publish({ submitting: null });
      }
      if (page)
        await refresh(page).catch(() => {
          publish({ transportError: "status" });
          if (page?.observation) notify("unconfirmed");
        });
    };
    submitting = run().finally(() => {
      submitting = undefined;
    });
    return submitting;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dismissNotice() {
      publish({ notice: null });
    },
    resume(): Promise<void> {
      if (resumed || disposed) return Promise.resolve();
      resumed = true;
      if (page) return page.poll ?? Promise.resolve();
      page = {
        lifetime: new AbortController(),
        identity: crypto.randomUUID(),
        refs: 0,
        recovering: 3,
      };
      page.poll = tick(page);
      return page.poll;
    },
    retain() {
      if (disposed) return () => {};
      if (!page) {
        page = {
          lifetime: new AbortController(),
          identity: crypto.randomUUID(),
          refs: 0,
          recovering: 0,
        };
        page.poll = tick(page);
      }
      const owner = page;
      owner.refs++;
      return () => {
        if (--owner.refs === 0) {
          owner.check?.abort();
          if (!owner.observation && !owner.recovering) close(owner);
        }
      };
    },
    check(): Promise<void> {
      if (checking) return checking;
      const owner = page;
      if (!owner || submitting || pluginUpdateBusy(snapshot.items)) return Promise.resolve();
      const cancellation = new AbortController();
      owner.check = cancellation;
      const signal = () => AbortSignal.any([signalFor(owner), cancellation.signal]);
      publish({ checking: true, transportError: null });
      const run = async () => {
        try {
          if (!status) await refresh(owner, signal());
          await request("check", {}, signal());
          await refresh(owner, signal());
        } catch {
          if (!cancellation.signal.aborted && !owner.lifetime.signal.aborted && page === owner)
            publish({ transportError: "check" });
        } finally {
          if (owner.check === cancellation) owner.check = undefined;
          if (page === owner) publish({ checking: false });
        }
      };
      checking = run().finally(() => {
        checking = undefined;
      });
      return checking;
    },
    update: (name: string) => submitRows([name]),
    updateAll: (names: readonly string[]) => submitRows(names),
    async dispose() {
      disposed = true;
      listeners.clear();
      const owner = page;
      if (owner) close(owner);
      await Promise.all([checking, owner?.poll]);
    },
  };
}
