import { parseFirstJsonObject } from './gateway-catalog.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** Query names are labels; changing one must not leave a completed query pending. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = object(value);
  return record ? '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}' : JSON.stringify(value);
}
function exactJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: {source?: string}) => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || /[.eE]/.test(context?.source ?? ''))) {
      if (!context?.source) throw Error('EXACT_JSON_RUNTIME_REQUIRED');
      return context.source;
    }
    return value;
  });
}

/** Extract observed rows, never infer an empty table from an unknown response shape. */
export function mcpReadReceipts(consumerCode: string, parameters: ObjectValue, output: string): ObjectValue[] {
  if (parameters.action !== 'query' || !Array.isArray(parameters.queries)) return [];
  let root: ObjectValue | undefined;
  try { root = object(parseFirstJsonObject(output, exactJson)); } catch { return []; }
  if (!root || root.isError === true || root.success === false || root.error) return [];
  const datasets = new Map<string, {rows: ObjectValue[]; pages: number; hasMore?: boolean; totalRows?: unknown}>();
  const add = (value: unknown, artifact = false) => {
    const page = object(value);
    const name = page?.name ?? page?.datasetName;
    if (!page || typeof name !== 'string' || !Array.isArray(page.rows) || page.rows.some(row => !object(row)) || page.error || page.success === false) return;
    const previous = datasets.get(name);
    datasets.set(name, {
      rows: [...(previous?.rows ?? []), ...page.rows as ObjectValue[]], pages: (previous?.pages ?? 0) + 1,
      // For artifacts without hasMore, transport completeness is unknown, not complete.
      hasMore: typeof page.hasMore === 'boolean' ? (previous?.hasMore === true || page.hasMore) : artifact ? undefined : previous?.hasMore,
      totalRows: page.totalRows ?? page.rowCount ?? previous?.totalRows,
    });
  };
  if (Array.isArray(root.datasets)) root.datasets.forEach(item => add(item));
  // Prefer inline datasets if present, so dual delivery does not count the same rows twice.
  if (!datasets.size) {
    const resources = object(root.queryArtifact)?.resources;
    if (Array.isArray(resources)) for (const resource of resources) {
      const contents = object(resource)?.contents;
      if (!Array.isArray(contents)) continue;
      for (const content of contents) {
        const text = object(content)?.text;
        if (typeof text === 'string') try { add(exactJson(text), true); } catch { /* Unreadable page is not empty data. */ }
      }
    }
  }
  const receipts: ObjectValue[] = [];
  for (const item of parameters.queries) {
    const query = object(item);
    const dataset = typeof query?.name === 'string' ? datasets.get(query.name) : undefined;
    if (!query || !dataset) continue;
    const rows: ObjectValue[] = [];
    for (const row of dataset.rows.slice(0, 16)) {
      if (bytes([...rows, row]) > 1800) break;
      rows.push(row);
    }
    const receipt: ObjectValue = {
      source: 'GEA_MODULE_MCP', consumerCode, fetchedAt: new Date().toISOString(), query,
      availability: dataset.rows.length ? 'data-returned' : 'empty-query-result',
      observedRows: dataset.rows.length, reportedRows: dataset.totalRows,
      transportHasMore: dataset.hasMore ?? 'unknown', rows, rowsOmitted: rows.length < dataset.rows.length,
      coverage: 'query-scope-only',
      note: '查询成功；这里只保留有界回执。范围受原查询筛选、快照、limit/offset 限制，不能把记录行数当客户去重数，也不能把样本当全量。后续失败不撤销这些结果。',
    };
    if (bytes(receipt) <= 8000) receipts.push(receipt);
  }
  return receipts;
}

export function createMcpReadLedger() {
  type Pending = {consumerCode: string; tool: string; arguments: ObjectValue};
  const scopes = new Map<string, {receipts: Map<string, ObjectValue>; pending: Map<string, Pending>}>();
  const state = (scope: string) => {
    let value = scopes.get(scope);
    if (!value) {
      value = {receipts: new Map(), pending: new Map()}; scopes.set(scope, value);
      while (scopes.size > 64) scopes.delete(scopes.keys().next().value!);
    }
    return value;
  };
  const key = (consumer: string, query: unknown) => consumer + '\0' + canonical(query);
  return {
    epoch(scope: string): object { return state(scope); },
    pending(scope: string) { return [...(scopes.get(scope)?.pending.values() ?? [])]; },
    rememberPending(scope: string, consumerCode: string, parameters: ObjectValue, epoch?: object) {
      if (epoch && scopes.get(scope) !== epoch) return;
      if (parameters.action !== 'query' || !Array.isArray(parameters.queries)) return;
      const target = state(scope).pending;
      for (const item of parameters.queries) {
        const query = object(item); if (!query) continue;
        const entry = {consumerCode, tool: 'query_business_data', arguments: {...parameters, queries: [query]}};
        if (bytes(entry) > 4000) continue;
        target.set(key(consumerCode, query.query), entry);
        while (target.size > 8 || bytes([...target.values()]) > 16_000) target.delete(target.keys().next().value!);
      }
    },
    success(scope: string, consumerCode: string, parameters: ObjectValue, output: string, epoch?: object) {
      if (epoch && scopes.get(scope) !== epoch) return;
      const receipts = mcpReadReceipts(consumerCode, parameters, output);
      if (!receipts.length) return;
      const target = state(scope);
      for (const receipt of receipts) {
        const id = key(consumerCode, object(receipt.query)?.query);
        target.pending.delete(id); target.receipts.set(id, receipt);
      }
      while (target.receipts.size > 32) target.receipts.delete(target.receipts.keys().next().value!);
    },
    evidence(scope: string) {
      const result: ObjectValue[] = [];
      for (const receipt of scopes.get(scope)?.receipts.values() ?? []) {
        const compact = {...receipt};
        if (bytes([...result, compact]) > 16_000) { compact.rows = []; compact.rowsOmitted = true; }
        if (bytes([...result, compact]) > 16_000) break;
        result.push(compact);
      }
      return result;
    },
    clear(scope?: string) { if (scope === undefined) scopes.clear(); else scopes.delete(scope); },
  };
}
