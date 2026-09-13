/** V1.2 workflow projection. The server remains the authority for permissions and writes. */
export type SalesPlanRole = 'customer' | 'region' | 'province' | 'area' | 'category';
export type SalesPlanWorkflowRow = {
  typeCode: string;
  examineLevel: number;
  nodeNum: string;
};

/** Local projection, including the user-confirmed removal of JD 8 / TM 9. Live SQL acceptance is separate. */
export const SALES_PLAN_WORKFLOW_ROWS: readonly SalesPlanWorkflowRow[] = Object.entries({
  Y: ['0', '1', '2', '3', '4', 'Y'],
  DC: ['0', '2', '3', '4', 'Y'],
  FC: ['0', '4', 'Y'],
  JD: ['0', '4', 'Y'],
  TM: ['0', '4', 'Y'],
  XN: ['0', '2', '3', '4', 'Y'],
}).flatMap(([typeCode, nodes]) => nodes.map((nodeNum, examineLevel) => ({ typeCode, examineLevel, nodeNum })));

export const SALES_PLAN_ROLES: readonly SalesPlanRole[] = ['customer', 'region', 'province', 'area', 'category'];
export const SALES_PLAN_RETURN_CODES: Partial<Record<SalesPlanRole, number>> = {
  customer: 6,
  region: 7,
  province: 8,
  area: 9,
};

// Node meanings are defined by V1.2 §4.0; configuration determines which nodes participate.
const NODE_ROLES: Readonly<Record<string, SalesPlanRole>> = {
  '0': 'customer',
  '1': 'region',
  '2': 'province',
  '3': 'area',
  '4': 'category',
};

let liveWorkflowRows: readonly SalesPlanWorkflowRow[] | undefined;

/** Document-local query projection; each bundled workbench document has its own module instance. */
export function replaceSalesPlanWorkflowRows(rows: readonly SalesPlanWorkflowRow[]): void {
  liveWorkflowRows = rows.map((row) => ({ ...row }));
}

export const salesPlanWorkflow = (
  typeCode: string,
  rows: readonly SalesPlanWorkflowRow[] = liveWorkflowRows ?? SALES_PLAN_WORKFLOW_ROWS
) => {
  const chain = rows.filter((row) => row.typeCode === typeCode).toSorted((a, b) => a.examineLevel - b.examineLevel);
  const valid =
    chain.length >= 2 &&
    chain[0].examineLevel === 0 &&
    chain[0].nodeNum === '0' &&
    chain.at(-1)?.nodeNum === 'Y' &&
    chain.every(
      (row, index) =>
        Number.isSafeInteger(row.examineLevel) &&
        row.examineLevel >= 0 &&
        (index === 0 || row.examineLevel > chain[index - 1].examineLevel) &&
        Boolean(row.nodeNum) &&
        (row.nodeNum !== 'Y' || index === chain.length - 1)
    ) &&
    new Set(chain.map((row) => row.nodeNum)).size === chain.length;
  const roles = chain.slice(0, -1).map((row) => NODE_ROLES[row.nodeNum]);
  const rolesKnown = Boolean(
    valid &&
    roles.every(Boolean) &&
    roles.at(-1) === 'category' &&
    roles.every(
      (role, index) => index === 0 || SALES_PLAN_ROLES.indexOf(role) > SALES_PLAN_ROLES.indexOf(roles[index - 1])
    )
  );
  const roleIndex = (role: SalesPlanRole) => (rolesKnown ? roles!.indexOf(role) : -1);
  const pending = (role: SalesPlanRole): number | undefined => {
    const index = roleIndex(role);
    return index < 0 ? undefined : Number(chain[index].nodeNum);
  };
  const actor = (status: number): SalesPlanRole | undefined => {
    if (!rolesKnown || !Number.isInteger(status) || status === 5 || status === 10) return undefined;
    if (status >= 6 && status <= 9) {
      return roles!.find((role, index) => Number(chain[index].nodeNum) + 6 === status);
    }
    return roles?.[chain.findIndex((row) => Number(row.nodeNum) === status && row.nodeNum !== 'Y')];
  };
  const nextStatus = (index: number): number | undefined => {
    const next = chain[index + 1];
    return next ? (next.nodeNum === 'Y' ? 5 : Number(next.nodeNum)) : undefined;
  };
  const transition = (status: number, action: 'SAVE' | 'APPROVE' | 'REJECT'): number | undefined => {
    if (!valid) return undefined;
    // Retain the separately authorized same-version effective-plan SAVE contract.
    if (status === 10) return action === 'SAVE' && rolesKnown ? 10 : undefined;
    const role = actor(status);
    if (!role || role === 'customer') return undefined;
    const index = roleIndex(role);
    if (action === 'SAVE') return status;
    if (action === 'REJECT') {
      const previous = chain[index - 1]?.nodeNum;
      return previous && /^\d+$/.test(previous) ? Number(previous) + 6 : undefined;
    }
    return nextStatus(index);
  };
  const pendingStatuses = (role: SalesPlanRole): number[] => {
    const status = pending(role);
    if (status === undefined) return [];
    const returned = role === 'category' ? undefined : status + 6;
    return returned === undefined ? [status] : [status, returned];
  };
  const visibility = (status: number, role: SalesPlanRole): 'writable' | 'read-only' | 'denied' => {
    if (!rolesKnown || pending(role) === undefined) return 'denied';
    if (pendingStatuses(role).includes(status)) return 'writable';
    if (status === 5 || status === 10) return 'read-only';
    const index = roleIndex(role);
    if (status >= 6) {
      return index > 0 && Number(chain[index - 1].nodeNum) + 6 === status ? 'read-only' : 'denied';
    }
    const active = actor(status);
    return active && roleIndex(active) > index ? 'read-only' : 'denied';
  };
  return {
    valid,
    rolesKnown,
    chain,
    actor,
    pending,
    pendingStatuses,
    transition,
    visibility,
    confirmationRoles: (status: number): SalesPlanRole[] => {
      const role = status === 10 && rolesKnown ? 'category' : actor(status);
      return role && rolesKnown ? roles!.slice(0, roleIndex(role) + 1).toReversed() : [];
    },
    statusLabelCode: (status: number): number | undefined => {
      if (status === 0 || status === 5 || (status >= 6 && status <= 10)) return status;
      if (!rolesKnown) return undefined;
      const active = actor(status);
      const previous = active ? roles?.[roleIndex(active) - 1] : undefined;
      return actor(status) && previous ? SALES_PLAN_ROLES.indexOf(previous) + 1 : undefined;
    },
    /** Raw DMS nodes are opaque. This is safe even when role names have not been supplied. */
    nextNode: (nodeNum: string) => {
      const index = chain.findIndex((row) => row.nodeNum === nodeNum);
      return valid && index >= 0 ? chain[index + 1]?.nodeNum : undefined;
    },
    resubmit: (status: number) => {
      const role = actor(status);
      return status >= 6 && status <= 9 && role ? nextStatus(roleIndex(role)) : undefined;
    },
  };
};
