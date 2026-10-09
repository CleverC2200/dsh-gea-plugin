import { WORKFLOW_CONFIG_SQL, WORKFLOW_PAGE_SIZE } from './workflow-query.js';

const KINDS = ['periods', 'list', 'detail', 'versionSkus'];
const FIELDS = ['maxRequests', ...KINDS, 'workflowSql', 'maxWorkflowRows', 'metadata'];
export function validateSalesReadonly(config) {
  if (config === undefined) return;
  if (!config || Array.isArray(config) || typeof config !== 'object' ||
      Object.keys(config).some(key => !FIELDS.includes(key)) ||
      FIELDS.some(key => !Number.isSafeInteger(config[key]) || config[key] < (key === 'maxWorkflowRows' ? 1 : 0)))
    throw Error('INVALID_SALES_READONLY_VALIDATION');
}

export class SalesReadonlyError extends Error {
  constructor(code, message) { super(message); this.code = code; this.retryable = false; }
}
const deny = (reason, message) => { throw new SalesReadonlyError('GEA_SALES_READONLY_' + reason, message); };

/** Optional validation scope; allowances live for the Host lifetime, independently of login and query epochs. */
export function createSalesReadonly(config, consumerCode, baseUrl) {
  validateSalesReadonly(config);
  if (config === undefined) return undefined;
  if (typeof consumerCode !== 'string' || !consumerCode) throw Error('INVALID_SALES_READONLY_CONSUMER');
  const limits = Object.freeze({ ...config });
  const spent = Object.fromEntries(FIELDS.filter(key => key !== 'maxWorkflowRows').map(key => [key, 0]));
  const available = kind => {
    if (spent[kind] >= limits[kind] || (KINDS.includes(kind) && spent.maxRequests >= limits.maxRequests))
      deny('LIMIT', '本次销售只读额度已用完，未发出额外请求');
  };
  const assertQuery = kind => {
    if (!KINDS.includes(kind)) deny('QUERY', '本次验证仅开放周期、列表、详情和 SKU 读取');
    available(kind);
  };
  return {
    assertQuery,
    assertWorkflow: () => available('workflowSql'),
    assertModel: () => deny('MODEL', '本次只读验证未开放模型任务'),
    assertConsumer(consumer, effect) {
      if (consumer !== consumerCode) deny('CONSUMER', '本次只读验证未开放这个消费者');
      if (effect !== 'view') deny('EFFECT', '本次只读验证未开放草稿或业务写入');
    },
    assertOperation(operation) {
      if (!['status', 'workbench/query', 'workflow/config', 'approval/roles', 'api-log/snapshot'].includes(operation))
        deny('OPERATION', '本次验证未开放此操作');
    },
    snapshot: () => ({ limits: { ...limits }, spent: { ...spent } }),
    async beforeRequest(input, init, purpose) {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      const url = new URL(input instanceof Request ? input.url : String(input));
      const base = new URL(baseUrl());
      const prefix = base.pathname.replace(/\/$/, '');
      if (url.origin !== base.origin || (prefix && !url.pathname.startsWith(prefix + '/')))
        deny('TRANSPORT', '本次只读验证未开放此接口');
      const path = url.pathname.slice(prefix.length);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      let bucket;
      if (method === 'GET' && KINDS.includes(purpose)) {
        const matches = purpose === 'periods' || purpose === 'list'
          ? path === '/sales-plan/plans'
          : purpose === 'detail'
            ? /^\/sales-plan\/plans\/[^/]+$/.test(path)
            : /^\/sales-plan\/plans\/versions\/[^/]+\/skus$/.test(path);
        if (!matches) deny('TRANSPORT', '本次只读查询与接口不匹配');
        bucket = purpose;
      } else if (method === 'GET' && ['/sys/user/getUserInfo', '/sys/permission/getPermCode'].includes(path)) {
        bucket = 'metadata';
      } else if (method === 'POST' && ['/ai/gateway/session', '/ai/gateway/agent/session', '/ai/gateway/agent/session/current-user/resolve', '/ai/gateway/sql/execute'].includes(path)) {
        const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
        let body;
        try { body = JSON.parse(typeof raw === 'string' ? raw : ''); } catch { deny('TRANSPORT', '本次只读请求参数不匹配'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) deny('TRANSPORT', '本次只读请求参数不匹配');
        if (path.endsWith('/sql/execute')) {
          if (Object.keys(body).some(key => !['sql', 'parameters', 'pageNo', 'pageSize', 'includeTotal'].includes(key)) ||
              body.sql !== WORKFLOW_CONFIG_SQL || body.parameters?.active !== 1 || body.parameters?.notDeleted !== 1 ||
              Object.keys(body.parameters).length !== 2 || body.includeTotal !== true ||
              body.pageSize !== WORKFLOW_PAGE_SIZE || !Number.isSafeInteger(body.pageNo) || body.pageNo < 1 ||
              body.pageNo * WORKFLOW_PAGE_SIZE > limits.maxWorkflowRows)
            deny('SQL', '本次验证仅开放固定工作流 SELECT 及其行数范围');
          bucket = 'workflowSql';
        } else {
          const consumer = path === '/ai/gateway/session' ? body.consumerCode : body.agentCode;
          if (consumer !== consumerCode || (path === '/ai/gateway/session' && body.consumerType !== 'AGENT'))
            deny('CONSUMER', '本次只读验证未开放这个消费者');
          bucket = 'metadata';
        }
      } else deny('TRANSPORT', '本次只读验证未开放此接口');
      // The logger performs this final charge synchronously at its physical fetch boundary.
      return () => {
        signal?.throwIfAborted();
        available(bucket);
        spent[bucket]++;
        if (KINDS.includes(bucket)) spent.maxRequests++;
      };
    },
  };
}
