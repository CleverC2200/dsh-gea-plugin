import { Decimal } from 'decimal.js';

type Row = Record<string, unknown>;
type Read = (payload: Row, signal: AbortSignal) => Promise<unknown>;
const Exact = Decimal.clone({precision: 4096});
const MAX_PLANS = 500;
const MAX_SKUS = 100_000;
const MAX_GROUPS = 300;
const MAX_REQUESTS = 1000;

function decimal(value: unknown): Decimal {
  if (typeof value !== 'string' || value.length > 1024 || !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value))
    throw Error('GEA_AGGREGATE_DECIMAL: 金额或数量缺失，不能按零汇总');
  const number = new Exact(value);
  if (!number.isFinite() || Math.abs(number.e) > 1024) throw Error('GEA_AGGREGATE_DECIMAL_RANGE');
  return number;
}
const label = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const identity = (row: Row) => JSON.stringify([row.planId, row.versionId, row.status, row.updatedAt, row.baseName, row.orderType, row.planTypeCode, row.skuCount]);

/** 在当前身份下读取完整计划及 SKU；只返回分组汇总，任何不完整/变更都使本次汇总失败。 */
export async function aggregateSalesPlans(read: Read, query: Row, signal: AbortSignal) {
  if (typeof query.periodId !== 'string' || !query.periodId.trim())
    throw Error('INVALID_QUERY: aggregate requires periodId from periods; narrow one period first');
  let requests = 0;
  const request: Read = async (payload, active) => {
    active.throwIfAborted();
    if (++requests > MAX_REQUESTS) throw Error('GEA_AGGREGATE_LIMIT: 请按基地或业务类型缩小范围');
    const value = await read(payload, active);
    active.throwIfAborted();
    return value;
  };
  const scan = async () => {
    const plans = new Map<string, Row>();
    const versions = new Set<string>();
    let total: number | undefined;
    for (let pageNo = 1; ; pageNo++) {
      const page = await request({kind:'list', query:{...query,pageNo,pageSize:200}}, signal) as Row;
      const rows = page.records as Row[];
      const count = Number(page.total), current = Number(page.current);
      if (!Array.isArray(rows) || !Number.isSafeInteger(count) || count < 0 || current !== pageNo)
        throw Error('GEA_AGGREGATE_INCOMPLETE');
      if (count > MAX_PLANS) throw Error(`GEA_AGGREGATE_LIMIT: 匹配 ${count} 张计划，最多 ${MAX_PLANS} 张，请缩小范围`);
      if (total !== undefined && total !== count) throw Error('GEA_AGGREGATE_CHANGED: 分页期间计划总数变化，请重新聚合');
      total = count;
      for (const row of rows) {
        const id = label(row.planId), versionId = label(row.versionId);
        if (!id || !versionId || String(row.periodId) !== query.periodId || !['M','Z'].includes(String(row.orderType)) || !label(row.planTypeCode))
          throw Error('GEA_AGGREGATE_IDENTITY: 计划缺少周期、版本或业务类型');
        for (const key of ['orderType','planTypeCode','dealerCode','areaCode','provinceCode','orgCode','baseName','status']) {
          if (query[key] != null && query[key] !== '' && String(row[key]) !== String(query[key]))
            throw Error(`GEA_AGGREGATE_FILTER_UNSUPPORTED: 上游返回的 ${key} 不符合筛选；不能据此确认该范围的金额或有无数据。请说明此范围未验证，不要改用明细绕过。`);
        }
        if (plans.has(id) || versions.has(versionId)) throw Error('GEA_AGGREGATE_DUPLICATE: 分页返回重复计划或版本');
        plans.set(id,row); versions.add(versionId);
      }
      if (plans.size > total || (!rows.length && plans.size !== total)) throw Error('GEA_AGGREGATE_INCOMPLETE');
      if (plans.size === total) return plans;
    }
  };
  const plans = await scan();
  type Sum = {orderType:string;planTypeCode:string;baseName?:string|null;productCategName?:string|null;amt:Decimal;qty:Decimal;plans:Set<string>;skus:Set<string>;skuRowCount:number;statusCounts:Record<string,number>};
  const groups = new Map<string,Sum>(), bases = new Map<string,Sum>(), totals = new Map<string,Sum>(), categories = new Map<string,Sum>();
  const getSum = (map: Map<string,Sum>, dims: Pick<Sum,'orderType'|'planTypeCode'|'baseName'|'productCategName'>) => {
    const key = JSON.stringify(dims);
    let sum = map.get(key);
    if (!sum) {sum = {...dims,amt:new Exact(0),qty:new Exact(0),plans:new Set(),skus:new Set(),skuRowCount:0,statusCounts:{}};map.set(key,sum);}
    if (map.size > MAX_GROUPS) throw Error('GEA_AGGREGATE_LIMIT: 汇总分组过多，请按基地或业务类型缩小范围');
    return sum;
  };
  const addPlan = (sum: Sum, row: Row) => {
    const id = String(row.planId);
    if (sum.plans.has(id)) return;
    sum.plans.add(id);
    const status = Number(row.status);
    const key = row.status != null && row.status !== '' && Number.isInteger(status) && status >= 0 && status <= 10 ? String(status) : 'unknown';
    sum.statusCounts[key] = (sum.statusCounts[key] ?? 0) + 1;
  };
  let skuCount = 0;
  const distinctSkus = new Set<string>();
  // 有界并发；任一读取失败时终止其余请求，不留下仍在后台扫描的任务。
  const cancellation = new AbortController();
  const active = AbortSignal.any([signal,cancellation.signal]);
  const queue = [...plans.values()];
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      active.throwIfAborted();
      const row = queue[next++];
      const dims = {orderType:String(row.orderType),planTypeCode:String(row.planTypeCode)};
      const baseDims = {...dims,baseName:label(row.baseName)};
      const total = getSum(totals,dims), base = getSum(bases,baseDims);
      addPlan(total,row); addPlan(base,row);
      const skus = await request({kind:'versionSkus',query:{versionId:row.versionId}},active) as Row[];
      if (!Array.isArray(skus)) throw Error('GEA_AGGREGATE_INCOMPLETE');
      if (row.skuCount != null && Number(row.skuCount) !== skus.length) throw Error('GEA_AGGREGATE_CHANGED: SKU 数量与计划列表不一致，请重新聚合');
      skuCount += skus.length;
      if (skuCount > MAX_SKUS) throw Error('GEA_AGGREGATE_LIMIT: SKU 超过汇总上限，请缩小范围');
      const seen = new Set<string>();
      for (const sku of skus) {
        const code = label(sku.skuCode);
        if (!code || seen.has(code)) throw Error('GEA_AGGREGATE_DUPLICATE: SKU 身份缺失或重复');
        seen.add(code);
        distinctSkus.add(code);
        const amt = decimal(sku.amt), qty = decimal(sku.qty);
        const group = getSum(groups,{...baseDims,productCategName:label(sku.productCategName)});
        const category = getSum(categories,{...dims,productCategName:label(sku.productCategName)});
        addPlan(group,row); addPlan(category,row);
        for (const sum of [total,base,group,category]) {sum.amt=sum.amt.plus(amt);sum.qty=sum.qty.plus(qty);sum.skuRowCount++;sum.skus.add(code);}
      }
    }
  };
  const workers = Array.from({length:Math.min(4,queue.length)},()=>worker().catch(error=>{cancellation.abort();throw error;}));
  try { await Promise.all(workers); }
  catch (error) { await Promise.allSettled(workers); throw error; }
  const after = await scan();
  if (plans.size !== after.size || [...plans].some(([id,row])=>!after.has(id) || identity(row)!==identity(after.get(id)!)))
    throw Error('GEA_AGGREGATE_CHANGED: 汇总期间计划版本或状态变化，请重新聚合');
  signal.throwIfAborted();
  const serialize = (sum: Sum) => {
    const {plans,skus,amt,qty,...rest}=sum;
    const count = (...statuses: number[]) => statuses.reduce((n,status)=>n+(sum.statusCounts[String(status)] ?? 0),0);
    return {...rest,planCount:plans.size,distinctSkuCount:skus.size,amt:amt.toFixed(),qty:qty.toFixed(),
      statusSummary:{'待提交':count(0),'审批中':count(1,2,3,4),'审批完成待回写':count(5),'退回':count(6,7,8,9),'回写完成':count(10),'状态未知':sum.statusCounts.unknown ?? 0}};
  };
  const sorted = (map: Map<string,Sum>) => [...map.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,sum])=>sum);
  const share = (num: Decimal, denominator: Decimal) => denominator.isZero() ? null : num.div(denominator).toDecimalPlaces(8).toFixed();
  return {
    planCount:plans.size,skuRowCount:skuCount,distinctSkuCount:distinctSkus.size,
    basis:{groupBy:['orderType','planTypeCode','baseName','productCategName'],amount:'versionSkus.amt',quantity:'versionSkus.qty',
      geography:'baseName 是基地，不等同组织大区；缺失基地/品类保留 null',
      counts:'skuRowCount 是 SKU 明细记录条数；distinctSkuCount 才是按 skuCode 去重的商品种数。不同分组的去重数不能直接相加。',
      scope:'当前身份可读、当前周期和筛选条件匹配的当前计划版本；不是全公司覆盖率。不合并 M/Z 或不同业务类型。',
      status:'0 待提交；1–4 审批中（节点按配置链）；5 审批完成待回写；6–9 退回；10 回写完成。状态不证明各角色审批仍有效。',
      delivery:'状态数直接引用 statusSummary；跨基地品类合计与占比直接引用 categoryTotals。不得再心算或累加各基地百分比。金额覆盖本次全部匹配计划，不是某状态子集的金额；状态金额需另按 status 筛选。品类间可能共享同一计划，planCount 不可跨品类相加。',
      share:'金额占比为同 orderType、planTypeCode 内的金额比值（1 代表 100%）；零分母为 null。',
      consistency:'汇总前后复核计划版本、状态和更新时间；上游未提供事务快照。'},
    totals:sorted(totals).map(serialize),bases:sorted(bases).map(serialize),
    categoryTotals:sorted(categories).map(sum=>({...serialize(sum),amountShareWithinScope:share(sum.amt,getSum(totals,{orderType:sum.orderType,planTypeCode:sum.planTypeCode}).amt)})),
    groups:sorted(groups).map(sum=>{
      const dims={orderType:sum.orderType,planTypeCode:sum.planTypeCode};
      return {...serialize(sum),amountShareWithinBase:share(sum.amt,getSum(bases,{...dims,baseName:sum.baseName}).amt),amountShareWithinScope:share(sum.amt,getSum(totals,dims).amt)};
    }),
  };
}
