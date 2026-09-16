/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import { useEffect, useState } from 'react';
import type { GeaSalesPlanDetail } from '../../../bridge.ts';
import type { RegionalApprovalLiveRow } from '../regionalApprovalQueryModel.ts';
import type { SalesPlanDetailClient } from './useSalesPlanDetail.ts';

export const useSalesPlanAccess = (
  rows: readonly RegionalApprovalLiveRow[],
  client: SalesPlanDetailClient | undefined,
  enabled: boolean
) => {
  // 能力预取最多四路并发；任何详情读失败都保持只读，不能把“读不到”解释成“允许写”。
  const [entries, setEntries] = useState<Record<string, GeaSalesPlanDetail>>({});
  const [failedVersions, setFailedVersions] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setEntries({});
    setFailedVersions(new Set());
    if (!enabled || !client || rows.length === 0) return;
    const controller = new AbortController();
    let cursor = 0;
    const worker = async () => {
      while (cursor < rows.length && !controller.signal.aborted) {
        const row = rows[cursor++];
        try {
          // oxlint-disable-next-line no-await-in-loop -- 将详情读取并发限制为四个请求。
          const detail = await client.detail.invoke({ planId: row.planId, signal: controller.signal });
          if (!controller.signal.aborted) {
            setEntries((current) => ({ ...current, [row.versionId]: detail }));
          }
        } catch {
          if (!controller.signal.aborted) setFailedVersions((current) => new Set(current).add(row.versionId));
          // 能力读取缺失、被拒或失败时，该对象保持只读。
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    return () => controller.abort();
  }, [rows, client, enabled, revision]);
  return { entries, failedVersions, refresh: () => setRevision((value) => value + 1) };
};
