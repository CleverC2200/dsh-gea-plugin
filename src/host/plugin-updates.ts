import { prepareWindowsFileCommit } from "./plugin-update-windows.ts";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-client-modules";
import type {} from "@deepseek-ai/dsh-cmdline";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createPluginReleaseSource,
  parsePluginReleaseSourceConfig,
} from "./plugin-release-source.ts";
import {
  createPluginUpdateController,
  pluginUpdateProcessIdentity,
} from "./plugin-update-controller.ts";
import { readHostPluginModules } from "./plugin-update-runtime.ts";
import { readPluginUpdateCore } from "./plugin-update-core.ts";
import { companyPackageNames } from "../shared/plugin-release.mjs";
import {
  parseUpdateClientReport,
  updateObject,
  updatePackageName,
  type UpdateClientStatus,
} from "../shared/plugin-update-wire.ts";
import type { ClientModuleObservation, PluginUpdateRow } from "../shared/plugin-update-state.ts";

/** The authenticated page reports materialized exports; Host verifies binding and its own ACTIVE facts. */
export function validateClientObservation(
  raw: unknown,
  binding: { hostProcessIdentity: string; pageIdentity: string; nonce: string; expires: number },
  host: Awaited<ReturnType<typeof readHostPluginModules>>,
  graph: { entries: readonly { id: string; rev: string }[] } | undefined,
) {
  const report = parseUpdateClientReport(raw);
  if (
    report.hostProcessIdentity !== binding.hostProcessIdentity ||
    report.pageIdentity !== binding.pageIdentity ||
    report.nonce !== binding.nonce ||
    binding.expires <= Date.now()
  )
    throw Error("UPDATE_CLIENT_BINDING_INVALID");
  for (const module of report.modules) {
    const proof = host.find((row) => row.name === module.stamp.name);
    if (
      proof?.host.kind !== "active" ||
      proof.host.stamp.version !== module.stamp.version ||
      !graph?.entries.some(
        (row) => row.id === module.stamp.name && row.rev === module.desiredArtifactRevision,
      )
    )
      throw Error("UPDATE_CLIENT_STAMP_MISMATCH");
  }
  return report;
}

/** Mount only authenticated transport routes; GEA business identity is unrelated to plugin installation. */
export function mountPluginUpdates(
  ctx: Context,
  raw: unknown,
  deployment: { requestTimeoutMs: number; runtimeDir: string },
): () => Promise<void> {
  const lifetime = new AbortController(),
    routes: (() => void)[] = [];
  const pages = new Map<string, { nonce: string; expires: number }>();
  const observations = new Map<string, Extract<ClientModuleObservation, { kind: "observed" }>>();
  let controller: ReturnType<typeof createPluginUpdateController> | undefined,
    controllerReady = false;
  let diagnostic = "UPDATE_SOURCE_NOT_CONFIGURED",
    timeout = deployment.requestTimeoutMs,
    pollInterval = 2000,
    revision = 0;
  let initialize: Promise<void> | undefined,
    stopped = false,
    bootReady = ctx.get("appReady") === undefined;
  const blocked = (): PluginUpdateRow[] =>
    companyPackageNames.map((packageName) => ({
      packageName,
      installedVersion: null,
      runningHostVersion: null,
      runningClientVersion: null,
      candidateVersion: null,
      planId: null,
      state: "blocked",
      diagnostic,
      problem: {
        kind: "policy",
        code:
          diagnostic === "UPDATE_SOURCE_NOT_CONFIGURED" ? "source-not-configured" : "conditions",
      },
    }));
  const ready = (): Promise<void> =>
    (initialize ??= (async () => {
      if (raw === undefined || stopped) return;
      try {
        const config = updateObject(raw);
        if (
          Object.keys(config).some(
            (key) => !["source", "core", "checkTimeoutMs", "pollIntervalMs"].includes(key),
          ) ||
          !Number.isSafeInteger(config.checkTimeoutMs) ||
          Number(config.checkTimeoutMs) < 1000 ||
          Number(config.checkTimeoutMs) > 120000 ||
          !Number.isSafeInteger(config.pollIntervalMs) ||
          Number(config.pollIntervalMs) < 1000 ||
          Number(config.pollIntervalMs) > 30000
        )
          throw Error("UPDATE_CONFIG_INVALID");
        timeout = Number(config.checkTimeoutMs);
        pollInterval = Number(config.pollIntervalMs);
        const sourceConfig = parsePluginReleaseSourceConfig(config.source);
        if (sourceConfig.authenticationRef !== "anonymous")
          throw Error("UPDATE_SOURCE_AUTHENTICATION_UNSUPPORTED");
        const core = await readPluginUpdateCore(ctx, config.core);
        lifetime.signal.throwIfAborted();
        const fileCommit =
          process.platform === "win32"
            ? await prepareWindowsFileCommit(
                join(deployment.runtimeDir, "plugin-updates/windows-platform"),
                ctx.profileContext.installAnchor,
                core.version,
              )
            : undefined;
        const source = createPluginReleaseSource(sourceConfig, {
          fileCommit,
          trustDirectory: join(deployment.runtimeDir, "plugin-updates/source-trust"),
          resolveAuthentication: async (reference) => {
            if (reference !== "anonymous") throw Error("UPDATE_SOURCE_AUTHENTICATION_UNSUPPORTED");
            return {};
          },
        });
        controller = createPluginUpdateController({
          profile: ctx.profileContext,
          core,
          source,
          runtimeDirectory: join(deployment.runtimeDir, "plugin-updates"),
          fileCommit,
          readRuntimeProofs: async () => {
            const proofs = await readHostPluginModules(ctx);
            return proofs.map((proof) => {
              const observed = observations.get(proof.name),
                page = observed ? pages.get(observed.binding.pageIdentity) : undefined;
              return {
                ...proof,
                client:
                  observed &&
                  page &&
                  page.nonce === observed.binding.nonce &&
                  page.expires > Date.now()
                    ? observed
                    : { kind: "unverified", reason: "CLIENT_OBSERVATION_MISSING" },
              };
            });
          },
        });
        await controller.initialize();
        controllerReady = true;
      } catch (error) {
        diagnostic =
          error instanceof Error && /^UPDATE_[A-Z_]+$/.test(error.message)
            ? error.message
            : "UPDATE_CORE_OR_SOURCE_UNVERIFIED";
      }
    })());
  for (const action of ["status", "check", "update", "observed"] as const) {
    routes.push(
      ctx.connection.fetch.register({
        path: `/api/gea/plugin-updates/${action}`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request: Request) => {
          try {
            if (!bootReady) throw Error("UPDATE_HOST_STARTING");
            await ready();
            if (stopped) throw Error("UPDATE_HOST_CLOSED");
            const payload = updateObject(await request.json());
            if (action === "status") {
              if (
                Object.keys(payload).length !== 1 ||
                typeof payload.pageIdentity !== "string" ||
                !payload.pageIdentity ||
                payload.pageIdentity.length > 200
              )
                throw Error("UPDATE_REQUEST_INVALID");
              for (const [id, page] of pages) if (page.expires <= Date.now()) pages.delete(id);
              let page = pages.get(payload.pageIdentity);
              if (!page) {
                page = { nonce: randomUUID(), expires: 0 };
                pages.set(payload.pageIdentity, page);
              }
              page.expires = Date.now() + Math.max(timeout, pollInterval) * 3;
              const state = controllerReady ? controller?.snapshot() : undefined;
              const items =
                state?.items.map((item) => {
                  const observed = observations.get(item.packageName),
                    owner = observed ? pages.get(observed.binding.pageIdentity) : undefined;
                  return {
                    ...item,
                    runningClientVersion:
                      observed && owner && owner.expires > Date.now()
                        ? observed.stamp.version
                        : null,
                  };
                }) ?? blocked();
              const value: UpdateClientStatus = {
                revision: Math.max(state?.revision ?? 0, revision),
                items,
                hostProcessIdentity: pluginUpdateProcessIdentity,
                challenge: page.nonce,
                checkTimeoutMs: timeout,
                pollIntervalMs: pollInterval,
              };
              return Response.json(
                { ok: true, value },
                { headers: { "Cache-Control": "no-store" } },
              );
            }
            if (!controller || !controllerReady) throw Error(diagnostic);
            if (action === "check") {
              if (Object.keys(payload).length) throw Error("UPDATE_REQUEST_INVALID");
              await controller.check(
                AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(timeout)]),
              );
            } else if (action === "update") {
              if (
                Object.keys(payload).some((key) => !["packageName", "planId"].includes(key)) ||
                typeof payload.planId !== "string" ||
                !/^[a-f0-9-]{36}$/.test(payload.planId)
              )
                throw Error("UPDATE_REQUEST_INVALID");
              const operation = await controller.submit({
                packageName: updatePackageName(payload.packageName),
                planId: payload.planId,
              });
              return Response.json({
                ok: true,
                value: { id: operation.id, stage: operation.stage },
              });
            } else {
              const report = parseUpdateClientReport(payload),
                page = pages.get(report.pageIdentity);
              if (
                report.hostProcessIdentity !== pluginUpdateProcessIdentity ||
                !page ||
                page.nonce !== report.nonce ||
                page.expires <= Date.now()
              )
                throw Error("UPDATE_CLIENT_BINDING_INVALID");
              validateClientObservation(
                report,
                {
                  hostProcessIdentity: pluginUpdateProcessIdentity,
                  pageIdentity: report.pageIdentity,
                  ...page,
                },
                await readHostPluginModules(ctx),
                ctx.get("clientModules")?.graph(),
              );
              for (const [name, observed] of observations)
                if (observed.binding.pageIdentity === report.pageIdentity)
                  observations.delete(name);
              for (const module of report.modules)
                observations.set(module.stamp.name, {
                  kind: "observed",
                  stamp: module.stamp,
                  identity: `${module.identity}:${module.desiredArtifactRevision}`,
                  binding: {
                    hostProcessIdentity: report.hostProcessIdentity,
                    pageIdentity: report.pageIdentity,
                    nonce: report.nonce,
                  },
                });
              await controller.reconcileRuntime();
            }
            revision++;
            return Response.json({ ok: true, value: null });
          } catch (error) {
            const code =
              error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
                ? error.message
                : "UPDATE_REQUEST_FAILED";
            return Response.json({ ok: false, error: { code } }, { status: 409 });
          }
        },
      }),
    );
  }
  const cancelReady = ctx.get("appReady")?.onReady(() => {
    bootReady = true;
    void ready();
  });
  return async () => {
    if (stopped) return;
    stopped = true;
    cancelReady?.();
    for (const release of routes) release();
    pages.clear();
    observations.clear();
    lifetime.abort();
    await initialize;
    await controller?.dispose();
  };
}
