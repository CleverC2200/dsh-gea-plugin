/** Deterministic in-memory sales-plan workflow used only by explicit mock acceptance. */
import { salesPlanWorkflow } from './workbench-original/salesPlanWorkflow.ts';

export type MockSku = { skuCode: string; qty: string; amount: string; confirmed: Record<string, string | null> };
export type MockPlan = { planId: string; typeCode: string; status: number; versionId: string; seq: number; skus: MockSku[]; logs: Array<{ action: string; from: number; to: number; requestId: string }> };
export type MockReceipt = { planId: string; versionId: string; fromStatus: number; toStatus: number; replayed: boolean; requestId: string; traceId: string; auditId: string };

function clone(plan: MockPlan): MockPlan { return structuredClone(plan); }
function result(plan: MockPlan, fromStatus: number, toStatus: number, requestId: string, replayed = false): MockReceipt {
  return { planId: plan.planId, versionId: plan.versionId, fromStatus, toStatus, replayed, requestId, traceId: `mock-trace:${requestId}`, auditId: `mock-audit:${requestId}` };
}

/** In-memory adapter models server CAS, idempotency, version creation and DMS acknowledgement. */
export class MockSalesPlanAdapter {
  private readonly plans = new Map<string, MockPlan>();
  private readonly idempotency = new Map<string, { hash: string; receipt: MockReceipt }>();
  private readonly pendingDms = new Set<string>();
  add(plan: MockPlan): void { this.plans.set(plan.versionId, clone(plan)); }
  read(versionId: string): MockPlan { const plan = this.plans.get(versionId); if (!plan) throw new Error('MOCK_VERSION_NOT_FOUND'); return clone(plan); }
  action(versionId: string, request: { action: 'SAVE' | 'APPROVE' | 'REJECT'; expectedStatus: number; requestId: string; idempotencyKey: string; remark?: string; adjustments?: Array<{ skuCode: string; adjustQty: string }> }): MockReceipt {
    const prior = this.idempotency.get(request.idempotencyKey); const hash = JSON.stringify({ versionId, ...request, idempotencyKey: undefined });
    if (prior) { if (prior.hash !== hash) throw new Error('MOCK_IDEMPOTENCY_CONFLICT'); return { ...prior.receipt, replayed: true }; }
    const plan = this.plans.get(versionId); if (!plan) throw new Error('MOCK_VERSION_NOT_FOUND');
    if (plan.status !== request.expectedStatus) throw new Error('MOCK_STALE_VERSION');
    const flow = salesPlanWorkflow(plan.typeCode, this.rows(plan));
    if (request.action === 'SAVE') {
      if (plan.status !== 10) throw new Error('MOCK_SAVE_REQUIRES_STATUS_10');
      for (const adjustment of request.adjustments ?? []) {
        const sku = plan.skus.find((item) => item.skuCode === adjustment.skuCode); if (!sku) throw new Error('MOCK_SKU_NOT_FOUND');
        sku.qty = String(Number(sku.qty) + Number(adjustment.adjustQty));
      }
      const receipt = result(plan, 10, 10, request.requestId); plan.logs.push({ action: 'SAVE', from: 10, to: 10, requestId: request.requestId }); this.store(request, hash, receipt); return receipt;
    }
    const to = request.action === 'APPROVE' ? flow.transition(plan.status, 'APPROVE') : flow.transition(plan.status, 'REJECT');
    if (to === undefined || (request.action === 'REJECT' && !request.remark?.trim())) throw new Error('MOCK_INVALID_TRANSITION');
    const from = plan.status; plan.status = to; plan.logs.push({ action: request.action, from, to, requestId: request.requestId });
    if (to === 5) this.pendingDms.add(plan.versionId);
    const receipt = result(plan, from, to, request.requestId); this.store(request, hash, receipt); return receipt;
  }
  acknowledgeDms(versionId: string, success: boolean): MockReceipt {
    const plan = this.plans.get(versionId); if (!plan || plan.status !== 5 || !this.pendingDms.has(versionId)) throw new Error('MOCK_DMS_NOT_PENDING');
    if (!success) throw new Error('MOCK_DMS_FAILED');
    this.pendingDms.delete(versionId); plan.status = 10; plan.logs.push({ action: 'DMS_SYNC', from: 5, to: 10, requestId: `mock-dms:${versionId}` }); return result(plan, 5, 10, `mock-dms:${versionId}`);
  }
  private store(request: { idempotencyKey: string }, hash: string, receipt: MockReceipt) { this.idempotency.set(request.idempotencyKey, { hash, receipt }); }
  private rows(plan: MockPlan) {
    const chains: Record<string, string[]> = { Y: ['0', '1', '2', '3', '4', 'Y'], XN: ['0', '2', '3', '4', 'Y'], DC: ['0', '2', '3', '4', 'Y'], FC: ['0', '4', 'Y'], JD: ['0', '4', 'Y'], TM: ['0', '4', 'Y'] };
    return (chains[plan.typeCode] ?? chains.Y).map((nodeNum, examineLevel) => ({ typeCode: plan.typeCode, examineLevel, nodeNum }));
  }
}
