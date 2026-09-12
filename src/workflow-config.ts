import { randomUUID } from 'node:crypto';
import { salesPlanWorkflow, type SalesPlanWorkflowRow } from './workbench-original/salesPlanWorkflow.ts';

const SQL =
  'SELECT id, type_code, examine_level, node_num FROM agents_scm_plan_workflow_config WHERE status = :active AND delete_status = :notDeleted ORDER BY type_code, examine_level, id';
const PAGE_SIZE = 100;

/** Fixed, read-only business query. The caller never supplies SQL, identity, or credentials. */
export async function readSalesPlanWorkflowConfig(
  base: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<SalesPlanWorkflowRow[]> {
  const rows: SalesPlanWorkflowRow[] = [];
  const ids = new Set<string>();
  const post = async (path: string, body: unknown, headers: Record<string, string>) => {
    const response = await fetchImpl(base + path, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('GEA_WORKFLOW_QUERY_FAILED');
    const payload = await response.json();
    signal.throwIfAborted();
    if (payload?.success !== true || payload.code !== 200 || !payload.result)
      throw new Error('GEA_WORKFLOW_QUERY_FAILED');
    return payload.result;
  };
  {
    const session = await post(
      '/ai/gateway/agent/session',
      {
        agentCode: 'sales_forecast',
        channel: 'AI_PORTAL',
        requestId: randomUUID(),
        conversationId: randomUUID(),
      },
      { 'X-Access-Token': accessToken }
    );
    if (
      session.accessDecision?.allowed !== true ||
      typeof session.delegationToken !== 'string' ||
      !session.delegationToken
    )
      throw new Error('GEA_WORKFLOW_SESSION_REJECTED');
    let total: number | undefined;
    for (let page = 1; page <= 10; page++) {
      const requestId = randomUUID();
      // Each page depends on the first page's verified total.
      // eslint-disable-next-line no-await-in-loop
      const result = await post(
        '/ai/gateway/sql/execute',
        {
          sql: SQL,
          parameters: { active: 1, notDeleted: 1 },
          pageNo: page,
          pageSize: PAGE_SIZE,
          includeTotal: true,
        },
        { 'X-Delegation-Token': session.delegationToken, 'X-Request-Id': requestId }
      );
      if (
        result.requestId !== requestId ||
        result.operation !== 'SELECT' ||
        !Array.isArray(result.tables) ||
        result.tables.length !== 1 ||
        result.tables[0] !== 'agents_scm_plan_workflow_config' ||
        !Number.isSafeInteger(result.total) ||
        result.total < 1 ||
        result.total > 1000 ||
        (total !== undefined && result.total !== total) ||
        result.pageNo !== page ||
        result.pageSize !== PAGE_SIZE ||
        !Array.isArray(result.rows) ||
        result.rows.length !== Math.min(PAGE_SIZE, result.total - rows.length)
      )
        throw new Error('GEA_WORKFLOW_RESPONSE_INVALID');
      total = result.total;
      for (const row of result.rows) {
        const level =
          typeof row?.examine_level === 'string' && /^\d+$/.test(row.examine_level)
            ? Number(row.examine_level)
            : row?.examine_level;
        const id = String(row?.id ?? '');
        if (
          !/^\d+$/.test(id) ||
          ids.has(id) ||
          typeof row.type_code !== 'string' ||
          !row.type_code ||
          typeof row.node_num !== 'string' ||
          !row.node_num ||
          !Number.isSafeInteger(level) ||
          level < 0
        )
          throw new Error('GEA_WORKFLOW_RESPONSE_INVALID');
        ids.add(id);
        rows.push({ typeCode: row.type_code, examineLevel: level, nodeNum: row.node_num });
      }
      if (rows.length === total) break;
    }
  }
  signal.throwIfAborted();
  if (
    !rows.length ||
    [...new Set(rows.map((row) => row.typeCode))].some((type) => !salesPlanWorkflow(type, rows).valid)
  )
    throw new Error('GEA_WORKFLOW_RESPONSE_INVALID');
  return rows;
}
