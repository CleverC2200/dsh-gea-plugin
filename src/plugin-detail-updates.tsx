import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { PluginDetailProps } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type { PropsLocale, TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import { Button, Tag, type TagTone } from "@deepseek-ai/dsh-client-ui-primitives";
import { companyPackageNames } from "./shared/plugin-release.mjs";
import type { PluginUpdateProblem } from "./shared/plugin-update-diagnostics.ts";
import type { PluginUpdateRow } from "./shared/plugin-update-state.ts";
import { createPluginDetailUpdates, pluginUpdateBusy } from "./plugin-updates-client.ts";
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
function tone(state: PluginUpdateRow["state"]): TagTone {
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
    state.submitting === name ? "accepted" : state.checking ? "checking" : (row?.state ?? "idle");
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
  return name ? <DetailSection name={name} updates={updates} t={t} /> : null;
}
function DetailSection({
  name,
  updates,
  t,
}: { name: string; updates: Owner } & PropsLocale<typeof pluginUpdateLocale>): ReactNode {
  const state = useDetail(updates),
    row = state.items.find((row) => row.packageName === name);
  const error = state.transportError
    ? t(
        state.transportError === "check"
          ? "checkError"
          : state.transportError === "unknown"
            ? "unknownError"
            : "statusError",
      )
    : problemText(row?.problem, t);
  return (
    <section className="gea-plugin-update-section" aria-label={t("title")}>
      <h3 className="gea-plugin-update-title">{t("title")}</h3>
      <dl className="gea-plugin-update-versions">
        <dt>{t("installed")}</dt>
        <dd>{row?.installedVersion ?? t("unavailable")}</dd>
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
/** Contribute only through the official detail slots; the Host retains installation ownership. */
export function mountPluginUpdatesClient(ctx: Context): () => Promise<void> {
  const fiber = ctx.inject(["slots", "locale", "modules"], (scope) => {
    scope.effect(() => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.append(style);
      return () => style.remove();
    });
    const updates = createPluginDetailUpdates(scope);
    scope.effect(() => scope.locale.register(pluginUpdateLocale, { en, zh }));
    scope.effect(() => () => updates.dispose());
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
