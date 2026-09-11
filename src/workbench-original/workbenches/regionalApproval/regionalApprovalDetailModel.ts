/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { regionalApprovalSkuFixtures, type ApprovalReasonRequirement } from './regionalApprovalDetailFixture.ts';
import type { ApprovalVersion, RegionalApprovalRow } from './regionalApprovalFixture.ts';

export type ApprovalSuggestionDisposition = 'pending' | 'accepted' | 'ignored';

export type ApprovalSkuAdjustment = {
  skuId: string;
  initialQuantity: number;
  initialAmount: number;
  aiQuantity: number;
  aiAmount: number;
  editedQuantity: number;
  editedAmount: number;
  reason: string;
  reasonRequirement: ApprovalReasonRequirement;
  suggestionDisposition: ApprovalSuggestionDisposition;
  suggestionPreviousQuantity?: number;
  suggestionPreviousAmount?: number;
};

export type ApprovalPlanAdjustment = {
  organizationId: string;
  version: ApprovalVersion;
  saved: Record<string, ApprovalSkuAdjustment>;
  working: Record<string, ApprovalSkuAdjustment>;
};

export type ApprovalDetailStore = { plans: Record<string, ApprovalPlanAdjustment> };

export const EMPTY_APPROVAL_DETAIL_STORE: ApprovalDetailStore = { plans: {} };

export const approvalPlanKey = (organizationId: string, version: ApprovalVersion) => `${organizationId}:${version}`;

const initialAdjustment = (fixture: ReturnType<typeof regionalApprovalSkuFixtures>[number]): ApprovalSkuAdjustment => ({
  skuId: fixture.id,
  initialQuantity: fixture.initialQuantity,
  initialAmount: fixture.initialQuantity * fixture.unitPrice,
  aiQuantity: fixture.aiQuantity,
  aiAmount: fixture.aiQuantity * fixture.unitPrice,
  editedQuantity: fixture.initialQuantity,
  editedAmount: fixture.initialQuantity * fixture.unitPrice,
  reason: '',
  reasonRequirement: fixture.reasonRequirement,
  suggestionDisposition: 'pending',
});

export const ensureApprovalPlan = (
  store: ApprovalDetailStore,
  row: RegionalApprovalRow,
  version: ApprovalVersion
): ApprovalDetailStore => {
  const key = approvalPlanKey(row.id, version);
  if (store.plans[key]) return store;
  const adjustments = Object.fromEntries(
    regionalApprovalSkuFixtures(row, version).map((fixture) => [fixture.id, initialAdjustment(fixture)])
  );
  return {
    plans: {
      ...store.plans,
      [key]: { organizationId: row.id, version, saved: adjustments, working: adjustments },
    },
  };
};

export type ApprovalDetailAction =
  | { type: 'edit'; skuId: string; quantity: number }
  | { type: 'edit-amount'; skuId: string; amount: number }
  | { type: 'edit-plan-quantity'; quantity: number }
  | { type: 'edit-plan-amount'; amount: number }
  | { type: 'reason'; skuId: string; reason: string }
  | { type: 'reason-all'; reason: string }
  | { type: 'accept-suggestion'; skuId: string }
  | { type: 'ignore-suggestion'; skuId: string }
  | { type: 'restore-suggestion'; skuId: string }
  | { type: 'accept-all-suggestions' }
  | { type: 'save' }
  | { type: 'discard' };

const updateWorking = (
  plan: ApprovalPlanAdjustment,
  skuId: string,
  update: (adjustment: ApprovalSkuAdjustment) => ApprovalSkuAdjustment
): ApprovalPlanAdjustment => {
  const current = plan.working[skuId];
  const next = update(current);
  if (next === current) return plan;
  return { ...plan, working: { ...plan.working, [skuId]: next } };
};

const updatePlanTotal = (
  plan: ApprovalPlanAdjustment,
  field: 'editedQuantity' | 'editedAmount',
  requestedTotal: number
): ApprovalPlanAdjustment => {
  const target = Math.max(0, Math.round(requestedTotal));
  const entries = Object.entries(plan.working);
  const currentTotal = entries.reduce((total, [, adjustment]) => total + adjustment[field], 0);
  if (target === currentTotal) return plan;
  let delta = target - currentTotal;
  const working = Object.fromEntries(
    entries.map(([skuId, adjustment]) => {
      if (delta === 0) return [skuId, adjustment];
      const change = delta > 0 ? delta : -Math.min(adjustment[field], -delta);
      delta -= change;
      return [
        skuId,
        {
          ...adjustment,
          [field]: adjustment[field] + change,
          suggestionDisposition: 'pending' as const,
          ...(field === 'editedQuantity' ? { suggestionPreviousQuantity: undefined } : {}),
          ...(field === 'editedAmount' ? { suggestionPreviousAmount: undefined } : {}),
        },
      ];
    })
  );
  return { ...plan, working };
};

export const reduceApprovalDetailStore = (
  store: ApprovalDetailStore,
  row: RegionalApprovalRow,
  version: ApprovalVersion,
  action: ApprovalDetailAction
): ApprovalDetailStore => {
  const ensured = ensureApprovalPlan(store, row, version);
  const key = approvalPlanKey(row.id, version);
  const plan = ensured.plans[key];
  let nextPlan = plan;
  if (action.type === 'save') nextPlan = { ...plan, saved: plan.working };
  if (action.type === 'discard') nextPlan = { ...plan, working: plan.saved };
  if (action.type === 'edit') {
    nextPlan = updateWorking(plan, action.skuId, (adjustment) => {
      const quantity = Math.max(0, Math.round(action.quantity));
      if (
        adjustment.editedQuantity === quantity &&
        adjustment.suggestionDisposition === 'pending' &&
        adjustment.suggestionPreviousQuantity === undefined
      ) {
        return adjustment;
      }
      return {
        ...adjustment,
        editedQuantity: quantity,
        suggestionDisposition: 'pending',
        suggestionPreviousQuantity: undefined,
      };
    });
  }
  if (action.type === 'edit-amount') {
    nextPlan = updateWorking(plan, action.skuId, (adjustment) => {
      const amount = Math.max(0, Math.round(action.amount));
      if (
        adjustment.editedAmount === amount &&
        adjustment.suggestionDisposition === 'pending' &&
        adjustment.suggestionPreviousAmount === undefined
      ) {
        return adjustment;
      }
      return {
        ...adjustment,
        editedAmount: amount,
        suggestionDisposition: 'pending',
        suggestionPreviousAmount: undefined,
      };
    });
  }
  if (action.type === 'edit-plan-quantity') nextPlan = updatePlanTotal(plan, 'editedQuantity', action.quantity);
  if (action.type === 'edit-plan-amount') nextPlan = updatePlanTotal(plan, 'editedAmount', action.amount);
  if (action.type === 'reason') {
    nextPlan = updateWorking(plan, action.skuId, (adjustment) =>
      adjustment.reason === action.reason ? adjustment : { ...adjustment, reason: action.reason }
    );
  }
  if (action.type === 'reason-all') {
    if (!Object.values(plan.working).every((adjustment) => adjustment.reason === action.reason)) {
      nextPlan = {
        ...plan,
        working: Object.fromEntries(
          Object.entries(plan.working).map(([skuId, adjustment]) => [skuId, { ...adjustment, reason: action.reason }])
        ),
      };
    }
  }
  if (action.type === 'accept-suggestion') {
    nextPlan = updateWorking(plan, action.skuId, (adjustment) => ({
      ...adjustment,
      editedQuantity: adjustment.aiQuantity,
      editedAmount: adjustment.aiAmount,
      suggestionDisposition: 'accepted',
      suggestionPreviousQuantity:
        adjustment.suggestionDisposition === 'accepted'
          ? adjustment.suggestionPreviousQuantity
          : adjustment.editedQuantity,
      suggestionPreviousAmount:
        adjustment.suggestionDisposition === 'accepted' ? adjustment.suggestionPreviousAmount : adjustment.editedAmount,
    }));
  }
  if (action.type === 'ignore-suggestion') {
    nextPlan = updateWorking(plan, action.skuId, (adjustment) => ({
      ...adjustment,
      editedQuantity:
        adjustment.suggestionDisposition === 'accepted' && adjustment.suggestionPreviousQuantity !== undefined
          ? adjustment.suggestionPreviousQuantity
          : adjustment.editedQuantity,
      editedAmount:
        adjustment.suggestionDisposition === 'accepted' && adjustment.suggestionPreviousAmount !== undefined
          ? adjustment.suggestionPreviousAmount
          : adjustment.editedAmount,
      suggestionDisposition: 'ignored',
      suggestionPreviousQuantity: undefined,
      suggestionPreviousAmount: undefined,
    }));
  }
  if (action.type === 'restore-suggestion') {
    nextPlan = updateWorking(plan, action.skuId, (adjustment) => ({
      ...adjustment,
      editedQuantity: adjustment.suggestionPreviousQuantity ?? adjustment.initialQuantity,
      editedAmount: adjustment.suggestionPreviousAmount ?? adjustment.initialAmount,
      suggestionDisposition: 'pending',
      suggestionPreviousQuantity: undefined,
      suggestionPreviousAmount: undefined,
    }));
  }
  if (action.type === 'accept-all-suggestions') {
    nextPlan = {
      ...plan,
      working: Object.fromEntries(
        Object.entries(plan.working).map(([skuId, adjustment]) => [
          skuId,
          {
            ...adjustment,
            editedQuantity: adjustment.aiQuantity,
            editedAmount: adjustment.aiAmount,
            suggestionDisposition: 'accepted' as const,
            suggestionPreviousQuantity:
              adjustment.suggestionDisposition === 'accepted'
                ? adjustment.suggestionPreviousQuantity
                : adjustment.editedQuantity,
            suggestionPreviousAmount:
              adjustment.suggestionDisposition === 'accepted'
                ? adjustment.suggestionPreviousAmount
                : adjustment.editedAmount,
          },
        ])
      ),
    };
  }
  if (nextPlan === plan) return ensured;
  return { plans: { ...ensured.plans, [key]: nextPlan } };
};

export const approvalPlan = (
  store: ApprovalDetailStore,
  row: RegionalApprovalRow,
  version: ApprovalVersion
): ApprovalPlanAdjustment => ensureApprovalPlan(store, row, version).plans[approvalPlanKey(row.id, version)];

export const isApprovalPlanDirty = (plan: ApprovalPlanAdjustment) =>
  JSON.stringify(plan.saved) !== JSON.stringify(plan.working);

export const approvalPlanValidationErrors = (plan: ApprovalPlanAdjustment): string[] =>
  Object.values(plan.working)
    .filter(
      (adjustment) =>
        (adjustment.editedQuantity !== adjustment.initialQuantity ||
          adjustment.editedAmount !== adjustment.initialAmount) &&
        adjustment.reasonRequirement === 'required' &&
        adjustment.reason.trim() === ''
    )
    .map((adjustment) => adjustment.skuId);

export type SavedApprovalAdjustment = {
  organizationId: string;
  version: ApprovalVersion;
  skuId: string;
  initialQuantity: number;
  editedQuantity: number;
  initialAmount: number;
  editedAmount: number;
  reason: string;
  suggestionDisposition: ApprovalSuggestionDisposition;
};

export const savedApprovalAdjustments = (store: ApprovalDetailStore): SavedApprovalAdjustment[] =>
  Object.values(store.plans).flatMap((plan) =>
    Object.values(plan.saved)
      .filter(
        (adjustment) =>
          adjustment.editedQuantity !== adjustment.initialQuantity ||
          adjustment.editedAmount !== adjustment.initialAmount ||
          adjustment.suggestionDisposition !== 'pending'
      )
      .map((adjustment) => ({
        organizationId: plan.organizationId,
        version: plan.version,
        skuId: adjustment.skuId,
        initialQuantity: adjustment.initialQuantity,
        editedQuantity: adjustment.editedQuantity,
        initialAmount: adjustment.initialAmount,
        editedAmount: adjustment.editedAmount,
        reason: adjustment.reason,
        suggestionDisposition: adjustment.suggestionDisposition,
      }))
  );
