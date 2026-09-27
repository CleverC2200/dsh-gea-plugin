/** Shared schema/preflight vocabulary. Source: https://docs.cube.dev/reference/core-data-apis/rest-api/query-format */
export const CUBE_FILTER_OPERATORS = [
  'equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'notStartsWith',
  'endsWith', 'notEndsWith', 'gt', 'gte', 'lt', 'lte', 'set', 'notSet',
  'inDateRange', 'notInDateRange', 'beforeDate', 'beforeOrOnDate',
  'afterDate', 'afterOrOnDate', 'onTheDate', 'measureFilter',
] as const;
