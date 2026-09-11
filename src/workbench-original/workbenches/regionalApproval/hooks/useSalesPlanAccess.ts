/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { useEffect, useState } from 'react';
import type { GeaSalesPlanDetail } from '../../../bridge.ts';
import type { RegionalApprovalLiveRow } from '../regionalApprovalQueryModel.ts';
import type { SalesPlanDetailClient } from './useSalesPlanDetail.ts';

export const useSalesPlanAccess = (
  rows: readonly RegionalApprovalLiveRow[],
  client: SalesPlanDetailClient | undefined,
  enabled: boolean
) => {
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
          // oxlint-disable-next-line no-await-in-loop -- cap detail reads at four concurrent requests.
          const detail = await client.detail.invoke({ planId: row.planId, signal: controller.signal });
          if (!controller.signal.aborted) {
            setEntries((current) => ({ ...current, [row.versionId]: detail }));
          }
        } catch {
          if (!controller.signal.aborted) setFailedVersions((current) => new Set(current).add(row.versionId));
          // Missing, denied or failed capability reads leave this object read-only.
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    return () => controller.abort();
  }, [rows, client, enabled, revision]);
  return { entries, failedVersions, refresh: () => setRevision((value) => value + 1) };
};
