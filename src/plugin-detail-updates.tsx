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
type SharedProps = PropsLocale<typeof pluginUpdateLocale> & {
  updates: Owner;
  desktop: DesktopOwner;
  entry: ReturnType<typeof createUpdateEntry>;
  dismissed: ReturnType<typeof createDismissedUpdates>;
};
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
  const [failed, setFailed] = useState(false);
  const [checkingNow, setCheckingNow] = useState(false);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (manual === "confirm") card.current?.focus();
  }, [manual]);
  const state = client.presentation;
  const desktopTarget = desktopRestartTarget(state);
  const pending = plugins.items.some((row) => row.state === "pending-restart");
  const pluginAvailable =
    pluginSuiteReady(plugins.items) &&
    plugins.items.some((row) => row.state === "available" && row.planId);
  const checking = checkingNow || plugins.checking || state?.phase === "checking";
  const desktopBusy =
    client.opening ||
    Boolean(state && ["downloading", "verifying", "installing"].includes(state.phase));
  const busy =
    desktopBusy ||
    plugins.submitting !== null ||
    plugins.restart === "requested" ||
    plugins.restart === "restarting" ||
    plugins.items.some((row) => row.state !== "pending-restart" && pluginUpdateBusy([row]));
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
  const launch = async (update: () => Promise<unknown>) => {
    entry.set("result");
    setFailed(false);
    try {
      await update();
    } catch {
      setFailed(true);
    }
  };
  const check = () => {
    entry.set("result");
    setCheckingNow(true);
    setFailed(false);
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
              {desktopTarget && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={desktopBusy || state?.phase === "checking" || !client.canOpen}
                  onClick={() => void launch(() => desktop.open(desktopTarget))}
                >
                  {t("restartUpdate")}
                </Button>
              )}
            </section>
          )}
          <section aria-label={t("pluginsTitle")}>
            <strong>{t("pluginsTitle")}</strong>
            <span role="status">{pluginStatus}</span>
            {(pluginAvailable || pending) && (
              <Button
                size="sm"
                variant="primary"
                disabled={
                  busy || checking || !client.canRestartUpdate || (pending && !plugins.restartReady)
                }
                onClick={() =>
                  void launch(() => (pending ? updates.restart() : updates.updateAll()))
                }
              >
                {t("restartUpdate")}
              </Button>
            )}
          </section>
        </div>
      )}
      {((desktopTarget && !client.canOpen) ||
        ((pluginAvailable || pending) && !client.canRestartUpdate)) && (
        <span>{t("takeoverUnsupported")}</span>
      )}
      {(failed || plugins.restart === "failed") && <span role="alert">{t("restartError")}</span>}
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
