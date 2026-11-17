import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { createDesktopUpdates, desktopRestartTarget } from "./desktop-updates-client.ts";
import type { PluginDetailProps } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { PropsLocale, PropsRuntime, TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, Tag, Toast, Tooltip, type TagTone } from "@deepseek-ai/dsh-client-ui-primitives";
import { updatablePackageNames } from "./shared/plugin-release.mjs";
import type { PluginUpdateProblem } from "./shared/plugin-update-diagnostics.ts";
import type { PluginUpdateRow } from "./shared/plugin-update-state.ts";
import {
  createPluginDetailUpdates,
  pluginUpdateBusy,
  pluginSuiteReady,
  pluginUpdateObservationMs,
} from "./plugin-updates-client.ts";
import { en, zh, pluginUpdateLocale } from "./plugin-update-locales.ts";
import css from "./plugin-detail-updates.css";

type Owner = ReturnType<typeof createPluginDetailUpdates>;
type Props = PluginDetailProps &
  PropsLocale<typeof pluginUpdateLocale> & {
    updates: Owner;
    openUpdates: () => void;
  };
function targetName(subject: PluginDetailProps["subject"]) {
  return subject.kind === "bundle"
    ? updatablePackageNames.find((name) => name === subject.pkg.name)
    : undefined;
}
function useDetail(updates: Owner) {
  useEffect(() => updates.retain(), [updates]);
  return useSyncExternalStore(updates.subscribe, updates.getSnapshot);
}
function UpdateActions({ subject, openUpdates, t }: Props): ReactNode {
  const name = targetName(subject);
  return name ? (
    <Button size="sm" variant="outline" onClick={openUpdates}>
      {t("viewStatus")}
    </Button>
  ) : null;
}
function DetailActions({
  updates,
  t,
  updateAll,
}: { updates: Owner; updateAll?: () => Promise<void> } & PropsLocale<
  typeof pluginUpdateLocale
>): ReactNode {
  const state = useDetail(updates);
  const available =
    state.items.some((row) => row.state === "available" && row.planId) &&
    pluginSuiteReady(state.items);
  const busy = state.checking || state.submitting !== null || pluginUpdateBusy(state.items);
  return (
    <div className="gea-plugin-update-actions">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          void updates.check();
        }}
      >
        {t("check")}
      </Button>
      {available ? (
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => {
            void (updateAll ? updateAll() : updates.updateAll());
          }}
        >
          {t("restartUpdate")}
        </Button>
      ) : null}
    </div>
  );
}
function UpdateBadge({ subject, updates, t }: Props): ReactNode {
  const name = targetName(subject);
  return name ? <DetailBadge name={name} updates={updates} t={t} /> : null;
}
function tone(state: PluginUpdateRow["state"] | "submitting"): TagTone {
  if (["failed", "check-failed", "unknown"].includes(state)) return "danger";
  if (["pending-restart", "restored", "blocked"].includes(state)) return "warning";
  if (["completed", "current"].includes(state)) return "success";
  return "info";
}
function DetailBadge({
  name,
  updates,
  t,
}: { name: string; updates: Owner } & PropsLocale<typeof pluginUpdateLocale>): ReactNode {
  const state = useDetail(updates),
    row = state.items.find((row) => row.packageName === name);
  const stage =
    state.submitting?.split(",").includes(name) && (!row || row.state === "available")
      ? "submitting"
      : state.checking
        ? "checking"
        : (row?.state ?? "idle");
  return (
    <span role="status">
      <Tag tone={tone(stage)}>{t(stage)}</Tag>
    </span>
  );
}
function problemText(
  problem: PluginUpdateProblem | undefined,
  t: TranslateNS<typeof pluginUpdateLocale>,
): string | undefined {
  if (!problem) return;
  switch (problem.kind) {
    case "policy":
      return t(
        problem.code === "restored"
          ? "restoredReason"
          : problem.code === "failed"
            ? "failedReason"
            : problem.code,
      );
    case "source":
      return t(problem.code === "unavailable" ? "sourceUnavailable" : problem.code);
    case "environment":
      return t("platform");
    case "core":
      return t("core");
    case "dependencies":
      return t("dependencies");
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}
function UpdateSection({ subject, updates, t }: Props): ReactNode {
  const name = targetName(subject);
  return name ? (
    <DetailSection
      name={name}
      installedVersion={subject.kind === "bundle" ? subject.pkg.version : undefined}
      updates={updates}
      t={t}
    />
  ) : null;
}
function DetailSection({
  name,
  installedVersion,
  showTitle = true,
  updates,
  t,
}: {
  name: string;
  installedVersion?: string;
  showTitle?: boolean;
  updates: Owner;
} & PropsLocale<typeof pluginUpdateLocale>): ReactNode {
  const state = useDetail(updates),
    row = state.items.find((row) => row.packageName === name);
  const problem = problemText(row?.problem, t);
  const error =
    row?.state === "blocked" && problem
      ? problem
      : state.transportError
        ? t(
            state.transportError === "check"
              ? "checkError"
              : state.transportError === "unknown"
                ? "unknownError"
                : "statusError",
          )
        : problem;
  return (
    <section className="gea-plugin-update-section" aria-label={t("title")}>
      {showTitle ? <h3 className="gea-plugin-update-title">{t("title")}</h3> : null}
      <dl className="gea-plugin-update-versions">
        <dt>{t("installed")}</dt>
        <dd>{row?.installedVersion ?? installedVersion ?? t("unavailable")}</dd>
        <dt>{t("host")}</dt>
        <dd>{row?.runningHostVersion ?? t("unavailable")}</dd>
        <dt>{t("client")}</dt>
        <dd>{row?.runningClientVersion ?? t("unavailable")}</dd>
        <dt>{t("candidate")}</dt>
        <dd>{row?.candidateVersion ?? t("unavailable")}</dd>
      </dl>
      {row?.state === "pending-restart" ? (
        <p className="gea-plugin-update-notice" role="status">
          {t("restart")}
        </p>
      ) : null}
      {error ? (
        <p className="gea-plugin-update-error" role="alert">
          {error}
        </p>
      ) : null}
      {row?.problem?.kind === "dependencies" ? (
        <>
          <div
            className="gea-plugin-update-requirements"
            role="region"
            aria-label={t("requirements")}
            tabIndex={0}
          >
            {row.problem.requirements.map((requirement, index) => (
              <dl className="gea-plugin-update-versions" key={index}>
                <dt>{t("consumer")}</dt>
                <dd>{requirement.consumer}</dd>
                <dt>{t("dependency")}</dt>
                <dd>{requirement.dependency}</dd>
                <dt>{t("required")}</dt>
                <dd>{requirement.required}</dd>
                <dt>{t("dependencyCurrent")}</dt>
                <dd>{requirement.current ?? t("unavailable")}</dd>
                <dt>{t("dependencyCandidate")}</dt>
                <dd>{requirement.candidate ?? t("unchanged")}</dd>
              </dl>
            ))}
          </div>
          <p className="gea-plugin-update-notice">
            {row.problem.nextStep
              ? t("dependenciesNextStep", {
                  packageName: row.problem.nextStep.packageName,
                  version: row.problem.nextStep.version,
                })
              : t("dependenciesAction")}
          </p>
        </>
      ) : null}
      {row?.state === "restored" && !error ? (
        <p className="gea-plugin-update-notice">{t("restoredReason")}</p>
      ) : null}
      {row?.state === "unknown" && !error ? (
        <p className="gea-plugin-update-error" role="alert">
          {t("unknownError")}
        </p>
      ) : null}
      {row?.state === "failed" && !error ? (
        <p className="gea-plugin-update-error" role="alert">
          {t("failedReason")}
        </p>
      ) : null}
    </section>
  );
}
function ListBadge({ subject, updates, t }: Props): ReactNode {
  const name = targetName(subject);
  const state = useDetail(updates);
  const row = state.items.find((item) => item.packageName === name);
  if (!name || !row || row.state === "idle") return null;
  return (
    <span className={`gea-plugin-list-status ${row.state}`} role="status">
      {row.state === "available" && row.candidateVersion
        ? t("newVersion", { version: row.candidateVersion })
        : t(state.checking ? "checking" : row.state)}
    </span>
  );
}
function ListTools({
  registerRefresh,
  updates,
  openUpdates,
  t,
}: PropsRuntime<"plugins.list.tools"> &
  PropsLocale<typeof pluginUpdateLocale> & {
    updates: Owner;
    openUpdates: () => void;
  }): ReactNode {
  const state = useDetail(updates);
  useEffect(
    () =>
      registerRefresh(async () => {
        await updates.check();
      }),
    [registerRefresh, updates],
  );
  return (
    <div className="gea-plugin-list-tools">
      <span className="gea-plugin-list-summary" role="status">
        {state.checking ? t("checking") : state.transportError ? t("statusError") : ""}
      </span>
      <Button size="sm" variant="outline" onClick={openUpdates}>
        {t("viewStatus")}
      </Button>
    </div>
  );
}

function UpdateNotice({
  updates,
  openStatus,
  t,
}: PropsLocale<typeof pluginUpdateLocale> & {
  updates: Owner;
  openStatus: (packageName: string) => void;
}): ReactNode {
  const state = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const notice = state.notice;
  const restarting = ["restarting", "requested"].includes(state.restart);
  const restartBusy =
    state.restartReady === false ||
    state.checking ||
    state.submitting !== null ||
    state.items.some((row) => row.state !== "pending-restart" && pluginUpdateBusy([row]));
  if (!notice) return null;
  const packageName = notice.packageName;
  const actions = packageName
    ? [{ label: t("viewStatus"), onClick: () => openStatus(packageName) }]
    : [];
  if (notice.kind === "pending-restart" && !restartBusy && !restarting) {
    actions.unshift({
      label: t("restartUpdate"),
      onClick: () => {
        void updates.restart();
      },
    });
  }
  const text =
    notice.kind === "progress"
      ? t("progressNotice")
      : notice.kind === "pending-restart"
        ? t("pendingNotice")
        : notice.kind === "completed"
          ? t("completed")
          : notice.kind === "restored"
            ? t("restoredReason")
            : notice.kind === "failed"
              ? t("failedReason")
              : t("unconfirmedNotice");
  return (
    <Toast
      key={notice.sequence}
      text={
        state.restart === "failed"
          ? t("restartError")
          : state.restart === "unsupported"
            ? t("takeoverUnsupported")
            : restarting
              ? t("takeoverStarting")
              : text
      }
      actions={actions}
      holdMs={notice.kind === "progress" ? pluginUpdateObservationMs : 15000}
      onDone={updates.dismissNotice}
    />
  );
}

type DesktopOwner = ReturnType<typeof createDesktopUpdates>;
type SharedProps = PropsLocale<typeof pluginUpdateLocale> & {
  updates: Owner;
  desktop: DesktopOwner;
  openUpdates: () => void;
};
async function restartUpdates(updates: Owner, desktop: DesktopOwner) {
  const client = desktop.getSnapshot();
  const target = desktopRestartTarget(client.presentation);
  if (target) {
    await desktop.restartUpdate({ kind: "desktop", version: target });
  } else if (updates.getSnapshot().items.some((row) => row.state === "pending-restart")) {
    await updates.restart();
  } else {
    await updates.updateAll();
  }
}
function UpdateEntry({
  wide,
  hidden,
  updates,
  desktop,
  openUpdates,
  t,
}: PropsRuntime<"settings.update"> & SharedProps): ReactNode {
  const plugins = useDetail(updates);
  const client = useSyncExternalStore(desktop.subscribe, desktop.getSnapshot);
  const desktopVersion = desktopRestartTarget(client.presentation);
  const version =
    desktopVersion ??
    plugins.items.find(
      (row) =>
        row.packageName === "@cleverc2200/gea-dsh-prototype" &&
        ["available", "pending-restart"].includes(row.state),
    )?.candidateVersion ??
    plugins.items.find((row) => ["available", "pending-restart"].includes(row.state))
      ?.candidateVersion;
  const available =
    Boolean(desktopVersion) ||
    (pluginSuiteReady(plugins.items) &&
      plugins.items.some((row) => row.state === "available" && row.planId));
  const pending = plugins.items.some((row) => row.state === "pending-restart");
  const attention =
    (plugins.companyUpdate && !["completed", "cancelled"].includes(plugins.companyUpdate.phase)) ||
    available ||
    pending ||
    client.failed ||
    plugins.transportError ||
    plugins.items.some((row) => !["idle", "current", "completed"].includes(row.state));
  if (!wide || hidden || !attention) return null;
  const busy =
    client.opening ||
    plugins.submitting !== null ||
    plugins.restart === "restarting" ||
    plugins.restart === "requested";
  const supported = client.canRestartUpdate;
  return (
    <Tooltip label={t(supported ? "takeoverNotice" : "takeoverUnsupported")} side="top">
      <button
        type="button"
        className="gea-update-entry"
        aria-label={t(available || pending ? "restartUpdate" : "updates")}
        disabled={busy}
        onClick={() => {
          if (!supported || (!available && !pending)) openUpdates();
          else void restartUpdates(updates, desktop).catch(() => openUpdates());
        }}
      >
        <span className="gea-update-version">
          {version
            ? t("newVersion", { version })
            : t(pending ? "pending-restart" : available ? "pluginsNewVersion" : "updates")}
        </span>
        <span className="gea-update-action">
          {t(busy ? "takeoverStarting" : available || pending ? "restartUpdate" : "viewStatus")}
        </span>
      </button>
    </Tooltip>
  );
}
function UpdateToggleBadge({
  updates,
  desktop,
  t,
}: PropsRuntime<"sidebar.toggle.badge"> & SharedProps): ReactNode {
  const plugins = useDetail(updates);
  const client = useSyncExternalStore(desktop.subscribe, desktop.getSnapshot);
  if (
    !client.failed &&
    (!plugins.companyUpdate || ["completed", "cancelled"].includes(plugins.companyUpdate.phase)) &&
    (!client.presentation || client.presentation.phase === "idle") &&
    !plugins.transportError &&
    plugins.items.every((row) => ["idle", "current", "completed"].includes(row.state))
  )
    return null;
  return (
    <Tooltip label={t("updates")} side="right">
      <span role="img" aria-label={t("updates")} className="gea-update-dot" />
    </Tooltip>
  );
}
function UpdatesPanel({ updates, desktop, t }: SharedProps): ReactNode {
  const plugins = useDetail(updates);
  const client = useSyncExternalStore(desktop.subscribe, desktop.getSnapshot);
  const [coordinationFailure, setCoordinationFailure] = useState(false);
  const state = client.presentation;
  const target = desktopRestartTarget(state);
  useEffect(() => {
    const initial = desktop.getSnapshot();
    if (
      initial.canCheck &&
      !initial.checked &&
      (!initial.presentation || initial.presentation.phase === "idle")
    )
      void desktop.check().catch(() => undefined);
  }, [desktop]);
  const nativeBusy =
    client.opening ||
    Boolean(state && ["checking", "downloading", "verifying", "installing"].includes(state.phase));
  const pending = plugins.items.some((row) => row.state === "pending-restart");
  const beginUpdate = async () => {
    setCoordinationFailure(false);
    try {
      await restartUpdates(updates, desktop);
    } catch {
      setCoordinationFailure(true);
    }
  };
  const failure = state?.failure;
  const failureText =
    failure === "check" || failure === "check-network"
      ? t("desktopFailureCheck")
      : failure === "download" || failure === "download-network"
        ? t("desktopFailureDownload")
        : failure === "stop-failed"
          ? t("desktopFailureStop")
          : failure === "tasks-changed" || failure === "tasks-unavailable"
            ? t("desktopFailureTasks")
            : t("desktopFailureInstall");
  return (
    <div className="gea-updates-panel">
      <p>{t("unifiedPolicy")}</p>
      {plugins.companyUpdate && plugins.companyUpdate.phase !== "cancelled" ? (
        <p role="status">
          {t(
            plugins.companyUpdate.phase === "completed"
              ? "companyCompleted"
              : plugins.companyUpdate.phase === "failed"
                ? "companyFailed"
                : plugins.companyUpdate.phase === "verifying"
                  ? "companyVerifying"
                  : "companyPrepared",
            { version: plugins.companyUpdate.desktopVersion },
          )}
        </p>
      ) : null}
      {!client.canRestartUpdate || plugins.restart === "unsupported" ? (
        <p role="alert">{t("takeoverUnsupported")}</p>
      ) : null}
      {coordinationFailure || plugins.restart === "failed" ? (
        <p role="alert">{t("restartError")}</p>
      ) : null}
      <section aria-labelledby="gea-desktop-update-title">
        <h2 id="gea-desktop-update-title">{t("desktopTitle")}</h2>
        <dl className="gea-plugin-update-versions">
          <dt>{t("currentVersion")}</dt>
          <dd>{client.current ?? t(client.versionFailed ? "unavailable" : "versionLoading")}</dd>
          {state?.version ? (
            <>
              <dt>{t("targetVersion")}</dt>
              <dd>{state.version}</dd>
            </>
          ) : null}
        </dl>
        {!client.supported ? (
          <p>{t("desktopUnavailable")}</p>
        ) : (
          <>
            <p role="status">
              {state?.phase === "ready"
                ? t("desktopRestart")
                : state?.phase === "idle"
                  ? t(client.checked ? "desktopIdle" : "idle")
                  : state?.phase === "downloading" && state.percent !== undefined
                    ? t("desktopProgress", {
                        percent: String(Math.round(state.percent)),
                      })
                    : state && state.phase !== "error"
                      ? t(state.phase)
                      : ""}
            </p>
            {state && ["downloading", "verifying", "installing"].includes(state.phase) ? (
              <progress
                aria-label={t("desktopTitle")}
                max={100}
                value={state.phase === "downloading" ? state.percent : undefined}
              />
            ) : null}
            {client.failed || state?.phase === "error" ? (
              <p role="alert" className="gea-plugin-update-error">
                {client.failed ? t("desktopStatusError") : failureText}
              </p>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              disabled={nativeBusy || !client.canRestartUpdate}
              onClick={() => {
                if (target) void beginUpdate();
                else void desktop.check().catch(() => setCoordinationFailure(true));
              }}
            >
              {t(target ? "restartUpdate" : "desktopCheck")}
            </Button>
          </>
        )}
      </section>
      <section aria-labelledby="gea-plugin-update-title">
        <h2 id="gea-plugin-update-title">{t("pluginsTitle")}</h2>
        {!nativeBusy && !target ? (
          <DetailActions updates={updates} t={t} updateAll={beginUpdate} />
        ) : null}
        {plugins.transportError ? (
          <p role="alert" className="gea-plugin-update-error">
            {t(
              plugins.transportError === "check"
                ? "checkError"
                : plugins.transportError === "unknown"
                  ? "unknownError"
                  : "statusError",
            )}
          </p>
        ) : null}
        {pending ? <p role="status">{t("pendingNotice")}</p> : null}
        {pending ? (
          <Button
            size="sm"
            variant="outline"
            disabled={nativeBusy || !client.canRestartUpdate}
            onClick={() => {
              void beginUpdate();
            }}
          >
            {t("restartUpdate")}
          </Button>
        ) : null}
        {plugins.items.map((row) => (
          <div className="gea-updates-plugin" key={row.packageName}>
            <h3>{row.packageName}</h3>
            <Tag tone={tone(row.state)}>{t(plugins.submitting ? "submitting" : row.state)}</Tag>
            {pluginUpdateBusy([row]) &&
            row.state !== "pending-restart" &&
            row.state !== "unknown" ? (
              <progress aria-label={row.packageName} />
            ) : null}
            <DetailSection name={row.packageName} showTitle={false} updates={updates} t={t} />
          </div>
        ))}
      </section>
    </div>
  );
}

export function mountPluginUpdatesClient(ctx: Context): () => Promise<void> {
  const fiber = ctx.inject(["slots", "locale", "modules", "settingsNavigation"], (scope) => {
    scope.effect(() => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
      return () => style.remove();
    });
    const desktop = createDesktopUpdates();
    const updates = createPluginDetailUpdates(scope, {
      restartUpdate: desktop.getSnapshot().canRestartUpdate ? desktop.restartUpdate : undefined,
    });
    const openUpdates = () => scope.settingsNavigation.open("company-updates");
    const shared = () => ({ updates, desktop, openUpdates });
    scope.effect(() => {
      const release = updates.retain();
      return () => {
        release();
        desktop.dispose();
      };
    });
    scope.effect(() => scope.locale.register(pluginUpdateLocale, { en, zh }));
    scope.effect(() => {
      void updates.resume();
      return () => updates.dispose();
    });
    scope.slots.inject("settings.update", () =>
      scope.slots.register(
        {
          name: "settings.update",
          priority: -10,
          locale: pluginUpdateLocale,
          inject: shared,
        },
        UpdateEntry,
      ),
    );
    scope.slots.inject("sidebar.toggle.badge", () =>
      scope.slots.register(
        {
          name: "sidebar.toggle.badge",
          priority: -10,
          locale: pluginUpdateLocale,
          inject: shared,
        },
        UpdateToggleBadge,
      ),
    );
    scope.slots.inject("settings.section", () =>
      scope.slots.register(
        {
          name: "settings.section",
          id: "company-updates",
          order: 80,
          label: () => scope.locale.bind(pluginUpdateLocale)("updates"),
          locale: pluginUpdateLocale,
          inject: shared,
        },
        UpdatesPanel,
      ),
    );
    scope.slots.inject("shell.overlay", () =>
      scope.slots.register(
        {
          name: "shell.overlay",
          id: "gea.plugin-updates.notice",
          locale: pluginUpdateLocale,
          inject: () => ({
            updates,
            openStatus: openUpdates,
          }),
        },
        UpdateNotice,
      ),
    );
    scope.slots.inject("plugins.list.badge", () =>
      scope.slots.register(
        {
          name: "plugins.list.badge",
          id: "gea.plugins.list.badge",
          locale: pluginUpdateLocale,
          inject: () => ({ updates, openUpdates }),
        },
        ListBadge,
      ),
    );
    scope.slots.inject("plugins.list.tools", () =>
      scope.slots.register(
        {
          name: "plugins.list.tools",
          id: "gea.plugins.list.tools",
          locale: pluginUpdateLocale,
          inject: () => ({ updates, openUpdates }),
        },
        ListTools,
      ),
    );
    scope.slots.inject("plugins.detail.actions", () =>
      scope.slots.register(
        {
          name: "plugins.detail.actions",
          id: "gea.plugin-updates.actions",
          locale: pluginUpdateLocale,
          inject: () => ({ updates, openUpdates }),
        },
        UpdateActions,
      ),
    );
    scope.slots.inject("plugins.detail.badge", () =>
      scope.slots.register(
        {
          name: "plugins.detail.badge",
          id: "gea.plugin-updates.badge",
          locale: pluginUpdateLocale,
          inject: () => ({ updates, openUpdates }),
        },
        UpdateBadge,
      ),
    );
    scope.slots.inject("plugins.detail.section", () =>
      scope.slots.register(
        {
          name: "plugins.detail.section",
          id: "gea.plugin-updates.section",
          locale: pluginUpdateLocale,
          inject: () => ({ updates, openUpdates }),
        },
        UpdateSection,
      ),
    );
  });
  return () => fiber.dispose();
}
