import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { createDesktopUpdates, desktopRestartTarget } from "./desktop-updates-client.ts";
import type { PluginDetailProps } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { PropsLocale, PropsRuntime, TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, Tag, type TagTone } from "@deepseek-ai/dsh-client-ui-primitives";
import { updatablePackageNames } from "./shared/plugin-release.mjs";
import type { PluginUpdateProblem } from "./shared/plugin-update-diagnostics.ts";
import type { PluginUpdateRow } from "./shared/plugin-update-state.ts";
import {
  createPluginDetailUpdates,
  pluginUpdateBusy,
  pluginSuiteReady,
} from "./plugin-updates-client.ts";
import { en, zh, pluginUpdateLocale } from "./plugin-update-locales.ts";
import css from "./plugin-detail-updates.css";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface SlotMap {
    "gea.account.actions": {
      kind: "list";
      scope: "root";
      owner: { onSelect: () => void };
    };
  }
}

type Owner = ReturnType<typeof createPluginDetailUpdates>;
type Props = PluginDetailProps &
  PropsLocale<typeof pluginUpdateLocale> & {
    updates: Owner;
  };
function targetName(subject: PluginDetailProps["subject"]) {
  return subject.kind === "bundle"
    ? updatablePackageNames.find((name) => name === subject.pkg.name)
    : undefined;
}
function useDetail(updates: Owner) {
  useEffect(() => updates.retain(), [updates]);
  const snapshot = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  return {
    ...snapshot,
    confirmationUnconfirmed:
      snapshot.notice?.kind === "unconfirmed" &&
      snapshot.items.some((row) => row.state === "confirming"),
    items: snapshot.items.map((row) =>
      row.state === "confirming" && snapshot.notice?.kind === "unconfirmed"
        ? { ...row, state: "unknown" as const }
        : row,
    ),
  };
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
      {row?.state === "pending-restart" || row?.state === "confirming" ? (
        <p className="gea-plugin-update-notice" role="status">
          {t(row.state === "confirming" ? "confirming" : "restart")}
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
  t,
}: PropsRuntime<"plugins.list.tools"> &
  PropsLocale<typeof pluginUpdateLocale> & {
    updates: Owner;
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
    <span className="gea-plugin-list-summary" role="status">
      {state.checking ? t("checking") : state.transportError ? t("statusError") : ""}
    </span>
  );
}

type DesktopOwner = ReturnType<typeof createDesktopUpdates>;
type UpdateEntry = "closed" | "confirm" | "result";
const createUpdateEntry = () => createSnapshotStore<UpdateEntry>("closed");
const createDismissedUpdates = () =>
  createSnapshotStore<string[]>([], {
    persist: { name: "gea.dismissed-update-reminders.v1" },
  });
type UpdateProps = PropsLocale<typeof pluginUpdateLocale> & {
  updates: Owner;
  desktop: DesktopOwner;
};
type SharedProps = UpdateProps & {
  entry: ReturnType<typeof createUpdateEntry>;
  dismissed: ReturnType<typeof createDismissedUpdates>;
};
function updateView(
  plugins: ReturnType<Owner["getSnapshot"]>,
  client: ReturnType<DesktopOwner["getSnapshot"]>,
) {
  const state = client.presentation;
  const desktopTarget = desktopRestartTarget(state);
  const pending = plugins.items.some((row) => row.state === "pending-restart");
  const available = plugins.items.filter((row) => row.state === "available");
  const pluginAvailable =
    !plugins.transportError &&
    pluginSuiteReady(plugins.items) &&
    available.length > 0 &&
    available.every((row) => row.planId);
  const checking = plugins.checking || state?.phase === "checking";
  const busy =
    client.opening ||
    Boolean(state && ["downloading", "verifying", "installing"].includes(state.phase)) ||
    plugins.submitting !== null ||
    plugins.restart === "requested" ||
    plugins.restart === "restarting" ||
    plugins.items.some(
      (row) =>
        !["pending-restart", "unknown", "checking"].includes(row.state) && pluginUpdateBusy([row]),
    );
  const hasUpdate = Boolean(desktopTarget || pending || pluginAvailable);
  const canUpdate =
    !busy &&
    !checking &&
    (client.canRestartUpdate && pending
      ? plugins.restartReady === true
      : Boolean((desktopTarget && client.canOpen) || (pluginAvailable && client.canRestartUpdate)));
  return { desktopTarget, pending, pluginAvailable, checking, busy, hasUpdate, canUpdate };
}
function startAvailableUpdates(updates: Owner, desktop: DesktopOwner) {
  const client = desktop.getSnapshot();
  const { canUpdate, desktopTarget, pending, pluginAvailable } = updateView(
    updates.getSnapshot(),
    client,
  );
  if (!canUpdate) return;
  const restartRequest = desktopTarget
    ? { kind: "desktop" as const, version: desktopTarget }
    : undefined;
  if (client.canRestartUpdate && pluginAvailable && !pending) {
    void updates.updateAll(restartRequest);
  } else if (client.canRestartUpdate && pending) {
    void updates.restart(restartRequest);
  } else if (desktopTarget && client.canOpen) {
    void desktop.open(desktopTarget).catch(() => {});
  }
}
function UpdateButton({
  view,
  checking = false,
  onClick,
  t,
}: PropsLocale<typeof pluginUpdateLocale> & {
  view: ReturnType<typeof updateView>;
  checking?: boolean;
  onClick: () => void;
}): ReactNode {
  if (!view.hasUpdate && !view.busy) return null;
  const disabled = checking || !view.canUpdate;
  return (
    <Button
      size="sm"
      variant="primary"
      className="gea-update-start"
      title={t("takeoverNotice")}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {t(view.busy ? "updatingAll" : "updateAll")}
    </Button>
  );
}
function SettingsUpdate({
  wide = true,
  hidden = false,
  updates,
  desktop,
  t,
}: UpdateProps & Partial<PropsRuntime<"settings.update">>): ReactNode {
  const plugins = useDetail(updates);
  const client = useSyncExternalStore(desktop.subscribe, desktop.getSnapshot);
  if (!wide || (hidden && client.presentation?.phase !== "installing")) return null;
  const view = updateView(plugins, client);
  const failed = plugins.restart === "failed" || (client.failed && view.desktopTarget);
  const retry =
    client.canOpen &&
    !view.hasUpdate &&
    !view.busy &&
    (client.failed || client.presentation?.phase === "error");
  if (!view.hasUpdate && !view.busy && !retry && !failed) return null;
  return (
    <div className="gea-plugin-update-actions">
      <UpdateButton view={view} t={t} onClick={() => startAvailableUpdates(updates, desktop)} />
      {retry && (
        <Button size="sm" variant="outline" onClick={() => void desktop.open().catch(() => {})}>
          {t("desktopRetry")}
        </Button>
      )}
      {failed && <span role="alert">{t("restartError")}</span>}
    </div>
  );
}
function UpdateToggleBadge({ updates, desktop, t }: UpdateProps): ReactNode {
  const plugins = useDetail(updates);
  const client = useSyncExternalStore(desktop.subscribe, desktop.getSnapshot);
  const view = updateView(plugins, client);
  return view.hasUpdate || view.busy || client.failed || client.presentation?.phase === "error" ? (
    <span className="gea-update-dot" role="img" aria-label={t("updateReminder")} />
  ) : null;
}
function UpdateCard({
  wide,
  updates,
  desktop,
  entry,
  dismissed,
  t,
}: PropsRuntime<"sidebar.footer.action"> & SharedProps): ReactNode {
  const plugins = useDetail(updates);
  const client = useSyncExternalStore(desktop.subscribe, desktop.getSnapshot);
  const manual = useSyncExternalStore(entry.subscribe, entry.getSnapshot);
  const dismissedVersions = useSyncExternalStore(dismissed.subscribe, dismissed.getSnapshot);
  const [checkingNow, setCheckingNow] = useState(false);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (manual === "confirm") card.current?.focus();
  }, [manual]);
  const state = client.presentation;
  const view = updateView(plugins, client);
  const { desktopTarget, pending, pluginAvailable, busy } = view;
  const checking = checkingNow || view.checking;
  const versions = [
    ...(desktopTarget ? [`desktop:${desktopTarget}`] : []),
    ...plugins.items.flatMap((row) => {
      const version = row.candidateVersion ?? row.installedVersion;
      return version &&
        ((pluginAvailable && row.state === "available") ||
          row.state === "pending-restart" ||
          row.state === "confirming" ||
          (row.state === "unknown" && plugins.confirmationUnconfirmed))
        ? [`${row.packageName}:${version}`]
        : [];
    }),
  ];
  const newVersion = versions.some((version) => !dismissedVersions.includes(version));
  const dismiss = () => {
    dismissed.set([...new Set([...dismissedVersions, ...versions])].slice(-100));
    entry.set("closed");
  };
  const check = () => {
    entry.set("result");
    setCheckingNow(true);
    void Promise.allSettled([
      updates.check(),
      ...(client.canCheck ? [desktop.check()] : []),
    ]).finally(() => setCheckingNow(false));
  };
  const desktopStatus = desktopTarget
    ? t("newVersion", { version: desktopTarget })
    : client.failed || state?.phase === "error"
      ? t("desktopFailureCheck")
      : state?.phase === "checking"
        ? t("checking")
        : client.checked && state?.phase === "idle"
          ? t("desktopIdle")
          : t("idle");
  const pluginInProgress = plugins.items.find(
    (row) => row.state !== "pending-restart" && row.state !== "unknown" && pluginUpdateBusy([row]),
  );
  const pluginStatus = plugins.confirmationUnconfirmed
    ? t("unavailable")
    : pluginInProgress
      ? t(pluginInProgress.state)
      : pending
        ? t("pending-restart")
        : pluginAvailable
          ? t("available")
          : plugins.checking
            ? t("checking")
            : plugins.transportError || plugins.items.some((row) => row.state === "check-failed")
              ? t("checkError")
              : plugins.items.length > 0 &&
                  plugins.items.every((row) => ["current", "completed"].includes(row.state))
                ? t("current")
                : plugins.items.some((row) => row.state === "blocked")
                  ? t("blocked")
                  : t("unavailable");
  if (!wide || (manual === "closed" && !newVersion)) return null;
  return (
    <article
      ref={card}
      tabIndex={-1}
      className="gea-update-card gea-sidebar-reminder"
      aria-label={t("updateReminder")}
    >
      <button
        className="gea-sidebar-reminder-close"
        type="button"
        aria-label={t("dismissUpdate")}
        onClick={dismiss}
      >
        <span aria-hidden="true">×</span>
      </button>
      {manual === "confirm" ? (
        <>
          <span>{t("confirmCheck")}</span>
          <div className="gea-plugin-update-actions">
            <Button size="sm" variant="primary" onClick={check}>
              {t("confirmYes")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => entry.set("closed")}>
              {t("confirmNo")}
            </Button>
          </div>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || checking}
          onClick={() => entry.set("confirm")}
        >
          {t(manual !== "closed" && checking ? "checking" : "check")}
        </Button>
      )}
      {(manual === "result" || newVersion || busy) && (
        <div className="gea-update-card-results">
          {client.supported && (
            <section aria-label={t("desktopTitle")}>
              <strong>{t("desktopTitle")}</strong>
              <span role="status">
                {busy && state?.phase === "downloading" && state.percent !== undefined
                  ? t("desktopProgress", {
                      percent: String(Math.round(state.percent)),
                    })
                  : desktopStatus}
                {client.current && state?.phase === "idle" ? ` · ${client.current}` : ""}
              </span>
            </section>
          )}
          <section aria-label={t("pluginsTitle")}>
            <strong>{t("pluginsTitle")}</strong>
            <span role="status">{pluginStatus}</span>
          </section>
          <UpdateButton
            view={view}
            checking={checking}
            t={t}
            onClick={() => {
              entry.set("result");
              startAvailableUpdates(updates, desktop);
            }}
          />
        </div>
      )}
      {((desktopTarget && !client.canOpen) ||
        ((pluginAvailable || pending) && !client.canRestartUpdate)) && (
        <span>{t("takeoverUnsupported")}</span>
      )}
      {(plugins.restart === "failed" || (client.failed && desktopTarget)) && (
        <span role="alert">{t("restartError")}</span>
      )}
    </article>
  );
}

export function mountPluginUpdatesClient(ctx: Context): () => Promise<void> {
  const fiber = ctx.inject(["slots", "locale", "modules"], (scope) => {
    scope.effect(() => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
      return () => style.remove();
    });
    const desktop = createDesktopUpdates();
    const entry = createUpdateEntry();
    const dismissed = createDismissedUpdates();
    const updates = createPluginDetailUpdates(scope, {
      restartUpdate: desktop.getSnapshot().canRestartUpdate ? desktop.restartUpdate : undefined,
    });
    scope.effect(() => {
      const release = updates.retain();
      void updates.resume();
      return () => {
        release();
        updates.dispose();
        desktop.dispose();
      };
    });
    scope.effect(() => scope.locale.register(pluginUpdateLocale, { en, zh }));
    const updateProps = () => ({ updates, desktop });
    scope.slots.inject("settings.update", () =>
      scope.slots.register(
        {
          name: "settings.update",
          priority: -10,
          locale: pluginUpdateLocale,
          inject: updateProps,
        },
        SettingsUpdate,
      ),
    );
    scope.slots.inject("settings.general.item", () =>
      scope.slots.register(
        {
          name: "settings.general.item",
          id: "gea.update-action",
          order: 101,
          locale: pluginUpdateLocale,
          inject: updateProps,
        },
        SettingsUpdate,
      ),
    );
    scope.slots.inject("sidebar.toggle.badge", () =>
      scope.slots.register(
        {
          name: "sidebar.toggle.badge",
          priority: -10,
          locale: pluginUpdateLocale,
          inject: updateProps,
        },
        UpdateToggleBadge,
      ),
    );
    scope.slots.inject("gea.account.actions", () =>
      scope.slots.register(
        {
          name: "gea.account.actions",
          id: "gea.check-updates",
          locale: pluginUpdateLocale,
        },
        ({ onSelect, t }) => (
          <button
            type="button"
            role="menuitem"
            className="gea-logout-button"
            onClick={() => {
              entry.set("confirm");
              onSelect();
            }}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16V8m-4 4 4-4 4 4" />
            </svg>
            <span>{t("check")}</span>
          </button>
        ),
      ),
    );
    scope.slots.inject("sidebar.footer.action", () =>
      scope.slots.register(
        {
          name: "sidebar.footer.action",
          id: "gea.plugin-updates",
          locale: pluginUpdateLocale,
          inject: () => ({ updates, desktop, entry, dismissed }),
        },
        UpdateCard,
      ),
    );
    scope.slots.inject("plugins.list.badge", () =>
      scope.slots.register(
        {
          name: "plugins.list.badge",
          id: "gea.plugins.list.badge",
          locale: pluginUpdateLocale,
          inject: () => ({ updates }),
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
          inject: () => ({ updates }),
        },
        ListTools,
      ),
    );
    scope.slots.inject("plugins.detail.badge", () =>
      scope.slots.register(
        {
          name: "plugins.detail.badge",
          id: "gea.plugin-updates.badge",
          locale: pluginUpdateLocale,
          inject: () => ({ updates }),
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
          inject: () => ({ updates }),
        },
        UpdateSection,
      ),
    );
  });
  return () => fiber.dispose();
}
