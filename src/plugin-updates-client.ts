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

/** Project one Host row into the optional UI capability without depending on its SDK declarations. */
function projectPluginUpdate(row: PluginUpdateRow) {
  switch (row.state) {
    case "idle":
    case "checking":
      return undefined;
    case "current":
    case "completed":
      return { kind: "current" } as const;
    case "available":
      return row.candidateVersion && row.planId
        ? ({ kind: "available", version: row.candidateVersion } as const)
        : ({
            kind: "blocked",
            reason: "",
            problem: { kind: "policy", code: "plan-unconfirmed" },
          } as const);
    case "check-failed":
      return {
        kind: "check-failed",
        reason: "",
        problem: row.problem ?? { kind: "source", code: "unavailable" },
      } as const;
    case "blocked":
      return {
        kind: "blocked",
        reason: "",
        problem: row.problem ?? {
          kind: "policy",
          code:
            row.diagnostic === "UPDATE_SOURCE_NOT_CONFIGURED"
              ? "source-not-configured"
              : "conditions",
        },
      } as const;
    case "downloading":
      return { kind: "updating", phase: "downloading" } as const;
    case "accepted":
      return { kind: "updating", phase: "submitting" } as const;
    case "waiting-lock":
    case "snapshotting":
    case "installing":
    case "verifying":
    case "restoring":
      return { kind: "updating", phase: row.state } as const;
    case "pending-restart":
      return {
        kind: "pending-restart",
        installedVersion: row.installedVersion ?? row.candidateVersion ?? "",
        ...(row.runningHostVersion && row.runningHostVersion === row.runningClientVersion
          ? { runningVersion: row.runningHostVersion }
          : {}),
      } as const;
    case "restored":
    case "failed":
      return {
        kind: "failed",
        reason: "",
        problem: { kind: "policy", code: row.state === "restored" ? "restored" : "failed" },
        retryAvailable: false,
      } as const;
    case "unknown":
      return { kind: "unknown", reason: "" } as const;
    default: {
      const exhaustive: never = row.state;
      throw Error(String(exhaustive));
    }
  }
}

export function projectPluginUpdates(rows: PluginUpdateRow[]) {
  const updates: Record<string, NonNullable<ReturnType<typeof projectPluginUpdate>>> = {};
  for (const row of rows) {
    const state = projectPluginUpdate(row);
    if (state !== undefined) updates[row.packageName] = state;
  }
  return updates;
}

type PluginPackageUpdates = ReturnType<typeof projectPluginUpdates>;

/** Provider transport owns checks and observations; accepted updates remain Host-owned. */
export function createPluginUpdatesProvider(ctx: Context) {
  const lifetime = new AbortController(),
    listeners = new Set<() => void>(),
    pageIdentity = crypto.randomUUID();
  let status: UpdateClientStatus | undefined,
    snapshot: PluginPackageUpdates = {},
    timer: ReturnType<typeof setTimeout> | undefined;
  let poll: Promise<void> | undefined,
    started = false;
  const publish = (next: PluginPackageUpdates) => {
    if (lifetime.signal.aborted) return;
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Views cannot interrupt Host-owned work. */
      }
    }
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
  const refresh = async (signal: AbortSignal) => {
    const next = parseUpdateClientStatus(await request("status", { pageIdentity }, signal));
    if (
      !status ||
      status.hostProcessIdentity !== next.hostProcessIdentity ||
      next.revision >= status.revision
    ) {
      status = next;
      publish(projectPluginUpdates(next.items));
    }
    const modules = readClientPluginModules(ctx);
    if (modules.length && next.items.some((row) => row.runningHostVersion !== null))
      await request(
        "observed",
        {
          hostProcessIdentity: next.hostProcessIdentity,
          pageIdentity,
          nonce: next.challenge,
          modules,
        },
        signal,
      ).catch(() => {
        signal.throwIfAborted();
      });
  };
  const provider = {
    id: "gea-company-packages",
    packages: companyPackageNames,
    updates: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    check: async (_packages: readonly { readonly name: string }[], signal: AbortSignal) => {
      const initial = AbortSignal.any([
        signal,
        lifetime.signal,
        AbortSignal.timeout(status?.checkTimeoutMs ?? 5000),
      ]);
      if (!status) await refresh(initial);
      if (
        status!.items.every(
          (row) => row.state === "blocked" && row.diagnostic?.startsWith("UPDATE_"),
        )
      )
        return;
      const checked = AbortSignal.any([
        signal,
        lifetime.signal,
        AbortSignal.timeout(status!.checkTimeoutMs),
      ]);
      await request("check", {}, checked);
      await refresh(checked);
    },
    update: async (name: string) => {
      const row = status?.items.find((row) => row.packageName === name);
      if (!row || row.state !== "available" || !row.planId) throw Error("UPDATE_PLAN_STALE");
      // No page lifetime signal: closing the view cannot cancel an accepted Host submission.
      try {
        await request(
          "update",
          { packageName: row.packageName, planId: row.planId },
          AbortSignal.timeout(status!.checkTimeoutMs),
        );
      } catch {
        publish({ ...snapshot, [name]: { kind: "unknown", reason: "" } });
      }
      if (!lifetime.signal.aborted)
        await refresh(
          AbortSignal.any([lifetime.signal, AbortSignal.timeout(status!.checkTimeoutMs)]),
        );
    },
  };
  const tick = () => {
    poll = refresh(
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(status?.checkTimeoutMs ?? 5000)]),
    )
      .catch(() => {
        /* Existing authoritative state remains until a later status answers. */
      })
      .finally(() => {
        if (!lifetime.signal.aborted) timer = setTimeout(tick, status?.pollIntervalMs ?? 2000);
      });
  };
  return {
    provider,
    start() {
      if (!started) {
        started = true;
        tick();
      }
    },
    async dispose() {
      listeners.clear();
      clearTimeout(timer);
      lifetime.abort();
      await poll;
    },
  };
}

/** Attach only to the official versioned capability; absent capability preserves the existing client. */
export function mountPluginUpdatesClient(ctx: Context): () => Promise<void> {
  const fiber = ctx.inject(["pluginUpdates", "modules"], (scope) => {
    const capability: unknown = scope.get("pluginUpdates");
    if (
      capability === null ||
      typeof capability !== "object" ||
      !("version" in capability) ||
      capability.version !== 1 ||
      !("register" in capability) ||
      typeof capability.register !== "function"
    )
      return;
    const owner = createPluginUpdatesProvider(scope);
    // Native versioned capability: validate the callable and its disposer at this optional seam.
    const register = capability.register as (provider: typeof owner.provider) => unknown;
    scope.effect(() => {
      const release = register.call(capability, owner.provider);
      if (typeof release !== "function") throw Error("UPDATE_CAPABILITY_DISPOSER_INVALID");
      return release as () => void;
    });
    scope.effect(() => () => owner.dispose());
    owner.start();
  });
  return () => fiber.dispose();
}
