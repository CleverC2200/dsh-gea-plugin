import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/cordis-plugin-loader";
import type {} from "@deepseek-ai/dsh-client-modules/client";
import type {
  PluginUpdateProvider,
  PluginPackageUpdates,
  PluginPackageUpdateState,
} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
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

export function projectPluginUpdates(
  rows: PluginUpdateRow[],
): PluginPackageUpdates {
  const updates: Record<string, PluginPackageUpdateState> = {};
  for (const row of rows) {
    switch (row.state) {
      case "idle":
      case "checking":
        break;
      case "current":
      case "completed":
        updates[row.packageName] = { kind: "current" };
        break;
      case "available":
        updates[row.packageName] =
          row.candidateVersion && row.planId
            ? { kind: "available", version: row.candidateVersion }
            : {
                kind: "blocked",
                reason: "",
                problem: { kind: "policy", code: "plan-unconfirmed" },
              };
        break;
      case "check-failed":
        updates[row.packageName] = {
          kind: "check-failed",
          reason: "",
          problem: row.problem ?? { kind: "source", code: "unavailable" },
        };
        break;
      case "blocked":
        updates[row.packageName] = {
          kind: "blocked",
          reason: "",
          problem: row.problem ?? {
            kind: "policy",
            code:
              row.diagnostic === "UPDATE_SOURCE_NOT_CONFIGURED"
                ? "source-not-configured"
                : "conditions",
          },
        };
        break;
      case "downloading":
        updates[row.packageName] = { kind: "updating", phase: "downloading" };
        break;
      case "accepted":
        updates[row.packageName] = { kind: "updating", phase: "submitting" };
        break;
      case "waiting-lock":
      case "snapshotting":
        updates[row.packageName] = { kind: "updating", phase: row.state };
        break;
      case "installing":
      case "verifying":
      case "restoring":
        updates[row.packageName] = { kind: "updating", phase: row.state };
        break;
      case "pending-restart":
        updates[row.packageName] = {
          kind: "pending-restart",
          installedVersion: row.installedVersion ?? row.candidateVersion ?? "",
          ...(row.runningHostVersion &&
          row.runningHostVersion === row.runningClientVersion
            ? { runningVersion: row.runningHostVersion }
            : {}),
        };
        break;
      case "restored":
      case "failed":
        updates[row.packageName] = {
          kind: "failed",
          reason: "",
          problem: {
            kind: "policy",
            code: row.state === "restored" ? "restored" : "failed",
          },
          retryAvailable: false,
        };
        break;
      case "unknown":
        updates[row.packageName] = { kind: "unknown", reason: "" };
        break;
      default: {
        const exhaustive: never = row.state;
        throw Error(String(exhaustive));
      }
    }
  }
  return updates;
}

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
    if (!response.ok || result.ok !== true)
      throw Error("UPDATE_TRANSPORT_FAILED");
    return result.value;
  };
  const refresh = async (signal: AbortSignal) => {
    const next = parseUpdateClientStatus(
      await request("status", { pageIdentity }, signal),
    );
    if (
      !status ||
      status.hostProcessIdentity !== next.hostProcessIdentity ||
      next.revision >= status.revision
    ) {
      status = next;
      publish(projectPluginUpdates(next.items));
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
          pageIdentity,
          nonce: next.challenge,
          modules,
        },
        signal,
      ).catch(() => {
        signal.throwIfAborted();
      });
  };
  const provider: PluginUpdateProvider = {
    id: "gea-company-packages",
    packages: companyPackageNames,
    updates: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    check: async (_packages, signal) => {
      const initial = AbortSignal.any([
        signal,
        lifetime.signal,
        AbortSignal.timeout(status?.checkTimeoutMs ?? 5000),
      ]);
      if (!status) await refresh(initial);
      if (
        status!.items.every(
          (row) =>
            row.state === "blocked" && row.diagnostic?.startsWith("UPDATE_"),
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
    update: async (name) => {
      const row = status?.items.find((row) => row.packageName === name);
      if (!row || row.state !== "available" || !row.planId)
        throw Error("UPDATE_PLAN_STALE");
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
          AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(status!.checkTimeoutMs),
          ]),
        );
    },
  };
  const tick = () => {
    poll = refresh(
      AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(status?.checkTimeoutMs ?? 5000),
      ]),
    )
      .catch(() => {
        /* Existing authoritative state remains until a later status answers. */
      })
      .finally(() => {
        if (!lifetime.signal.aborted)
          timer = setTimeout(tick, status?.pollIntervalMs ?? 2000);
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
    if (scope.pluginUpdates.version !== 1) return;
    const owner = createPluginUpdatesProvider(scope);
    scope.effect(() => scope.pluginUpdates.register(owner.provider));
    scope.effect(() => () => owner.dispose());
    owner.start();
  });
  return () => fiber.dispose();
}
