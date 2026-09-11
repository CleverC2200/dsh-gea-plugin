/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
export type ApprovalStageId = 'customer' | 'region' | 'province' | 'area' | 'category';
export type ApprovalHealth = 'healthy' | 'attention' | 'warning';
export type ApprovalState = 'pending' | 'approved' | 'future';
export type ApprovalVersion = 'current' | 'previous' | 'initial';
export type ApprovalDimension = 'area' | 'province' | 'region' | 'base' | 'customer';
export type ApprovalPermission = 'writable' | 'read-only' | 'denied';
export type ApprovalAreaKey = 'north' | 'east' | 'central' | 'southwest';
export type ApprovalBranchKey = 'beijing' | 'hebei' | 'zhejiang' | 'henan' | 'sichuan';
export type ApprovalDepartmentKey = 'beijing-sales' | 'shijiazhuang' | 'hangzhou' | 'zhengzhou' | 'chengdu';
export type ApprovalCustomerKey = 'northstar' | 'yanzhao' | 'qiantang' | 'zhongyuan' | 'rongcheng';

export type ApprovalStageFixture = {
  id: ApprovalStageId;
  progress: number;
};

export type RegionalApprovalRow = {
  id: string;
  organizationKey: 'north' | 'east' | 'central' | 'southwest' | 'hebei';
  level: 'area' | 'province';
  areaKey: ApprovalAreaKey;
  branchKey: ApprovalBranchKey;
  departmentKey: ApprovalDepartmentKey;
  customerKey: ApprovalCustomerKey;
  customerCode: string;
  category: 'frozen-pastry' | 'rice-noodle';
  provinceKey: 'hebei' | 'zhejiang' | 'henan' | 'sichuan';
  customers: number;
  quantity: number;
  amount: number;
  previousQuantity: number;
  previousAmount: number;
  quantityProgress: number;
  amountProgress: number;
  adjustmentQuantity: number;
  adjustmentAmount: number;
  health: ApprovalHealth;
  approvalState: ApprovalState;
  permission: ApprovalPermission;
  returnReason?: string;
  aiOpinionKey: 'north' | 'east' | 'central' | 'southwest' | 'hebei';
  reachedStage: ApprovalStageId;
};

export const APPROVAL_STAGE_FIXTURES: readonly ApprovalStageFixture[] = [
  { id: 'customer', progress: 94 },
  { id: 'region', progress: 100 },
  { id: 'province', progress: 75 },
  { id: 'area', progress: 42 },
  { id: 'category', progress: 0 },
];

const approvalStageRank: Record<ApprovalStageId, number> = {
  customer: 0,
  region: 1,
  province: 2,
  area: 3,
  category: 4,
};

export const REGIONAL_APPROVAL_ROWS: readonly RegionalApprovalRow[] = [
  {
    id: 'north-area',
    organizationKey: 'north',
    level: 'area',
    areaKey: 'north',
    branchKey: 'hebei',
    departmentKey: 'shijiazhuang',
    customerKey: 'northstar',
    customerCode: '10154901',
    category: 'frozen-pastry',
    provinceKey: 'hebei',
    customers: 18,
    quantity: 11240,
    amount: 881970,
    previousQuantity: 10810,
    previousAmount: 847120,
    quantityProgress: 68,
    amountProgress: 72,
    adjustmentQuantity: 430,
    adjustmentAmount: 34850,
    health: 'warning',
    approvalState: 'pending',
    permission: 'writable',
    aiOpinionKey: 'north',
    reachedStage: 'area',
  },
  {
    id: 'east-area',
    organizationKey: 'east',
    level: 'area',
    areaKey: 'east',
    branchKey: 'zhejiang',
    departmentKey: 'hangzhou',
    customerKey: 'qiantang',
    customerCode: '10154903',
    category: 'rice-noodle',
    provinceKey: 'zhejiang',
    customers: 16,
    quantity: 10460,
    amount: 826400,
    previousQuantity: 10200,
    previousAmount: 801780,
    quantityProgress: 100,
    amountProgress: 100,
    adjustmentQuantity: 260,
    adjustmentAmount: 24620,
    health: 'healthy',
    approvalState: 'approved',
    permission: 'read-only',
    returnReason: '已完成上一轮客户缺口复核',
    aiOpinionKey: 'east',
    reachedStage: 'category',
  },
  {
    id: 'central-area',
    organizationKey: 'central',
    level: 'area',
    areaKey: 'central',
    branchKey: 'henan',
    departmentKey: 'zhengzhou',
    customerKey: 'zhongyuan',
    customerCode: '10154904',
    category: 'frozen-pastry',
    provinceKey: 'henan',
    customers: 14,
    quantity: 9860,
    amount: 748200,
    previousQuantity: 9740,
    previousAmount: 739100,
    quantityProgress: 84,
    amountProgress: 81,
    adjustmentQuantity: 120,
    adjustmentAmount: 9100,
    health: 'attention',
    approvalState: 'pending',
    permission: 'writable',
    returnReason: '促销提报依据待补充',
    aiOpinionKey: 'central',
    reachedStage: 'area',
  },
  {
    id: 'southwest-area',
    organizationKey: 'southwest',
    level: 'area',
    areaKey: 'southwest',
    branchKey: 'sichuan',
    departmentKey: 'chengdu',
    customerKey: 'rongcheng',
    customerCode: '10154905',
    category: 'rice-noodle',
    provinceKey: 'sichuan',
    customers: 12,
    quantity: 7740,
    amount: 612800,
    previousQuantity: 7740,
    previousAmount: 612800,
    quantityProgress: 64,
    amountProgress: 61,
    adjustmentQuantity: 0,
    adjustmentAmount: 0,
    health: 'warning',
    approvalState: 'future',
    permission: 'read-only',
    aiOpinionKey: 'southwest',
    reachedStage: 'province',
  },
  {
    id: 'hebei-province',
    organizationKey: 'hebei',
    level: 'province',
    areaKey: 'north',
    branchKey: 'hebei',
    departmentKey: 'shijiazhuang',
    customerKey: 'yanzhao',
    customerCode: '10154902',
    category: 'frozen-pastry',
    provinceKey: 'hebei',
    customers: 8,
    quantity: 5260,
    amount: 407300,
    previousQuantity: 5170,
    previousAmount: 400500,
    quantityProgress: 100,
    amountProgress: 100,
    adjustmentQuantity: 90,
    adjustmentAmount: 6800,
    health: 'healthy',
    approvalState: 'approved',
    permission: 'read-only',
    aiOpinionKey: 'hebei',
    reachedStage: 'area',
  },
];

export const isApprovalStageId = (value: unknown): value is ApprovalStageId =>
  APPROVAL_STAGE_FIXTURES.some((stage) => stage.id === value);

export const approvalRowsForStage = (
  rows: readonly RegionalApprovalRow[],
  stage: ApprovalStageId
): RegionalApprovalRow[] => rows.filter((row) => approvalStageRank[row.reachedStage] >= approvalStageRank[stage]);

export const APPROVAL_DIMENSIONS_BY_STAGE: Record<ApprovalStageId, readonly ApprovalDimension[]> = {
  customer: ['customer'],
  region: ['region', 'customer'],
  province: ['province', 'region', 'customer'],
  area: ['area', 'province', 'region', 'customer'],
  category: ['base', 'area', 'province', 'region', 'customer'],
};
