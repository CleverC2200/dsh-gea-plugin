/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import type { ApprovalStageId, ApprovalVersion } from './regionalApprovalFixture.ts';

export type RegionalApprovalActionKind = 'return' | 'submit';
export type RegionalApprovalReturnTarget = 'previous-stage' | 'submitting-organization' | '';
export type RegionalApprovalImpactScope = 'current-organization' | 'filtered-scope';

export type RegionalApprovalActionScope = {
  organizationId: string;
  version: ApprovalVersion;
  approvalStage: ApprovalStageId;
  savedAdjustmentCount: number;
};

export type RegionalApprovalActionCommand = {
  requestId: string;
  key: string;
  kind: RegionalApprovalActionKind;
  attempt: number;
  scope: RegionalApprovalActionScope;
  returnTarget?: Exclude<RegionalApprovalReturnTarget, ''>;
  reason?: string;
  impactScope?: RegionalApprovalImpactScope;
};

export type RegionalApprovalFixtureOutcome = {
  source: 'fixture';
  resultId: string;
  completedAt: string;
};

export type RegionalApprovalActionResult = RegionalApprovalFixtureOutcome & {
  key: string;
  kind: RegionalApprovalActionKind;
  scope: RegionalApprovalActionScope;
  returnTarget?: Exclude<RegionalApprovalReturnTarget, ''>;
  impactScope?: RegionalApprovalImpactScope;
};

export type RegionalApprovalActionOperation = {
  command: RegionalApprovalActionCommand;
  status: 'loading' | 'success' | 'failure' | 'cancelled';
  errorCode?: string;
  outcome?: RegionalApprovalFixtureOutcome;
};

export type RegionalApprovalActionStore = {
  returnDraft: {
    target: RegionalApprovalReturnTarget;
    reason: string;
    impactScope: RegionalApprovalImpactScope;
  };
  submitConfirmed: boolean;
  operation?: RegionalApprovalActionOperation;
  results: Record<string, RegionalApprovalActionResult>;
};

export const EMPTY_REGIONAL_APPROVAL_ACTION_STORE: RegionalApprovalActionStore = {
  returnDraft: { target: '', reason: '', impactScope: 'current-organization' },
  submitConfirmed: false,
  results: {},
};

export const regionalApprovalActionKey = (kind: RegionalApprovalActionKind, scope: RegionalApprovalActionScope) =>
  `${kind}:${scope.organizationId}:${scope.version}:${scope.approvalStage}`;

export const regionalApprovalReturnValidationErrors = (store: RegionalApprovalActionStore): string[] => {
  const errors: string[] = [];
  if (!store.returnDraft.target) errors.push('target');
  if (!store.returnDraft.reason.trim()) errors.push('reason');
  if (!store.returnDraft.impactScope) errors.push('impactScope');
  return errors;
};

export const regionalApprovalSubmitValidationErrors = (store: RegionalApprovalActionStore): string[] =>
  store.submitConfirmed ? [] : ['confirmation'];

export type RegionalApprovalActionStoreAction =
  | { type: 'return-target'; target: RegionalApprovalReturnTarget }
  | { type: 'return-reason'; reason: string }
  | { type: 'return-impact'; impactScope: RegionalApprovalImpactScope }
  | { type: 'submit-confirmed'; confirmed: boolean }
  | { type: 'start'; command: RegionalApprovalActionCommand }
  | { type: 'success'; requestId: string; outcome: RegionalApprovalFixtureOutcome }
  | { type: 'failure'; requestId: string; errorCode: string }
  | { type: 'cancel'; requestId: string }
  | { type: 'clear-operation' };

export const reduceRegionalApprovalActionStore = (
  store: RegionalApprovalActionStore,
  action: RegionalApprovalActionStoreAction
): RegionalApprovalActionStore => {
  if (action.type === 'return-target') {
    if (store.returnDraft.target === action.target) return store;
    return { ...store, returnDraft: { ...store.returnDraft, target: action.target } };
  }
  if (action.type === 'return-reason') {
    if (store.returnDraft.reason === action.reason) return store;
    return { ...store, returnDraft: { ...store.returnDraft, reason: action.reason } };
  }
  if (action.type === 'return-impact') {
    if (store.returnDraft.impactScope === action.impactScope) return store;
    return { ...store, returnDraft: { ...store.returnDraft, impactScope: action.impactScope } };
  }
  if (action.type === 'submit-confirmed') {
    return store.submitConfirmed === action.confirmed ? store : { ...store, submitConfirmed: action.confirmed };
  }
  if (action.type === 'clear-operation') return store.operation ? { ...store, operation: undefined } : store;
  if (action.type === 'start') {
    if (store.operation?.status === 'loading' || store.results[action.command.key]) return store;
    return { ...store, operation: { command: action.command, status: 'loading' } };
  }

  const operation = store.operation;
  if (!operation || operation.command.requestId !== action.requestId || operation.status !== 'loading') return store;
  if (action.type === 'cancel') return { ...store, operation: { ...operation, status: 'cancelled' } };
  if (action.type === 'failure') {
    return { ...store, operation: { ...operation, status: 'failure', errorCode: action.errorCode } };
  }
  if (action.type === 'success') {
    const result: RegionalApprovalActionResult = {
      ...action.outcome,
      key: operation.command.key,
      kind: operation.command.kind,
      scope: operation.command.scope,
      returnTarget: operation.command.returnTarget,
      impactScope: operation.command.impactScope,
    };
    return {
      ...store,
      operation: { ...operation, status: 'success', outcome: action.outcome },
      results: { ...store.results, [result.key]: result },
    };
  }
  return store;
};

export type RegionalApprovalActionExecutor = (
  command: RegionalApprovalActionCommand
) => Promise<RegionalApprovalFixtureOutcome>;

export const executeRegionalApprovalFixtureAction: RegionalApprovalActionExecutor = async (command) => {
  await new Promise((resolve) => setTimeout(resolve, 320));
  return {
    source: 'fixture',
    resultId: `fixture-${command.requestId}`,
    completedAt: new Date().toISOString(),
  };
};

export const regionalApprovalFixtureResults = (store: RegionalApprovalActionStore): RegionalApprovalActionResult[] =>
  Object.values(store.results);
