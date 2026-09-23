/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import type { TFunction } from 'i18next';
import { SALES_PLAN_ROLES, salesPlanWorkflow } from '../../salesPlanWorkflow.ts';
import type {
  GeaSalesPlanListItem,
  GeaSalesPlanPageQuery,
  GeaSalesPlanPeriod,
  GeaSalesPlanSku,
} from '../../bridge.ts';
import type { ApprovalDimension, ApprovalStageId } from './regionalApprovalFixture.ts';

// Y 链的待处理状态投影；其他链通过 salesPlanWorkflow 解析。
export const SALES_PLAN_STATUS_BY_STAGE: Record<ApprovalStageId, number> = {
  customer: 0,
  region: 1,
  province: 2,
  area: 3,
  category: 4,
};
export const approvalStageForSalesPlanStatus = (status: number, typeCode = 'Y'): ApprovalStageId | undefined =>
  salesPlanWorkflow(typeCode).actor(status);
export const VISIBLE_SALES_PLAN_STATUSES_BY_STAGE = Object.fromEntries(
  SALES_PLAN_ROLES.map((role) => [role, salesPlanWorkflow('Y').pendingStatuses(role)])
) as Record<ApprovalStageId, number[]>;
export const SALES_PLAN_PROGRESS_STATUSES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
/** 状态可见性会与服务端管理的组织/版本范围取交集，绝不代表授权。 */
export const salesPlanVisibleStatuses = (typeCode: string, roles: readonly ApprovalStageId[]): number[] => {
  const workflow = salesPlanWorkflow(typeCode);
  return SALES_PLAN_PROGRESS_STATUSES.filter((status) =>
    roles.some((role) => workflow.visibility(status, role) !== 'denied')
  );
};

/** 一个节点的分子/分母：界面上悬停百分比时直接展示这两个数，不必再靠人肉对照口径。 */
export type SalesPlanStageTally = {
  /** 分子：该范围内"已经过这个节点"的计划单数。 */
  completed: number;
  /** 分母：该范围内全部状态的计划单数；月度把 Y/DC/FC… 各条流程分别统计后相加。 */
  total: number;
};

const emptySalesPlanStageTally = (): SalesPlanStageTally => ({ completed: 0, total: 0 });

/** 分母为 0 记 0%；没全完成时封顶 99%，避免四舍五入被读成"已经全审完"。 */
export const salesPlanStagePercent = ({ completed, total }: SalesPlanStageTally): number =>
  total > 0
    ? Math.max(0, Math.min(completed >= total ? 100 : 99, Math.round((completed / total) * 100)))
    : 0;

/** 单条工作流的分子/分母；哪些状态算哪个节点已完成见 tests/approval-visibility 的口径矩阵。 */
export const salesPlanStageTalliesForWorkflow = (period: {
  total: number;
  statusTotals: Readonly<Partial<Record<number, number>>>;
  planTypeCode: string;
}): Record<ApprovalStageId, SalesPlanStageTally> => {
  const workflow = salesPlanWorkflow(period.planTypeCode);
  return Object.fromEntries(
    SALES_PLAN_ROLES.map((role) => {
      const pending = workflow.pending(role);
      const tally = emptySalesPlanStageTally();
      if (!Number.isSafeInteger(period.total) || period.total <= 0 || pending === undefined) return [role, tally];
      tally.total = period.total;
      tally.completed = SALES_PLAN_PROGRESS_STATUSES.reduce<number>((sum, status) => {
        // 退回目标保留其确认结果；发起退回的节点必须再次审批。
        // 状态 5（审批完成·待回写）代表全部审批节点都已经签过字，品类也不例外——
        // 之前把品类排除在外，导致"品类已审批（待回写）"一条都不计入品类进度，永远是 0%。
        const active = workflow.actor(status);
        const activePending = active && workflow.pending(active);
        const done =
          status === 10 ||
          status === 5 ||
          (activePending !== undefined && activePending > pending);
        return sum + (done ? Math.max(0, period.statusTotals[status] ?? 0) : 0);
      }, 0);
      return [role, tally];
    })
  ) as Record<ApprovalStageId, SalesPlanStageTally>;
};

const salesPlanStagePercents = (
  tallies: Record<ApprovalStageId, SalesPlanStageTally>
): Record<ApprovalStageId, number> =>
  Object.fromEntries(
    SALES_PLAN_ROLES.map((role) => [role, salesPlanStagePercent(tallies[role])])
  ) as Record<ApprovalStageId, number>;

export const approvalStageProgressForSalesPlanStatusTotals = (
  total: number,
  statusTotals: Readonly<Partial<Record<number, number>>>,
  typeCode = 'Y'
): Record<ApprovalStageId, number> =>
  salesPlanStagePercents(salesPlanStageTalliesForWorkflow({ total, statusTotals, planTypeCode: typeCode }));

/** 月度分子/分母：先把该月每条工作流分别算出来，再按节点相加。 */
export const salesPlanStageTallies = (
  periods: readonly {
    total: number;
    statusTotals: Readonly<Partial<Record<number, number>>>;
    planTypeCode: string;
  }[]
): Record<ApprovalStageId, SalesPlanStageTally> =>
  Object.fromEntries(
    SALES_PLAN_ROLES.map((role) => {
      const sum = emptySalesPlanStageTally();
      for (const period of periods) {
        const tally = salesPlanStageTalliesForWorkflow(period)[role];
        sum.completed += tally.completed;
        sum.total += tally.total;
      }
      return [role, sum];
    })
  ) as Record<ApprovalStageId, SalesPlanStageTally>;

export const approvalStageProgressForSalesPlanPeriods = (
  periods: readonly {
    total: number;
    statusTotals: Readonly<Partial<Record<number, number>>>;
    planTypeCode: string;
  }[]
): Record<ApprovalStageId, number> => salesPlanStagePercents(salesPlanStageTallies(periods));

export type RegionalApprovalQueryScope = Pick<
  GeaSalesPlanPageQuery,
  'dealerCode' | 'areaCode' | 'provinceCode' | 'orgCode' | 'baseName' | 'status'
>;

export type RegionalApprovalLiveRow = GeaSalesPlanListItem & {
  source: 'gea';
  approvalState: 'pending' | 'approved' | 'returned';
  channelCode?: string;
};

const normalizeSalesPlanDecimal = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
};

export const toRegionalApprovalLiveRow = (row: GeaSalesPlanListItem): RegionalApprovalLiveRow => ({
  ...row,
  ...(row.mPlanQty == null ? {} : { mPlanQty: normalizeSalesPlanDecimal(row.mPlanQty) }),
  ...(row.mPlanAmount == null ? {} : { mPlanAmount: normalizeSalesPlanDecimal(row.mPlanAmount) }),
  targetQty: normalizeSalesPlanDecimal(row.targetQty),
  targetAmount: normalizeSalesPlanDecimal(row.targetAmount),
  currentQty: normalizeSalesPlanDecimal(row.currentQty),
  currentAmount: normalizeSalesPlanDecimal(row.currentAmount),
  source: 'gea',
  approvalState: row.status === 10 ? 'approved' : row.status >= 6 && row.status <= 9 ? 'returned' : 'pending',
});

export type RegionalApprovalLiveDimensionProjection = {
  name?: string;
  context: string[];
  customerCode?: string;
};

const OFFICIAL_SALES_PLAN_CATEGORY_ORDER = [
  '水饺',
  '蒸煎饺',
  '汤圆',
  '馄饨',
  '面点',
  '饼类',
  '休闲',
  '米休闲',
  '火锅料',
  '烤肠',
  '鸡肉调理品',
  '粽子',
  '灌汤包',
  '其他',
] as const;

export type RegionalApprovalLiveCategorySummary = {
  categoryName: string;
  skuCount: number;
  quantity: string;
  amount: string;
  baseQuantity: string;
  baseAmount: string;
  quantityDelta: string;
  amountDelta: string;
  quantityProgress?: number;
  amountProgress?: number;
};

const uniqueNames = (values: Array<string | null | undefined>, excluded?: string) =>
  values
    .map((value) => value?.trim())
    .filter(
      (value, index, names): value is string => Boolean(value) && value !== excluded && names.indexOf(value) === index
    );

export const projectRegionalApprovalLiveDimension = (
  row: RegionalApprovalLiveRow,
  dimension: ApprovalDimension
): RegionalApprovalLiveDimensionProjection => {
  const name =
    dimension === 'area'
      ? row.areaName?.trim() || row.regionName?.trim() || row.areaCode?.trim()
      : dimension === 'province'
        ? row.provinceName?.trim() || row.provinceRegionName?.trim() || row.provinceCode?.trim()
        : dimension === 'region'
          ? row.orgName?.trim() || row.salesGroupName?.trim() || row.orgCode?.trim()
          : dimension === 'base'
            ? row.baseName?.trim()
            : row.dealerName?.trim() || row.dealerCode?.trim();
  const context =
    dimension === 'customer'
      ? uniqueNames(
          [
            row.orgName ?? row.salesGroupName,
            row.provinceName ?? row.provinceRegionName,
            row.areaName ?? row.regionName,
            row.baseName,
          ],
          name
        )
      : dimension === 'region'
        ? uniqueNames([row.provinceName ?? row.provinceRegionName, row.areaName ?? row.regionName, row.baseName], name)
        : dimension === 'province'
          ? uniqueNames([row.areaName ?? row.regionName, row.baseName], name)
          : dimension === 'base'
            ? uniqueNames(
                [
                  row.areaName ?? row.regionName,
                  row.provinceName ?? row.provinceRegionName,
                  row.orgName ?? row.salesGroupName,
                ],
                name
              )
            : uniqueNames([row.baseName], name);
  return {
    name,
    context,
    ...(dimension === 'customer' ? { customerCode: row.dealerCode.trim() } : {}),
  };
};

export const chooseInitialSalesPlanPeriod = (periods: readonly GeaSalesPlanPeriod[]): GeaSalesPlanPeriod | undefined =>
  periods.find((period) => period.status?.toUpperCase() === 'OPEN') ?? periods[0];

/** 用户只选择月份；Y/DC 等流程类型留在同月各计划内部用于审批判断。 */
export const salesPlanPeriodMonths = (periods: readonly GeaSalesPlanPeriod[]): string[] => [
  ...new Set(periods.map((period) => period.periodMonth)),
];

export const salesPlanPeriodsForMonth = (
  periods: readonly GeaSalesPlanPeriod[],
  periodMonth: string | undefined
): GeaSalesPlanPeriod[] => periods.filter((period) => period.periodMonth === periodMonth);

export const salesPlanPeriodOptionLabel = (periodMonth: string): string => periodMonth;

/** 聚合展示总数，但不把多个计划版本变成可写对象。 */
export const groupRegionalApprovalLiveRows = (
  rows: readonly RegionalApprovalLiveRow[],
  dimension: ApprovalDimension
) => {
  const groups = new Map<string, RegionalApprovalLiveRow[]>();
  for (const row of rows) {
    const projection = projectRegionalApprovalLiveDimension(row, dimension);
    const code =
      dimension === 'customer'
        ? row.dealerCode
        : dimension === 'region'
          ? row.orgCode
          : dimension === 'province'
            ? row.provinceCode
            : dimension === 'area'
              ? row.areaCode
              : row.baseName;
    const key = JSON.stringify([dimension, code || projection.name || row.planId]);
    const members = groups.get(key) ?? [];
    members.push(row);
    groups.set(key, members);
  }
  return [...groups].map(([key, members]) => ({
    key,
    members,
    summary:
      members.length === 1
        ? members[0]
        : {
            ...members[0],
            mPlanAmount: members.every((row) => /^-?\d+(?:\.\d+)?$/.test(row.mPlanAmount ?? ''))
              ? addExactDecimals(members.map((row) => row.mPlanAmount!))
              : undefined,
            mPlanQty: members.every((row) => /^-?\d+(?:\.\d+)?$/.test(row.mPlanQty ?? ''))
              ? addExactDecimals(members.map((row) => row.mPlanQty!))
              : undefined,
            targetAmount: addExactDecimals(members.map((row) => row.targetAmount)),
            targetQty: addExactDecimals(members.map((row) => row.targetQty)),
            currentAmount: addExactDecimals(members.map((row) => row.currentAmount)),
            currentQty: addExactDecimals(members.map((row) => row.currentQty)),
            skuCount: members.reduce((total, row) => total + row.skuCount, 0),
          },
  }));
};

export const isOpenSalesPlanPeriod = (period: GeaSalesPlanPeriod | undefined): boolean =>
  period?.status?.toUpperCase() === 'OPEN';

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

const parseDecimal = (value: string): { negative: boolean; digits: bigint; scale: number } | undefined => {
  const match = value.trim().match(DECIMAL_PATTERN);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  return {
    negative: match[1] === '-',
    digits: BigInt(`${match[2]}${fraction}`),
    scale: fraction.length,
  };
};

const powerOfTen = (scale: number): bigint => BigInt(`1${'0'.repeat(scale)}`);

export const addExactDecimals = (values: readonly string[]): string => {
  const parsed = values.map(parseDecimal);
  if (parsed.some((value) => value === undefined)) return '—';
  const decimals = parsed as Array<NonNullable<ReturnType<typeof parseDecimal>>>;
  const scale = Math.max(0, ...decimals.map((value) => value.scale));
  const total = decimals.reduce((sum, value) => {
    const signed = value.negative ? -value.digits : value.digits;
    return sum + signed * powerOfTen(scale - value.scale);
  }, BigInt(0));
  const negative = total < BigInt(0);
  const absolute = negative ? -total : total;
  const raw = absolute.toString().padStart(scale + 1, '0');
  const integer = scale === 0 ? raw : raw.slice(0, -scale);
  const fraction = scale === 0 ? '' : raw.slice(-scale);
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
};

export const subtractExactDecimals = (left: string | number, right: string | number): string => {
  const normalizedLeft = typeof left === 'number' ? String(left) : left;
  const normalizedRight = (typeof right === 'number' ? String(right) : right).trim();
  const negatedRight = normalizedRight.startsWith('-') ? normalizedRight.slice(1) : `-${normalizedRight}`;
  return addExactDecimals([normalizedLeft, negatedRight]);
};

const decimalRatio = (value: string, baseline: string): number | undefined => {
  const valueNumber = Number(value);
  const baselineNumber = Number(baseline);
  if (!Number.isFinite(valueNumber) || !Number.isFinite(baselineNumber) || baselineNumber === 0) return undefined;
  return (valueNumber / baselineNumber) * 100;
};

export const regionalApprovalLiveProgress = (row: RegionalApprovalLiveRow) => ({
  amount: decimalRatio(row.currentAmount, row.targetAmount),
  quantity: decimalRatio(row.currentQty, row.targetQty),
});

export const aggregateRegionalApprovalLiveCategories = (
  skus: readonly GeaSalesPlanSku[]
): RegionalApprovalLiveCategorySummary[] => {
  const categorySkus = new Map<string, GeaSalesPlanSku[]>();
  skus.forEach((sku) => {
    const categoryName = sku.productCategName.trim() || '其他';
    const current = categorySkus.get(categoryName) ?? [];
    current.push(sku);
    categorySkus.set(categoryName, current);
  });

  const officialRank = new Map<string, number>(OFFICIAL_SALES_PLAN_CATEGORY_ORDER.map((name, index) => [name, index]));
  return [...categorySkus.entries()]
    .toSorted(([left], [right]) => {
      const leftRank = officialRank.get(left) ?? OFFICIAL_SALES_PLAN_CATEGORY_ORDER.length;
      const rightRank = officialRank.get(right) ?? OFFICIAL_SALES_PLAN_CATEGORY_ORDER.length;
      return leftRank - rightRank || left.localeCompare(right, 'zh-CN');
    })
    .map(([categoryName, categoryItems]) => {
      const quantity = addExactDecimals(categoryItems.map((sku) => String(sku.qty)));
      const amount = addExactDecimals(categoryItems.map((sku) => String(sku.amt)));
      const baseQuantity = addExactDecimals(categoryItems.map((sku) => String(sku.baseQty)));
      const baseAmount = addExactDecimals(categoryItems.map((sku) => String(sku.amtBase)));
      return {
        categoryName,
        skuCount: categoryItems.length,
        quantity,
        amount,
        baseQuantity,
        baseAmount,
        quantityDelta: subtractExactDecimals(quantity, baseQuantity),
        amountDelta: subtractExactDecimals(amount, baseAmount),
        quantityProgress: decimalRatio(quantity, baseQuantity),
        amountProgress: decimalRatio(amount, baseAmount),
      };
    });
};

export const formatExactDecimal = (value: string | number): string => {
  const normalizedValue = typeof value === 'number' ? String(value) : value;
  const match = normalizedValue.trim().match(DECIMAL_PATTERN);
  if (!match) return normalizedValue;
  const grouped = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${match[1]}${grouped}${match[3] === undefined ? '' : `.${match[3]}`}`;
};

export const clampSalesPlanPageNumber = (value: number, fallback = 1): number =>
  Number.isSafeInteger(value) && value >= 1 ? value : fallback;

const parseExactDecimal = (value: string) => {
  const match = value.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  const coefficient = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? BigInt(-1) : BigInt(1));
  return { coefficient, scale: fraction.length };
};

export const multiplyExactDecimals = (left: string, right: string, targetScale = 2): string | undefined => {
  const leftDecimal = parseExactDecimal(left);
  const rightDecimal = parseExactDecimal(right);
  if (!leftDecimal || !rightDecimal) return undefined;
  const product = leftDecimal.coefficient * rightDecimal.coefficient;
  const productScale = leftDecimal.scale + rightDecimal.scale;
  const scaleFactor = BigInt(`1${'0'.repeat(Math.max(0, productScale - targetScale))}`);
  const absolute = product < 0 ? -product : product;
  const rounded =
    productScale > targetScale
      ? absolute / scaleFactor + ((absolute % scaleFactor) * BigInt(2) >= scaleFactor ? BigInt(1) : BigInt(0))
      : absolute * BigInt(`1${'0'.repeat(targetScale - productScale)}`);
  const signed = product < 0 ? -rounded : rounded;
  const negative = signed < 0;
  const raw = (negative ? -signed : signed).toString().padStart(targetScale + 1, '0');
  return `${negative ? '-' : ''}${raw.slice(0, -targetScale)}.${raw.slice(-targetScale)}`;
};

/** 未知角色映射保留原始代码，不虚构 Y 链审批标签。 */
export const salesPlanStatusText = (status: number, typeCode: string, t: TFunction): string => {
  const code = salesPlanWorkflow(typeCode).statusLabelCode(status);
  return code === undefined
    ? t('common.assistantSurface.regionalApproval.query.unknownStatus', { status })
    : t(`common.assistantSurface.regionalApproval.query.status.${code}`);
};

/** 队列、筛选、导出及详情使用同一状态名称，不随所选审批节点变化。 */
export const salesPlanQueueStatusText = (
  status: number,
  typeCode: string,
  stage: ApprovalStageId,
  t: TFunction,
): string => {
  return salesPlanStatusText(status, typeCode, t);
};
