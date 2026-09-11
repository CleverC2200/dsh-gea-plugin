/** V1.2 workflow projection. The server remains the authority for permissions and writes. */
export type SalesPlanRole = 'customer' | 'region' | 'province' | 'area' | 'category';
export type SalesPlanWorkflowRow = {
  typeCode: string;
  examineLevel: number;
  nodeNum: string;
};

/** Read-only snapshot of active plan_workflow_config rows. No database credentials or transport. */
export const SALES_PLAN_WORKFLOW_ROWS: readonly SalesPlanWorkflowRow[] = Object.entries({
  Y: ['0', '1', '2', '3', '4', 'Y'],
  DC: ['0', '2', '3', '4', 'Y'],
  FC: ['0', '4', 'Y'],
  JD: ['0', '8', '4', 'Y'],
  TM: ['0', '9', '4', 'Y'],
  XN: ['0', '2', '3', '4', 'Y'],
}).flatMap(([typeCode, nodes]) => nodes.map((nodeNum, examineLevel) => ({ typeCode, examineLevel, nodeNum })));

export const SALES_PLAN_ROLES: readonly SalesPlanRole[] = ['customer', 'region', 'province', 'area', 'category'];
export const SALES_PLAN_RETURN_CODES: Partial<Record<SalesPlanRole, number>> = {
  customer: 6,
  region: 7,
  province: 8,
  area: 9,
};

// Role bindings come from the V1.2 business specification, not from node_num arithmetic.
// The table's examine_node is null; other chains cannot grant role-based actions until bound.
const ROLE_BINDINGS: Record<string, readonly SalesPlanRole[]> = {
  Y: ['customer', 'region', 'province', 'area', 'category'],
  XN: ['customer', 'province', 'area', 'category'],
};

export const classifySalesPlanCustomer = (customer: {
  cooperationWayCode?: string | null;
  customerClassifyCode?: string | null;
  customerGroupCode?: string | null;
}): string => {
  let type: string;
  switch (customer.cooperationWayCode) {
    case '5':
      type = 'DC';
      break;
    case '6':
      type = 'FC';
      break;
    case '9':
      type = 'XN';
      break;
    case '3':
      type =
        customer.customerClassifyCode === 'kajxs'
          ? 'Y'
          : customer.customerGroupCode === 'H5'
            ? 'JD'
            : customer.customerGroupCode === 'J4'
              ? 'TM'
              : 'Y';
      break;
    default:
      type = 'Y';
  }
  return type || 'Y';
};

export const salesPlanWorkflow = (
  typeCode: string,
  rows: readonly SalesPlanWorkflowRow[] = SALES_PLAN_WORKFLOW_ROWS
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
        row.examineLevel === index &&
        Boolean(row.nodeNum) &&
        (row.nodeNum !== 'Y' || index === chain.length - 1)
    ) &&
    new Set(chain.map((row) => row.nodeNum)).size === chain.length;
  const roles = valid ? ROLE_BINDINGS[typeCode] : undefined;
  // Do not apply a frozen role binding to a changed node-code chain.
  const rolesKnown = Boolean(
    roles &&
    chain.length === roles.length + 1 &&
    chain.every(
      (row, index) =>
        row.nodeNum === SALES_PLAN_WORKFLOW_ROWS.filter((item) => item.typeCode === typeCode)[index]?.nodeNum
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
