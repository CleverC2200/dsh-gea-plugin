/** Verified source semantics. These facts never grant access or substitute another model. */
export const SALES_PLAN_MODEL = 'agents_sales_plan_detail_mi';
const MONTHS: Readonly<Record<string, string>> = {
  'agents_sales_plan_detail_mi.plane_date': '2026-08',
  'agents_sales_shipment.plan_month': '202608',
  'agents_sales_target.plan_month': '202608',
  'agents_sales_forecast_detail_mi.plan_month': '202609',
};
export function monthEncoding(member: string): string | undefined { return MONTHS[member]; }
export function monthFormatIssue(queries: unknown): string | undefined {
  const issues: string[] = [];
  const visit = (filters: unknown) => {
    if (!Array.isArray(filters)) return;
    for (const f of filters) {
      if (!f || typeof f !== 'object') continue;
      visit(f.and); visit(f.or);
      const sample = MONTHS[f.member];
      if (!sample || !Array.isArray(f.values) || !['equals','notEquals','gt','gte','lt','lte'].includes(f.operator)) continue;
      for (const value of f.values) {
        if (typeof value !== 'string') continue;
        const match = /^(\d{4})-?(0[1-9]|1[0-2])$/.exec(value);
        if (!match) continue;
        const expected = `${match[1]}${sample.includes('-') ? '-' : ''}${match[2]}`;
        if (expected !== value) issues.push(`${f.member} 的月份文本应为 ${expected}，不是 ${value}`);
      }
    }
  };
  if (Array.isArray(queries)) for (const item of queries) visit(item?.query?.filters);
  return issues.length ? `GEA_CUBE_MONTH_FORMAT：${issues.join('；')}。仅修正对应来源的过滤值；不要改成员名，也不要把其它来源改成相同格式。查询尚未发出。` : undefined;
}

export function salesQueryGuide(model: string): string {
  if (model === 'agents_sales_forecast_detail_mi') return '预测概览：plan_month用YYYYMM（如202609），先只查请求月，不扫描全部月份。M月初与Z纠偏分别展示，不能相加。按当前目录的合法度量查数；predicted_quantity/predicted_sales_amount若列为维度，不能塞入measures或把样本相加冒充全量。若无数量/金额SUM，说明总预测量/额暂不可得；概览可用order_type+quantity_status分组、row_count统计记录状态，一次精简查询即可，版本仅必要时单查。概览按已返回状态作答；同步时间/批次未返回就标未知，不为补齐说明另查created_at或逐日拆分。用户核对同步、批次或时效时再查。不要主动展开节庆、算法标记、省区、基地或客户SKU样本；用户追问再按范围查询。仅需确认未知文本格式时取维度样例，分段和度量不取维度样例。供应缺口还需同期间、同范围、同单位的需求与供应；只有短期供应不能代表整月。取得必要事实或确认缺少合法汇总后交付卡片，不以多查字段弥补缺口。';
  if (model === SALES_PLAN_MODEL) return '销售结果查询：月份用plane_date equals YYYY-MM（如2026-08）；原计划量/最终量用plannum_sum/allnum_sum，单位件。只查请求月：总量取两个SUM及row_count、plan_month_count、load_batch_count、candidate_grain_count、missing_scope_count、对应缺量计数；missing_scope_count仅检查月份/加载时间，不检查组织归属。客户SKU前N按cust_code/material_code分组，用受管SUM和排序limit=N。省区用province_region_name并查missing_province_count；省区为空或双方无同口径度量时立即说明缺口并给必要事实，不继续拉另一侧全量分布或查其它层级。单月单批次/候选键唯一不证明同步全量；SUM为NULL且有记录应检查保护条件，不能说无数据。原量=最终量只证明总净差0，是否发生调整未知。order_status无可信字典时保留原码；预测M/Z不适用于此源。结果满足问题就结束，不额外查其它月份或调整。';
  if (model === 'agents_sales_shipment' || model === 'agents_sales_target') return `月份文本用${model}.plan_month（如202608），不要沿用Hive计划的2026-08。按请求层级、前N和合法度量取数；名称不自动分类。单位/币种只认该源已确认语义，不从销售计划件数外推。`;
  return '';
}

/** High-confidence result intent only; live workflow/mixed questions retain online reads. */
export function salesSourceIssue(question: string): string | undefined {
  const explicitHive = /(?:只|必须|只能).{0,35}(?:Hive|agents_sales_plan_detail_mi)/i.test(question);
  const forbidOnline = /(?:不要|不用|不使用).{0,8}在线(?:计划)?(?:接口|数据)/i.test(question);
  const result = /提报结果|计划结果|最终.{0,8}计划|(?:发货|出货).{0,12}(?:占|对比|进度)|计划.{0,12}(?:合计|汇总|总量|目标差)/.test(question);
  const workflow = /审批|退回原因|审批日志|操作前|当前页面|在线工作流|实时状态|在线.{0,6}(?:计划|数据|接口)/.test(question);
  return forbidOnline || ((explicitHive || result) && !workflow)
    ? 'GEA_SALES_RESULT_SOURCE：本轮销售提报/计划结果需用授权Cube模型agents_sales_plan_detail_mi；源缺失时交付缺口，不使用在线工作流代替。'
    : undefined;
}

export function salesSourceIssueForTurns(questions: readonly string[]): string | undefined {
  for (const question of [...questions].reverse()) {
    const issue = salesSourceIssue(question);
    if (issue) return issue;
    if (!/^(?:继续|再|按|那|上面|刚才|改成)/.test(question.trim()) || /审批|退回|在线|页面|实时/.test(question)) return undefined;
  }
  return undefined;
}

/** A small task-local output contract; does not change the query's authorized scope. */
export function requestedOutputScope(question: string): string {
  const n = /前\s*(\d{1,3})\s*(?:条|个|名)/.exec(question)?.[1];
  if (!n || Number(n)<1) return '';
  const positive = question.replace(/(?:不要|无需|不查|不算)[^。；\n]*/g,'');
  const calculation = /占比|比例|差额|计算|进度|对比/.test(positive);
  return `本次输出范围：只列用户要求的前${n}条及其明确要求的同范围合计。字段取值按原标签展示，分类字典未确认时只说明未确认；不要自行排除组织、重排“真实省区”或额外抽查全量。${calculation?'派生指标仅计算用户指定的项目。':'这是查数题：不要新增前N小计、占比、估算或假设换算，即使可以心算也不追加。'}已有行足够回答就结束。`;
}
