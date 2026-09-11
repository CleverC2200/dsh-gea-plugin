/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import type { TFunction } from 'i18next';
import { SALES_PLAN_ROLES, salesPlanWorkflow } from '../../salesPlanWorkflow.ts';
import type {
  GeaSalesPlanListItem,
  GeaSalesPlanPageQuery,
  GeaSalesPlanPeriod,
  GeaSalesPlanSku,
} from '../../bridge.ts';
import type { ApprovalDimension, ApprovalStageId } from './regionalApprovalFixture.ts';

// Pending status projection for the Y chain; other chains resolve via salesPlanWorkflow.
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
export const approvalStageProgressForSalesPlanStatusTotals = (
  total: number,
  statusTotals: Readonly<Partial<Record<number, number>>>,
  typeCode = 'Y'
): Record<ApprovalStageId, number> => {
  const workflow = salesPlanWorkflow(typeCode);
  return Object.fromEntries(
    SALES_PLAN_ROLES.map((role) => {
      const pending = workflow.pending(role);
      if (!Number.isSafeInteger(total) || total <= 0 || pending === undefined) return [role, 0];
      const completed = SALES_PLAN_PROGRESS_STATUSES.reduce<number>((sum, status) => {
        // Returned target retains its confirmation; the initiating node must approve again.
        const active = workflow.actor(status);
        const activePending = active && workflow.pending(active);
        const done =
          status === 10 ||
          (status === 5 && role !== 'category') ||
          (activePending !== undefined && activePending > pending);
        return sum + (done ? Math.max(0, statusTotals[status] ?? 0) : 0);
      }, 0);
      return [role, Math.max(0, Math.min(completed >= total ? 100 : 99, Math.round((completed / total) * 100)))];
    })
  ) as Record<ApprovalStageId, number>;
};

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
  periods.find((period) => period.status.toUpperCase() === 'OPEN') ?? periods[0];

/** Group display totals without turning several plan versions into a writable object. */
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
            targetAmount: addExactDecimals(members.map((row) => row.targetAmount)),
            currentAmount: addExactDecimals(members.map((row) => row.currentAmount)),
            currentQty: addExactDecimals(members.map((row) => row.currentQty)),
            skuCount: members.reduce((total, row) => total + row.skuCount, 0),
          },
  }));
};

export const isOpenSalesPlanPeriod = (period: GeaSalesPlanPeriod | undefined): boolean =>
  period?.status.toUpperCase() === 'OPEN';

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

/** Unknown role mappings retain the raw code without inventing a Y-chain approval label. */
export const salesPlanStatusText = (status: number, typeCode: string, t: TFunction): string => {
  const code = salesPlanWorkflow(typeCode).statusLabelCode(status);
  return code === undefined
    ? t('common.assistantSurface.regionalApproval.query.unknownStatus', { status })
    : t(`common.assistantSurface.regionalApproval.query.status.${code}`);
};
