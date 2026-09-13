import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Input,
  Modal,
  Spin,
} from "@arco-design/web-react";
import type { TFunction } from "i18next";
import type {
  GeaSalesPlanPeriod,
  GeaSalesPlanSku,
  GeaSalesPlanSubmitReceipt,
} from "../../contracts.ts";
import {
  prepareSalesPlanResubmit,
  salesPlanResubmitReadbackMatches,
  SalesPlanSubmitAttempt,
  classifySalesPlanSubmitError,
  type SalesPlanResubmitSource,
  type SalesPlanSubmitClient,
} from "./models/salesPlanSubmitModel.ts";

/** Edits a freshly read returned version; only a connected Host may submit it. */
export function RegionalApprovalResubmitDialog({
  planId,
  versionId,
  period,
  client,
  connected,
  t,
  onClose,
  onSucceeded,
}: {
  planId: string;
  versionId: string;
  period: GeaSalesPlanPeriod;
  client: SalesPlanSubmitClient;
  connected: boolean;
  t: TFunction;
  onClose: () => void;
  onSucceeded: () => void;
}) {
  const tr = (key: string, values?: Record<string, unknown>) =>
    t(`common.assistantSurface.regionalApproval.liveSubmit.${key}`, values);
  const [source, setSource] = useState<SalesPlanResubmitSource>();
  const [skus, setSkus] = useState<GeaSalesPlanSku[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<SalesPlanSubmitAttempt>();
  const [retryable, setRetryable] = useState(false);
  const [receipt, setReceipt] = useState<GeaSalesPlanSubmitReceipt>();
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      client.detail.invoke({ planId, signal: controller.signal }),
      client.currentUser.invoke(),
    ])
      .then(async ([detail, currentUser]) => {
        if (
          detail.currentVersion.id !== versionId ||
          !detail.currentVersion.effective
        )
          throw new Error("sourceMismatch");
        const rows = await client.versionSkus.invoke({
          versionId,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSource({
          planId,
          versionId,
          period,
          detail,
          currentUser,
          skus: rows,
        });
        setSkus(rows);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("sourceMismatch");
      });
    return () => controller.abort();
  }, [planId, versionId, period, client]);
  const input = useMemo(() => {
    if (!source) return undefined;
    try {
      return prepareSalesPlanResubmit({ ...source, skus });
    } catch {
      return undefined;
    }
  }, [source, skus]);
  const readBack = async (value: GeaSalesPlanSubmitReceipt) => {
    const detail = await client.detail.invoke({ planId });
    if (!salesPlanResubmitReadbackMatches(versionId, value, detail))
      throw new Error("readback");
    setVerified(true);
    onSucceeded();
  };
  const submit = async () => {
    if (!connected || !input || !confirmed || busy || verified) return;
    setBusy(true);
    setError("");
    setRetryable(false);
    try {
      if (receipt) {
        await readBack(receipt);
        return;
      }
      let value;
      if (attempt) value = await attempt.retry();
      else {
        const fresh = await client.detail.invoke({ planId });
        if (
          fresh.currentVersion.id !== versionId ||
          fresh.currentVersion.status !==
            source?.detail.currentVersion.status ||
          !fresh.currentVersion.effective
        ) {
          setError("conflict");
          return;
        }
        const next = new SalesPlanSubmitAttempt(client);
        setAttempt(next);
        value = await next.submit(input);
      }
      setReceipt(value);
      await readBack(value);
    } catch (cause) {
      const failure = classifySalesPlanSubmitError(cause);
      setError(failure.kind);
      setRetryable(failure.retrySameIntent);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      visible
      title={tr("title")}
      onCancel={onClose}
      closable={!busy}
      maskClosable={false}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {tr("close")}
          </Button>
          <Button
            type="primary"
            loading={busy}
            disabled={
              !connected ||
              !input ||
              !confirmed ||
              verified ||
              Boolean(attempt && !retryable && !receipt)
            }
            onClick={() => void submit()}
          >
            {tr(receipt ? "refresh" : attempt ? "retry" : "confirm")}
          </Button>
        </>
      }
    >
      {!connected && (
        <Alert type="warning" content={tr("disabled.serviceBoundary")} />
      )}
      {!source && !error ? <Spin /> : null}
      {source && (
        <>
          <p>
            {tr("version")}: {versionId} · {tr("period")}: {period.periodMonth}
          </p>
          <p>
            {tr("submitter", {
              code: source.currentUser.id,
              name: source.currentUser.username,
            })}
          </p>
          <div style={{ maxHeight: 360, overflow: "auto" }}>
            {skus.map((sku, index) => (
              <label
                key={sku.skuCode}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 8,
                }}
              >
                <span>
                  {sku.skuCode} · {sku.productCategName}
                </span>
                <Input
                  aria-label={`${tr("quantity")} ${sku.skuCode}`}
                  value={sku.qty}
                  disabled={busy || Boolean(attempt)}
                  onChange={(qty) => {
                    setConfirmed(false);
                    setSkus((rows) =>
                      rows.map((row, i) =>
                        i === index ? { ...row, qty } : row,
                      ),
                    );
                  }}
                />
              </label>
            ))}
          </div>
          {input ? (
            <p>
              {tr("sourceSummary", {
                count: input.sourceSummary.skuCount,
                quantity: input.sourceSummary.submittedQty,
                amount: input.sourceSummary.submittedAmount,
              })}{" "}
              · {tr("nextStatus")}: {input.expected.nextStatus}
            </p>
          ) : (
            <Alert type="error" content={tr("errors.validation")} />
          )}
          <Checkbox
            checked={confirmed}
            disabled={busy || Boolean(attempt)}
            onChange={setConfirmed}
          >
            {tr("confirmation")}
          </Checkbox>
        </>
      )}
      {error && (
        <Alert
          type="error"
          content={receipt ? tr("refreshFailed") : tr(`errors.${error}`)}
        />
      )}
      {verified && receipt && (
        <Alert
          type="success"
          content={tr("success", {
            ...receipt,
            replayed: tr(receipt.replayed ? "replayed" : "created"),
          })}
        />
      )}
    </Modal>
  );
}
