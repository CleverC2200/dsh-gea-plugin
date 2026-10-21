import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { PluginDetailProps } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { PropsLocale, PropsRuntime, TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, Tag, Toast, type TagTone } from "@deepseek-ai/dsh-client-ui-primitives";
import { companyPackageNames } from "./shared/plugin-release.mjs";
import type { PluginUpdateProblem } from "./shared/plugin-update-diagnostics.ts";
import type { PluginUpdateRow } from "./shared/plugin-update-state.ts";
import {
  createPluginDetailUpdates,
  pluginUpdateBusy,
  pluginUpdateObservationMs,
} from "./plugin-updates-client.ts";
import { en, zh, pluginUpdateLocale } from "./plugin-update-locales.ts";
import css from "./plugin-detail-updates.css";

type Owner = ReturnType<typeof createPluginDetailUpdates>;
type Props = PluginDetailProps & PropsLocale<typeof pluginUpdateLocale> & { updates: Owner };
function targetName(subject: PluginDetailProps["subject"]) {
  return subject.kind === "bundle"
    ? companyPackageNames.find((name) => name === subject.pkg.name)
    : undefined;
}
function useDetail(updates: Owner) {
  useEffect(() => updates.retain(), [updates]);
  return useSyncExternalStore(updates.subscribe, updates.getSnapshot);
}
function UpdateActions({ subject, updates, t }: Props): ReactNode {
  const name = targetName(subject);
  return name ? <DetailActions name={name} updates={updates} t={t} /> : null;
}
function DetailActions({
  name,
  updates,
  t,
}: { name: string; updates: Owner } & PropsLocale<typeof pluginUpdateLocale>): ReactNode {
  const state = useDetail(updates),
    row = state.items.find((row) => row.packageName === name);
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
      {row?.state === "available" && row.planId && row.candidateVersion ? (
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => {
            void updates.update(name);
          }}
        >
          {t("update", { version: row.candidateVersion })}
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
    state.submitting === name && (!row || row.state === "available")
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
  updates,
  t,
}: { name: string; installedVersion?: string; updates: Owner } & PropsLocale<
  typeof pluginUpdateLocale
>): ReactNode {
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
      <h3 className="gea-plugin-update-title">{t("title")}</h3>
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
function ListActions({ subject, updates, t }: Props): ReactNode {
  const name = targetName(subject);
  const state = useDetail(updates);
  const row = state.items.find((item) => item.packageName === name);
  if (!name || row?.state !== "available" || !row.planId) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className="gea-plugin-list-update"
      disabled={state.checking || state.submitting !== null || pluginUpdateBusy(state.items)}
      onClick={() => {
        void updates.update(name);
      }}
    >
      {t("updateShort")}
    </Button>
  );
}
function ListTools({
  packages,
  registerRefresh,
  updates,
  t,
}: PropsRuntime<"plugins.list.tools"> &
  PropsLocale<typeof pluginUpdateLocale> & { updates: Owner }): ReactNode {
  const state = useDetail(updates);
  useEffect(() => registerRefresh(() => updates.check()), [registerRefresh, updates]);
  const installed = new Set(packages.map((pkg) => pkg.name));
  const available = state.items.filter(
    (row) => installed.has(row.packageName) && row.state === "available" && row.planId,
  );
  const pending = state.items.some(
    (row) => installed.has(row.packageName) && row.state === "pending-restart",
  );
  const busy = state.checking || state.submitting !== null || pluginUpdateBusy(state.items);
  const bridge = desktopRestart();
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const restartBusy =
    state.checking ||
    state.submitting !== null ||
    state.items.some((row) => row.state !== "pending-restart" && pluginUpdateBusy([row]));
  return (
    <div className="gea-plugin-list-tools">
      <span className="gea-plugin-list-summary" role="status">
        {state.transportError
          ? t(
              state.transportError === "check"
                ? "checkError"
                : state.transportError === "unknown"
                  ? "unknownError"
                  : "statusError",
            )
          : state.checking
            ? t("checking")
            : available.length
              ? t("availableCount", { count: String(available.length) })
              : ""}
      </span>
      {available.length ? (
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => {
            void updates.updateAll(available.map((row) => row.packageName));
          }}
        >
          {t("updateAll")}
        </Button>
      ) : null}
      {restartFailed ? <span role="alert">{t("restartError")}</span> : null}
      {pending && bridge ? (
        <Button
          size="sm"
          variant="outline"
          disabled={restartBusy || restarting}
          onClick={() => {
            setRestarting(true);
            setRestartFailed(false);
            void bridge()
              .catch(() => setRestartFailed(true))
              .finally(() => setRestarting(false));
          }}
        >
          {t("restartNow")}
        </Button>
      ) : null}
    </div>
  );
}
function desktopRestart(): (() => Promise<unknown>) | undefined {
  if (
    !("dshDesktop" in window) ||
    typeof window.dshDesktop !== "object" ||
    window.dshDesktop === null
  )
    return;
  const bridge = window.dshDesktop;
  if (!("restart" in bridge) || typeof bridge.restart !== "function") return;
  const restart = bridge.restart.bind(bridge);
  return async () => restart();
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
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const notice = state.notice;
  const bridge = desktopRestart();
  const restartBusy =
    state.checking ||
    state.submitting !== null ||
    state.items.some((row) => row.state !== "pending-restart" && pluginUpdateBusy([row]));
  if (!notice) return null;
  const packageName = notice.packageName;
  const actions = packageName
    ? [{ label: t("viewStatus"), onClick: () => openStatus(packageName) }]
    : [];
  if (notice.kind === "pending-restart" && bridge && !restartBusy && !restarting) {
    actions.unshift({
      label: t("restartNow"),
      onClick: () => {
        setRestarting(true);
        setRestartFailed(false);
        void bridge()
          .catch(() => setRestartFailed(true))
          .finally(() => setRestarting(false));
      },
    });
  }
  const text =
    notice.kind === "progress"
      ? t("progressNotice")
      : notice.kind === "pending-restart"
        ? t(bridge ? "pendingNotice" : "pendingWebNotice")
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
      text={restartFailed ? t("restartError") : text}
      actions={actions}
      holdMs={notice.kind === "progress" ? pluginUpdateObservationMs : 15000}
      onDone={updates.dismissNotice}
    />
  );
}

export function mountPluginUpdatesClient(ctx: Context): () => Promise<void> {
  const fiber = ctx.inject(["slots", "locale", "modules", "pluginNavigation"], (scope) => {
    scope.effect(() => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
      return () => style.remove();
    });
    const updates = createPluginDetailUpdates(scope);
    scope.effect(() => scope.locale.register(pluginUpdateLocale, { en, zh }));
    scope.effect(() => {
      void updates.resume();
      return () => updates.dispose();
    });
    scope.slots.inject("shell.overlay", () =>
      scope.slots.register(
        {
          name: "shell.overlay",
          id: "gea.plugin-updates.notice",
          locale: pluginUpdateLocale,
          inject: () => ({
            updates,
            openStatus: (packageName: string) => scope.pluginNavigation.openBundle(packageName),
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
          inject: () => ({ updates }),
        },
        ListBadge,
      ),
    );
    scope.slots.inject("plugins.list.actions", () =>
      scope.slots.register(
        {
          name: "plugins.list.actions",
          id: "gea.plugins.list.actions",
          locale: pluginUpdateLocale,
          inject: () => ({ updates }),
        },
        ListActions,
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
    scope.slots.inject("plugins.detail.actions", () =>
      scope.slots.register(
        {
          name: "plugins.detail.actions",
          id: "gea.plugin-updates.actions",
          locale: pluginUpdateLocale,
          inject: () => ({ updates }),
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
