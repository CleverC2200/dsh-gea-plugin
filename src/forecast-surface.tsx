/**
 * GEA forecast assistant surface.
 *
 * This module owns the business-surface composition only.  The host remains
 * responsible for login, querying and durable dsh Sessions.  The conversation
 * rail deliberately exposes a slot for the future native ChatSurface instead
 * of pretending that this plugin owns dsh's chat implementation.
 */
import type { ReactNode } from "react";
import { Decimal } from "decimal.js";
import type { Collection, Row } from "./business.ts";
import type { CopyKey } from "./locales.ts";

type Translate = (key: CopyKey) => string;

export type OrganizationView =
  | "all"
  | "base"
  | "region"
  | "province"
  | "area"
  | "dealer";

export type AssistantAnalysisMode = "receipt" | "model";

/** Availability of the host-owned conversation rail slot. */
export type ConversationRailAvailability =
  | "native-host-pending"
  | "native-host-mounted";

/** Business routes owned by the forecast assistant surface. */
export type ForecastSurfaceRoute = "forecast" | "messages";

export interface ForecastSurfaceNavigationState {
  route: ForecastSurfaceRoute;
  activeAgent: "demand-forecast";
}

export interface ConversationRailState {
  surface: "forecast";
  availability: ConversationRailAvailability;
  analysisMode: AssistantAnalysisMode;
  canSend: boolean;
}

export interface ForecastAssistantSurfaceProps {
  route?: ForecastSurfaceRoute;
  rows: Row[];
  selectedRow: Row | null;
  selectedVersionId: string | undefined;
  analysisMode: AssistantAnalysisMode;
  view: OrganizationView;
  onViewChange: (view: OrganizationView) => void;
  organizationOptions: string[];
  organizationValue: string;
  onOrganizationValueChange: (value: string) => void;
  canSend: boolean;
  onSend: () => void;
  t: Translate;
  /** Native dsh ChatSurface supplied by the host when the extension exists. */
  nativeConversation?: ReactNode;
}

export const organizationLabels: Record<OrganizationView, CopyKey> = {
  all: "allOrganizations",
  base: "byBase",
  region: "byRegion",
  province: "byProvince",
  area: "byArea",
  dealer: "byDealer",
};

const approvalStageKeys: CopyKey[] = [
  "stageCustomerAi",
  "stageAreaApproval",
  "stageProvinceApproval",
  "stageRegionApproval",
  "stageCategoryPlan",
];

/** Add exact decimal fields without converting them through a JS number. */
export function sumDecimal(rows: Row[], key: string): string | undefined {
  const values = rows
    .map((row) => row[key])
    .filter(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    )
    .map(String);
  if (
    values.length !== rows.length ||
    !values.length ||
    values.some((value) => !/^-?\d+(\.\d+)?$/.test(value))
  )
    return undefined;
  const scale = Math.max(
    ...values.map((value) => value.split(".")[1]?.length ?? 0),
  );
  const total = values.reduce((sum, value) => sum.plus(value), new Decimal(0));
  return total.toFixed(scale);
}

export function organizationValueFor(
  row: Row,
  view: OrganizationView,
): string | undefined {
  if (view === "all") return undefined;
  const value = {
    base: row.baseName,
    region: row.regionName ?? row.salesGroupName,
    province: row.provinceName ?? row.provinceRegionName ?? row.provinceCode,
    area: row.areaName,
    dealer: row.dealerName ?? row.dealerCode,
  }[view];
  return value == null ? undefined : String(value);
}

export function organizationValuesFor(
  rows: Row[],
  view: OrganizationView,
): string[] {
  return Array.from(
    new Set(
      rows
        .map((row) => organizationValueFor(row, view) ?? "")
        .filter(Boolean),
    ),
  );
}

/** Left-side GEA business navigation. */
export function BusinessNavigation({ t }: { t: Translate }) {
  return (
    <aside className="gea-business-nav" aria-label={t("businessNavigation")}>
      <strong>{t("geaBusiness")}</strong>
      <span>{t("businessFunctions")}</span>
      <BusinessMessageInbox t={t} />
      <div className="gea-plan-nav-group">
        <button type="button" className="gea-plan-nav-heading" disabled>
          {t("planManagement")} <span aria-hidden="true">⌃</span>
        </button>
        <button type="button" className="is-active" aria-current="page">
          {t("demandForecastAgent")}
        </button>
      </div>
    </aside>
  );
}

/**
 * Message-inbox entry point reserved for the forecast surface route.
 *
 * The host has not exposed the business inbox data contract yet, so this item
 * stays disabled instead of presenting a route that cannot load its data.
 */
export function BusinessMessageInbox({ t }: { t: Translate }) {
  return (
    <button type="button" disabled data-surface-route="messages">
      {t("messageInbox")}
    </button>
  );
}

/** Placeholder work area for the future business-message route. */
export function MessageInboxSurface({ t }: { t: Translate }) {
  return (
    <section
      className="gea-section gea-approval"
      aria-label={t("messageInbox")}
      data-surface-route="messages"
    >
      <h2>{t("messageInbox")}</h2>
      <p className="gea-meta">{t("agentReadOnly")}</p>
    </section>
  );
}

interface SalesPlanWorkbenchProps {
  rows: Row[];
  selectedRow: Row | null;
  selectedVersionId: string | undefined;
  view: OrganizationView;
  onViewChange: (view: OrganizationView) => void;
  organizationOptions: string[];
  organizationValue: string;
  onOrganizationValueChange: (value: string) => void;
  t: Translate;
}

/** Center business workbench.  It remains read-only until GEA write APIs exist. */
export function SalesPlanWorkbench({
  rows,
  selectedRow,
  selectedVersionId,
  view,
  onViewChange,
  organizationOptions,
  organizationValue,
  onOrganizationValueChange,
  t,
}: SalesPlanWorkbenchProps) {
  const first = selectedRow ?? rows[0];
  const targetQty = sumDecimal(rows, "targetQty");
  const targetAmount = sumDecimal(rows, "targetAmount");
  const currentQty = sumDecimal(rows, "currentQty");
  const currentAmount = sumDecimal(rows, "currentAmount");
  const dimensionValue = first ? organizationValueFor(first, view) : undefined;
  return (
    <section
      className="gea-section gea-approval"
      aria-label={t("approvalWorkspace")}
    >
      <div className="gea-toolbar gea-approval-heading">
        <div>
          <p className="gea-eyebrow">{t("approvalEyebrow")}</p>
          <h2>{t("approvalTitle")}</h2>
          <p className="gea-meta">{t("readOnlyPreview")}</p>
        </div>
        <div className="gea-version-controls">
          <span>
            {t("versionLabel")} {selectedVersionId ?? t("unknown")}
          </span>
          <button type="button" disabled>
            {t("latestVersion")}
          </button>
          <span>{t("period")}</span>
          <button type="button" disabled>
            {first?.periodId ?? t("unknown")}
          </button>
        </div>
      </div>
      <div className="gea-summary-grid">
        <div>
          <span className="gea-summary-label">{t("approvalQueue")}</span>
          <strong>
            {rows.length} {t("planCount")}
          </strong>
        </div>
        <div>
          <span className="gea-summary-label">{t("targetSummary")}</span>
          <strong>
            {targetQty ?? t("unknown")} / {targetAmount ?? t("unknown")}
          </strong>
        </div>
        <div>
          <span className="gea-summary-label">{t("currentSummary")}</span>
          <strong>
            {currentQty ?? t("unknown")} / {currentAmount ?? t("unknown")}
          </strong>
        </div>
        <div>
          <span className="gea-summary-label">{t("progress")}</span>
          <strong>
            {first?.status == null
              ? t("unknown")
              : `${t("status")}=${rows.length === 1 ? first.status : t("mixed")}`}
          </strong>
        </div>
      </div>
      <div className="gea-approval-stages" aria-label={t("approvalStages")}>
        {approvalStageKeys.map((key) => (
          <div className="gea-stage" key={key}>
            <span className="gea-stage-dot">?</span>
            <span>{t(key)}</span>
            <small>{t("unknown")}</small>
          </div>
        ))}
      </div>
      <div
        className="gea-org-toolbar"
        role="group"
        aria-label={t("organizationView")}
      >
        <strong>{t("organizationView")}</strong>
        {(Object.keys(organizationLabels) as OrganizationView[]).map((item) => (
          <button
            key={item}
            type="button"
            className={item === view ? "is-active" : ""}
            aria-pressed={item === view}
            onClick={() => onViewChange(item)}
          >
            {t(organizationLabels[item])}
          </button>
        ))}
        {dimensionValue != null && (
          <span className="gea-meta">{String(dimensionValue)}</span>
        )}
        {view !== "all" && (
          <select
            aria-label={t("organizationValue")}
            value={organizationValue}
            onChange={(event) => onOrganizationValueChange(event.target.value)}
          >
            {organizationOptions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="gea-readonly-banner">{t("readOnlyBanner")}</div>
    </section>
  );
}

interface ForecastConversationRailProps {
  selectedRow: Row | null;
  analysisMode: AssistantAnalysisMode;
  canSend: boolean;
  onSend: () => void;
  nativeConversation?: ReactNode;
  t: Translate;
}

/**
 * Right rail seam.  The fallback is status-only UI; the host can mount the
 * native dsh ChatSurface through `nativeConversation` without changing the
 * business workbench or inventing a second chat implementation here.
 */
export function ForecastConversationRail({
  selectedRow,
  analysisMode,
  canSend,
  onSend,
  nativeConversation,
  t,
}: ForecastConversationRailProps) {
  return (
    <aside
      className="gea-agent-panel"
      aria-label={t("agentPanel")}
      data-rail="forecast"
      data-rail-availability={
        nativeConversation ? "native-host-mounted" : "native-host-pending"
      }
    >
      {nativeConversation ?? (
        <>
          <div className="gea-agent-heading">
            <h3>{t("agentPanel")}</h3>
            <span className="gea-status-chip">
              {analysisMode === "model" ? t("agentPanelModel") : t("receiptMode")}
            </span>
          </div>
          <div className="gea-agent-context">
            <span>
              {selectedRow?.periodId ?? t("unknown")} · {selectedRow?.orgName ?? selectedRow?.dealerName ?? t("unknown")}
            </span>
            <strong>
              {selectedRow
                ? `${t("select")} ${selectedRow.planId ?? t("unknown")}`
                : t("noQuery")}
            </strong>
          </div>
          <div className="gea-agent-card">
            <strong>{t("agentAnalysisTitle")}</strong>
            <p>
              {selectedRow ? t("agentPanelHelp") : t("agentAnalysisEmpty")}
            </p>
            <span className="gea-meta">
              {selectedRow ? t("agentReady") : t("agentWaiting")}
            </span>
          </div>
          <button
            type="button"
            className="gea-primary"
            disabled={!canSend}
            onClick={onSend}
          >
            {t("sendToSession")}
          </button>
          <p className="gea-meta">{t("agentReadOnly")}</p>
        </>
      )}
    </aside>
  );
}

/** Compose the three business slots while keeping data ownership in the host. */
export function ForecastAssistantSurface(props: ForecastAssistantSurfaceProps) {
  return (
    <div className="gea-approval-frame">
      <BusinessNavigation t={props.t} />
      {props.route === "messages" ? (
        <MessageInboxSurface t={props.t} />
      ) : (
        <SalesPlanWorkbench
          rows={props.rows}
          selectedRow={props.selectedRow}
          selectedVersionId={props.selectedVersionId}
          view={props.view}
          onViewChange={props.onViewChange}
          organizationOptions={props.organizationOptions}
          organizationValue={props.organizationValue}
          onOrganizationValueChange={props.onOrganizationValueChange}
          t={props.t}
        />
      )}
      <ForecastConversationRail
        selectedRow={props.selectedRow}
        analysisMode={props.analysisMode}
        canSend={props.canSend}
        onSend={props.onSend}
        nativeConversation={props.nativeConversation}
        t={props.t}
      />
    </div>
  );
}
