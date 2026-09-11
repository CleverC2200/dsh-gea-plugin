/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import type {
  ApprovalAreaKey,
  ApprovalBranchKey,
  ApprovalCustomerKey,
  ApprovalDepartmentKey,
  ApprovalHealth,
  ApprovalStageId,
  ApprovalState,
  ApprovalVersion,
  RegionalApprovalRow,
} from './regionalApprovalFixture.ts';

export const ALL_ORGANIZATIONS = 'all' as const;

export type ApprovalOrganizationFilters = {
  area: ApprovalAreaKey | typeof ALL_ORGANIZATIONS;
  branch: ApprovalBranchKey | typeof ALL_ORGANIZATIONS;
  department: ApprovalDepartmentKey | typeof ALL_ORGANIZATIONS;
  customer: ApprovalCustomerKey | typeof ALL_ORGANIZATIONS;
  approval: ApprovalState | typeof ALL_ORGANIZATIONS;
  health: ApprovalHealth | typeof ALL_ORGANIZATIONS;
};

export type ApprovalOrganizationFilterField = keyof ApprovalOrganizationFilters;

export const DEFAULT_APPROVAL_FILTERS: ApprovalOrganizationFilters = {
  area: ALL_ORGANIZATIONS,
  branch: ALL_ORGANIZATIONS,
  department: ALL_ORGANIZATIONS,
  customer: ALL_ORGANIZATIONS,
  approval: ALL_ORGANIZATIONS,
  health: ALL_ORGANIZATIONS,
};

const FILTER_ORDER: readonly ApprovalOrganizationFilterField[] = [
  'area',
  'branch',
  'department',
  'customer',
  'approval',
  'health',
];

const rowValue = (row: RegionalApprovalRow, field: ApprovalOrganizationFilterField) => {
  if (field === 'area') return row.areaKey;
  if (field === 'branch') return row.branchKey;
  if (field === 'department') return row.departmentKey;
  if (field === 'customer') return row.customerKey;
  if (field === 'approval') return row.approvalState;
  return row.health;
};

const unique = <T extends string>(values: readonly T[]): T[] => [...new Set(values)];

const rowsMatchingFields = (
  rows: readonly RegionalApprovalRow[],
  filters: ApprovalOrganizationFilters,
  fields: readonly ApprovalOrganizationFilterField[]
) =>
  rows.filter((row) =>
    fields.every((field) => filters[field] === ALL_ORGANIZATIONS || rowValue(row, field) === filters[field])
  );

export const approvalFilterOptions = (
  rows: readonly RegionalApprovalRow[],
  filters: ApprovalOrganizationFilters
): Record<ApprovalOrganizationFilterField, string[]> => ({
  area: unique(rows.map((row) => row.areaKey)),
  branch: unique(rowsMatchingFields(rows, filters, ['area']).map((row) => row.branchKey)),
  department: unique(rowsMatchingFields(rows, filters, ['area', 'branch']).map((row) => row.departmentKey)),
  customer: unique(rowsMatchingFields(rows, filters, ['area', 'branch', 'department']).map((row) => row.customerKey)),
  approval: unique(
    rowsMatchingFields(rows, filters, ['area', 'branch', 'department', 'customer']).map((row) => row.approvalState)
  ),
  health: unique(
    rowsMatchingFields(rows, filters, ['area', 'branch', 'department', 'customer', 'approval']).map((row) => row.health)
  ),
});

export const normalizeApprovalFilters = (
  rows: readonly RegionalApprovalRow[],
  filters: ApprovalOrganizationFilters
): ApprovalOrganizationFilters => {
  let normalized = { ...filters };
  for (const field of FILTER_ORDER) {
    const options = approvalFilterOptions(rows, normalized)[field];
    if (normalized[field] !== ALL_ORGANIZATIONS && !options.includes(normalized[field])) {
      if (field === 'area') normalized.area = ALL_ORGANIZATIONS;
      if (field === 'branch') normalized.branch = ALL_ORGANIZATIONS;
      if (field === 'department') normalized.department = ALL_ORGANIZATIONS;
      if (field === 'customer') normalized.customer = ALL_ORGANIZATIONS;
      if (field === 'approval') normalized.approval = ALL_ORGANIZATIONS;
      if (field === 'health') normalized.health = ALL_ORGANIZATIONS;
    }
  }
  return normalized;
};

export const updateApprovalFilter = <Field extends ApprovalOrganizationFilterField>(
  rows: readonly RegionalApprovalRow[],
  filters: ApprovalOrganizationFilters,
  field: Field,
  value: ApprovalOrganizationFilters[Field]
): ApprovalOrganizationFilters => normalizeApprovalFilters(rows, { ...filters, [field]: value });

export const projectApprovalRows = (
  rows: readonly RegionalApprovalRow[],
  filters: ApprovalOrganizationFilters
): RegionalApprovalRow[] => rowsMatchingFields(rows, filters, FILTER_ORDER);

export const metricsForApprovalVersion = (row: RegionalApprovalRow, version: ApprovalVersion) => {
  if (version === 'current') return { quantity: row.quantity, amount: row.amount };
  if (version === 'previous') return { quantity: row.previousQuantity, amount: row.previousAmount };
  return {
    quantity: Math.round(row.previousQuantity * 0.96),
    amount: Math.round(row.previousAmount * 0.96),
  };
};

export type ApprovalPage<Row> = {
  rows: Row[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
};

export const paginateApprovalRows = <Row>(
  rows: readonly Row[],
  requestedPage: number,
  pageSize: number
): ApprovalPage<Row> => {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(rows.length / safePageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage)), pageCount);
  return {
    rows: rows.slice((page - 1) * safePageSize, page * safePageSize),
    page,
    pageSize: safePageSize,
    total: rows.length,
    pageCount,
  };
};

export type ApprovalCsvLabels = {
  version: string;
  stage: string;
  organization: string;
  area: string;
  branch: string;
  department: string;
  customer: string;
  quantity: string;
  amount: string;
  versionValues: Record<ApprovalVersion, string>;
};

const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

export const buildApprovalCsv = (
  rows: readonly RegionalApprovalRow[],
  version: ApprovalVersion,
  stage: ApprovalStageId,
  labels: ApprovalCsvLabels
): string => {
  const header = [
    labels.version,
    labels.stage,
    labels.organization,
    labels.area,
    labels.branch,
    labels.department,
    labels.customer,
    labels.quantity,
    labels.amount,
  ];
  const records = rows.map((row) => {
    const metrics = metricsForApprovalVersion(row, version);
    return [
      labels.versionValues[version],
      stage,
      row.id,
      row.areaKey,
      row.branchKey,
      row.departmentKey,
      row.customerKey,
      metrics.quantity,
      metrics.amount,
    ];
  });
  return [header, ...records].map((record) => record.map(csvCell).join(',')).join('\n');
};
