import type { TFunction } from 'i18next';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Pagination, Select, Table } from '@arco-design/web-react';
import type {
  GeaSalesPlanListItem,
  GeaSalesPlanPeriod,
  GeaSalesPlanDetail,
  GeaSalesPlanActionRequest,
  GeaSalesPlanActionReceipt,
} from '../../contracts.ts';
import type { SalesPlanQueryClient } from './useRegionalApprovalQuery.ts';
import type { SalesPlanDetailClient } from './hooks/useSalesPlanDetail.ts';
import {
  SalesPlanActionAttempt,
  classifySalesPlanActionError,
  type SalesPlanActionClient,
} from './models/salesPlanActionModel.ts';
import {
  correctionAccess,
  correctionAdjustments,
  correctionDecision,
  correctionLine,
  correctionMetrics,
  correctionDecimal,
  verifyCorrectionAction,
} from './models/salesPlanCorrectionModel.ts';
import { salesPlanWorkflow } from '../../salesPlanWorkflow.ts';
import { formatExactDecimal, salesPlanStatusText } from './regionalApprovalQueryModel.ts';
import styles from './CorrectionWorkbench.module.css';

const roles = ['region', 'province', 'area', 'category'] as const;
const money = (v?: string) => (v == null ? '—' : `¥${formatExactDecimal(v)}`);
const percent = (v?: string) => (v == null ? '—' : `${v}%`);
const sum = (
  rows: GeaSalesPlanListItem[],
  field: 'targetAmount' | 'corrPlanAmount' | 'mPlanAmount' | 'mPlanQty' | 'corrPlanQty',
) => {
  try {
    return rows.reduce((total, row) => total.plus(correctionDecimal(row[field])), correctionDecimal('0')).toFixed(2);
  } catch {
    return undefined;
  }
};

/** Correction is a view in the existing workbench, using its authenticated clients. */
export function CorrectionWorkbench({
  t,
  queryClient,
  detailClient,
  actionClient,
  onResubmit,
}: {
  t: TFunction;
  queryClient?: SalesPlanQueryClient | null;
  detailClient?: SalesPlanDetailClient;
  actionClient?: SalesPlanActionClient;
  onResubmit?: (planId: string, versionId: string, period: GeaSalesPlanPeriod) => void;
}) {
  const tr = (key: string, values?: Record<string, unknown>) => t(`common.correction.${key}`, values);
  const [periods, setPeriods] = useState<GeaSalesPlanPeriod[]>([]);
  const [periodId, setPeriodId] = useState('');
  const [rows, setRows] = useState<GeaSalesPlanListItem[]>([]);
  const [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [revision, setRevision] = useState(0);
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<GeaSalesPlanListItem>();
  const [stage, setStage] = useState('current');
  const period = periods.find((p) => p.periodId === periodId);
  const refresh = () => {
    setSelected(undefined);
    setRevision((n) => n + 1);
  };
  useEffect(() => {
    const controller = new AbortController();
    if (!queryClient) {
      setError('业务接口未连接');
      return;
    }
    void queryClient.periods
      .invoke({ pageNo: 1, pageSize: 100, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPeriods(result.records);
        setPeriodId(result.records[0]?.periodId ?? '');
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('周期读取失败，请重新进入');
      });
    return () => controller.abort();
  }, [queryClient]);
  useEffect(() => {
    if (!periodId || !queryClient) return;
    const controller = new AbortController();
    setRows([]);
    setSelected(undefined);
    setLoading(true);
    setError('');
    void queryClient.list
      .invoke({
        periodId,
        planTypeCode: period?.planTypeCode,
        orderType: 'Z',
        pageNo: page,
        pageSize: 20,
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.records.some((r) => r.periodId !== periodId || (r.orderType !== 'Z' && r.hasCorrection !== false)))
          throw new Error('wrong correction scope');
        setRows(result.records);
        setTotal(result.total);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRows([]);
          setTotal(0);
          setError('纠偏读取失败或服务端尚未提供纠偏契约，请刷新');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [queryClient, periodId, period?.planTypeCode, page, revision]);
  const month = period?.periodMonth;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const timeProgress =
    month === currentMonth
      ? (now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()) * 100
      : undefined;
  return (
    <main className={styles.page}>
      <h2>{tr('title')}</h2>
      <div className={styles.toolbar}>
        <Select
          aria-label={tr('period')}
          value={periodId}
          onChange={(id) => {
            setSelected(undefined);
            setRows([]);
            setPeriodId(id);
            setPage(1);
          }}
          style={{ width: 220 }}
        >
          {periods.map((p) => (
            <Select.Option key={p.periodId} value={p.periodId}>
              {p.periodMonth} · {p.planTypeCode}
            </Select.Option>
          ))}
        </Select>
        <Select
          aria-label={tr('viewNode')}
          value={stage}
          onChange={(value) => {
            setSelected(undefined);
            setStage(value);
          }}
          style={{ width: 160 }}
        >
          <Select.Option value="current">{tr('currentNode')}</Select.Option>
          {roles.map((key) => (
            <Select.Option key={key} value={key}>
              {tr(key)}
            </Select.Option>
          ))}
        </Select>
        <Button disabled={loading} onClick={refresh}>
          {tr('refresh')}
        </Button>
      </div>
      <p>
        {tr('summary', {
          target: money(sum(rows, 'targetAmount')),
          qty: sum(rows, 'corrPlanQty') ?? '—',
          amount: money(sum(rows, 'corrPlanAmount')),
          count: total,
        })}
      </p>
      {error && <Alert type="error" content={error} />}
      <Table
        rowKey="planId"
        data={rows}
        loading={loading}
        pagination={false}
        scroll={{ x: 1000 }}
        columns={[
          { title: tr('customer'), render: (_, r) => r.dealerName ?? r.orgName ?? r.dealerCode },
          { title: tr('target'), render: (_, r) => money(r.targetAmount) },
          {
            title: tr('plan'),
            render: (_, r) => (
              <>
                {money(r.mPlanAmount)}
                <br />
                {r.mPlanQty ?? '—'} 件
              </>
            ),
          },
          {
            title: tr('progress'),
            render: (_, r) => {
              const m = correctionMetrics(r);
              return (
                <>
                  <div>{tr('amountProgress', { value: percent(m.amountProgress) })}</div>
                  <div>{tr('qtyProgress', { value: percent(m.qtyProgress) })}</div>
                  {m.amountProgress != null && (
                    <div
                      className={styles.progress}
                      role="img"
                      aria-label={`金额进度 ${m.amountProgress}%${timeProgress == null ? '' : `，时间进度 ${timeProgress.toFixed(2)}%`}`}
                    >
                      <span style={{ width: `${Math.max(0, Math.min(100, Number(m.amountProgress)))}%` }} />
                      {timeProgress != null && <i style={{ left: `${timeProgress}%` }} />}
                    </div>
                  )}
                  {timeProgress != null && m.amountProgress != null && Number(m.amountProgress) < timeProgress ? (
                    <small>{tr('behind')}</small>
                  ) : null}
                </>
              );
            },
          },
          {
            title: tr('correctedProgress'),
            render: (_, r) => {
              const m = correctionMetrics(r);
              return r.hasCorrection === false ? (
                '—'
              ) : (
                <>
                  <div>{percent(m.correctionProgress)}</div>
                  <small>{tr('net', { value: money(m.netAmount) })}</small>
                </>
              );
            },
          },
          {
            title: tr('status'),
            render: (_, r) =>
              r.monthlyApproved === false
                ? tr('notApproved')
                : r.hasCorrection === false
                  ? tr('absent')
                  : salesPlanStatusText(r.status, r.planTypeCode, t),
          },
          {
            title: tr('actions'),
            render: (_, r) => (
              <>
                <Button
                  disabled={loading || r.monthlyApproved !== true || !detailClient}
                  onClick={() => setSelected(r)}
                >
                  {tr('detail')}
                </Button>
                {r.status >= 6 && r.status <= 9 && onResubmit && (
                  <Button onClick={() => period && onResubmit(r.planId, r.versionId, period)}>{tr('resubmit')}</Button>
                )}
              </>
            ),
          },
        ]}
      />
      <Pagination
        current={page}
        pageSize={20}
        total={total}
        onChange={(value) => {
          setSelected(undefined);
          setRows([]);
          setPage(value);
        }}
      />
      {selected && detailClient && (
        <CorrectionDetail
          t={t}
          key={`${selected.versionId}:${stage}`}
          row={selected}
          stage={stage}
          client={detailClient}
          actionClient={actionClient}
          onClose={() => setSelected(undefined)}
          onSaved={refresh}
        />
      )}
    </main>
  );
}

function CorrectionDetail({
  t,
  row,
  stage,
  client,
  actionClient,
  onClose,
  onSaved,
}: {
  t: TFunction;
  row: GeaSalesPlanListItem;
  stage: string;
  client: SalesPlanDetailClient;
  actionClient?: SalesPlanActionClient;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tr = (key: string, values?: Record<string, unknown>) => t(`common.correction.${key}`, values);
  const [detail, setDetail] = useState<GeaSalesPlanDetail>();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [pending, setPending] = useState<{
    attempt: SalesPlanActionAttempt;
    request: GeaSalesPlanActionRequest;
    receipt?: GeaSalesPlanActionReceipt;
    retryable: boolean;
  }>();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void client.detail
      .invoke({ planId: row.planId, signal: controller.signal })
      .then((d) => {
        if (controller.signal.aborted) return;
        if (d.currentVersion.id !== row.versionId || !d.currentVersion.effective) throw new Error('版本已变化，请刷新');
        setDetail(d);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('读取失败或版本已变化，请关闭后刷新');
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [client, row.planId, row.versionId]);
  const actor = detail && salesPlanWorkflow(detail.currentVersion.planTypeCode).actor(detail.currentVersion.status);
  const access = detail && correctionAccess(detail);
  const writable = Boolean(access && actionClient && (stage === 'current' || stage === actor));
  const lines = useMemo(
    () =>
      detail?.skus.map((sku) => {
        try {
          const delta =
            edits[sku.skuCode] ??
            (detail.currentVersion.orderType === 'Z'
              ? correctionDecision(
                  sku,
                  stage === 'current'
                    ? detail.currentVersion.status === 5
                      ? 10
                      : detail.currentVersion.status
                    : (salesPlanWorkflow(detail.currentVersion.planTypeCode).pending(stage as (typeof roles)[number]) ??
                        -1),
                  detail.currentVersion.planTypeCode,
                )
              : '0');
          return { sku, line: correctionLine(sku, delta), input: delta, error: '' };
        } catch (e) {
          return { sku, input: edits[sku.skuCode] ?? '', error: e instanceof Error ? e.message : '数据错误' };
        }
      }) ?? [],
    [detail, edits],
  );
  const invalid = lines.some((x) => x.error);
  const total = invalid
    ? '—'
    : lines.reduce((n, x) => n.plus(correctionDecimal(x.line!.delta)), correctionDecimal('0')).toFixed();
  const run = async (kind: GeaSalesPlanActionRequest['action']) => {
    if (!detail || !actionClient || !writable || locked.current) return;
    if (!pending && ((kind !== 'REJECT' && invalid) || (kind === 'REJECT' && (!reason.trim() || reason.length > 1000))))
      return;
    locked.current = true;
    setBusy(true);
    setError('');
    let operation = pending;
    try {
      if (!operation) {
        const request: GeaSalesPlanActionRequest = {
          action: kind,
          expectedStatus: detail.currentVersion.status,
          expectedSnapshot: access!.snapshotHash,
          adjustmentMode: 'ABSOLUTE_NET',
          ...(kind === 'REJECT' ? { remark: reason.trim() } : { adjustments: correctionAdjustments(detail, edits) }),
        };
        operation = { attempt: new SalesPlanActionAttempt(actionClient), request, retryable: false };
        setPending(operation);
        operation.receipt = await operation.attempt.submit({
          planId: row.planId,
          versionId: row.versionId,
          planTypeCode: detail.currentVersion.planTypeCode,
          request,
        });
      } else if (!operation.receipt) operation.receipt = await operation.attempt.retry();
      if (!alive.current) return;
      setPending({ ...operation });
      const after = await client.detail.invoke({ planId: row.planId });
      if (!verifyCorrectionAction(detail, after, operation.request, operation.receipt))
        throw new Error('操作回执已返回，但字段或日志尚未核对通过；请回读核对');
      if (alive.current) onSaved();
    } catch (cause) {
      if (!alive.current) return;
      const failure = classifySalesPlanActionError(cause);
      if (operation) setPending({ ...operation, retryable: failure.retrySameIntent });
      setError(
        operation?.receipt
          ? '操作回执已返回，但字段或日志尚未核对通过；请回读核对'
          : `${failure.kind}：操作未确认完成，请核对权限或刷新；结果未知时仅原键重试`,
      );
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal
      visible
      title={tr('dialog')}
      style={{ width: 'min(1100px,96vw)' }}
      maskClosable={false}
      closable={!busy}
      onCancel={onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {tr('close')}
          </Button>
          {pending ? (
            <Button
              disabled={busy || (!pending.receipt && !pending.retryable)}
              onClick={() => void run(pending.request.action)}
            >
              {pending.receipt ? tr('readback') : tr('retry')}
            </Button>
          ) : (
            (['SAVE', 'APPROVE', 'REJECT'] as const).map((kind) => (
              <Button
                key={kind}
                type={kind === 'APPROVE' ? 'primary' : 'secondary'}
                disabled={
                  !writable ||
                  busy ||
                  !access?.allowedActions.includes(kind) ||
                  (kind === 'REJECT' ? !reason.trim() || reason.length > 1000 : invalid)
                }
                onClick={() => void run(kind)}
              >
                {{ SAVE: tr('save'), APPROVE: tr('approve'), REJECT: tr('reject') }[kind]}
              </Button>
            ))
          )}
        </>
      }
    >
      {error && <Alert type="error" content={error} />}
      {!detail ? (
        <p>{tr('loading')}</p>
      ) : (
        <>
          <p>
            {row.dealerName ?? row.orgName} · 版本 {row.versionId} ·{' '}
            {actor && actor !== 'customer'
              ? tr(actor)
              : salesPlanStatusText(detail.currentVersion.status, detail.currentVersion.planTypeCode, t)}{' '}
            · {writable ? tr('editable') : tr('readonly')}
          </p>
          {!access && <Alert type="info" content={tr('unavailable')} />}
          <p className={total.startsWith('-') ? styles.negative : styles.positive}>
            {tr('difference', { value: total })}
          </p>
          <div className={styles.scroll}>
            <table className={styles.detail}>
              <thead>
                <tr>
                  {['SKU', 'baseQty', 'newQty', 'baseAmount', 'newAmount', 'delta', 'deltaAmount', 'ai'].map((x) => (
                    <th key={x}>{x === 'SKU' ? x : tr(x)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map(({ sku, line, input, error: lineError }) => (
                  <tr key={sku.skuCode} className={line && !line.participates ? styles.inactive : undefined}>
                    <td>
                      {sku.skuCode}
                      <br />
                      {sku.productCategName}
                    </td>
                    <td>{sku.qty}</td>
                    <td>{line?.qty ?? '—'}</td>
                    <td>{money(sku.amt)}</td>
                    <td>{money(line?.amount)}</td>
                    <td>
                      <Input
                        aria-label={`${tr('delta')} ${sku.skuCode}`}
                        aria-invalid={Boolean(lineError)}
                        value={input}
                        disabled={!writable || busy || Boolean(pending)}
                        onChange={(value) => setEdits((current) => ({ ...current, [sku.skuCode]: value }))}
                      />
                      {lineError ? (
                        <small role="alert">{lineError}</small>
                      ) : line && !line.participates ? (
                        <small>{tr('zero')}</small>
                      ) : null}
                    </td>
                    <td className={line?.delta.startsWith('-') ? styles.negative : styles.positive}>
                      {money(line?.deltaAmount)}
                    </td>
                    <td>{tr('noAi')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Input
            aria-label={tr('reason')}
            placeholder={tr('reason')}
            value={reason}
            disabled={!writable || busy || Boolean(pending)}
            onChange={setReason}
          />
          {detail.dmsMock?.source === 'DMS_MOCK' && <p>DMS mock · {detail.dmsMock.syncStatus}</p>}
          {detail.dmsMock?.receipts.map((r) => (
            <p key={r.key}>模拟回执 {r.dmsId}</p>
          ))}
          <details>
            <summary>{tr('logs')}</summary>
            {detail.logs.map((l) => (
              <p key={l.id}>
                {l.actionCode} · {l.fromStatus} → {l.toStatus} · {l.remark ?? ''} · {l.actionAt}
              </p>
            ))}
          </details>
        </>
      )}
    </Modal>
  );
}
