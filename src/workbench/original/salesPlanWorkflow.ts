/** 本地只投影 V1.2 节点与状态转换；服务端仍是权限和写入的唯一权威。 */
export type SalesPlanRole = 'customer' | 'region' | 'province' | 'area' | 'category';
export type SalesPlanWorkflowRow = {
  typeCode: string;
  examineLevel: number;
  nodeNum: string;
};

/** 本地投影包含用户确认移除 JD 8 / TM 9；实时 SQL 验收另行进行。 */
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

// 节点含义由 V1.2 §4.0 定义；哪些节点参与由配置决定。
const NODE_ROLES: Readonly<Record<string, SalesPlanRole>> = {
  '0': 'customer',
  '1': 'region',
  '2': 'province',
  '3': 'area',
  '4': 'category',
};

let liveWorkflowRows: readonly SalesPlanWorkflowRow[] | undefined;

/** 文档内查询投影；每个打包后的工作台文档都有独立的模块实例。 */
export function replaceSalesPlanWorkflowRows(rows: readonly SalesPlanWorkflowRow[]): void {
  liveWorkflowRows = rows.map((row) => ({ ...row }));
}

export const salesPlanWorkflow = (
  typeCode: string,
  rows: readonly SalesPlanWorkflowRow[] = liveWorkflowRows ?? SALES_PLAN_WORKFLOW_ROWS
) => {
  // 先严格验证链条和角色单调性；配置不可信时所有动作和权限计算都保持不可用。
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
    if (status === 10) return undefined;
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
  /**
   * 工作台队列的只读展示范围。品类节点同时保留待审批、待 DMS 回写和已回写的计划，
   * 让用户能在同一处追踪审批闭环；不能用于判断可写权限。
   */
  const queueStatuses = (role: SalesPlanRole): number[] =>
    role === 'category' ? [...pendingStatuses(role), 5, 10] : pendingStatuses(role);
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
    queueStatuses,
    transition,
    visibility,
    confirmationRoles: (status: number): SalesPlanRole[] => {
      const role = status === 10 && rolesKnown ? 'category' : actor(status);
      return role && rolesKnown ? roles!.slice(0, roleIndex(role) + 1).toReversed() : [];
    },
    statusLabelCode: (status: number): number | undefined => {
      if (status === 0 || status === 5 || (status >= 6 && status <= 10)) return status;
      if (!rolesKnown) return undefined;
      // 状态名称按原始节点码固定，XN 的 2 同样叫“区域已审批”。
      return actor(status) ? status : undefined;
    },
    /** 原始 DMS 节点保持不透明；即使未提供角色名称也可安全使用。 */
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
