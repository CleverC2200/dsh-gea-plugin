/**
 * 模型 → consumerCode：把"目录里看得见的模型"和"用哪条模块通道去查"对上。
 *
 * 线上问题（2026-09-23）：问"各区域预算占比"，模型在目录里看到了
 * `agents_sales_plan_detail_mi`，但不知道查它要带哪个 consumerCode，先试 `gea-gateway`
 * （被白名单挡）、再试演示模块（没有数据通道），最后放弃 Cube，拿工作台那 30 条计划单作答。
 *
 * 这个对应关系不用猜：目录（inspect）本身是用某个 consumerCode 建的会话拿到的，
 * 该身份看得见的模型，就是这个身份能查的模型。所以每次读目录都记一笔，目录输出里
 * 直接把 consumerCode 标给模型。
 *
 * 注意边界：**可见 ≠ 有数据行授权**。资源 ALLOW、方案匹配、用户业务范围仍由网关判定
 * （规约 G7/§12），这里只回答"用哪条通道"，不回答"有没有权限"。
 */

/** 与成员清单同一档缓存时长：模型基本不动，10 分钟足够。 */
const TTL_MS = 10 * 60 * 1000;

type Entry = { consumerCode: string; at: number };

let cached = new Map<string, Entry>();

/** inspect 产物里列出的模型名。 */
function modelNames(payload: unknown): string[] {
  const models = (payload as { semanticModel?: unknown })?.semanticModel;
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const model of models) {
    const name = (model as { name?: unknown })?.name;
    if (typeof name === "string" && name.trim()) names.push(name.trim());
  }
  return names;
}

function expired(entry: Entry, now: number): boolean {
  return now - entry.at > TTL_MS;
}

/** 记住"这些模型是用这个 consumerCode 读到的"。 */
export function rememberModelConsumers(consumerCode: string, payload: unknown): void {
  const code = consumerCode.trim();
  if (!code) return;
  const now = Date.now();
  for (const model of modelNames(payload)) cached.set(model, { consumerCode: code, at: now });
  for (const [model, entry] of cached) if (expired(entry, now)) cached.delete(model);
}

/** 这个模型该用哪个 consumerCode 查；没记录或过期返回 undefined。 */
export function consumerForModel(model: string): string | undefined {
  const entry = cached.get(model);
  if (!entry) return undefined;
  if (expired(entry, Date.now())) {
    cached.delete(model);
    return undefined;
  }
  return entry.consumerCode;
}

/** 当前有效的全部对应关系，给目录输出标注用。 */
export function modelConsumers(): ReadonlyMap<string, string> {
  const now = Date.now();
  const out = new Map<string, string>();
  for (const [model, entry] of cached) {
    if (expired(entry, now)) {
      cached.delete(model);
      continue;
    }
    out.set(model, entry.consumerCode);
  }
  return out;
}

export function forgetModelConsumers(): void {
  cached = new Map();
}

/**
 * 反查：这条 consumerCode 通道能读到哪些模型（目录里看到过的）。
 *
 * 给 `gea_module_mcp` 的模块清单用——模型先要了 consumerCode 列工具时，顺手把它能查的
 * 模型名列出来，"有这个编码但不知道能查什么"就不用再去翻一遍目录。
 */
export function modelsForConsumer(consumerCode: string, limit = 20): string[] {
  const code = consumerCode.trim();
  if (!code) return [];
  const now = Date.now();
  const out: string[] = [];
  for (const [model, entry] of cached) {
    if (expired(entry, now)) {
      cached.delete(model);
      continue;
    }
    if (entry.consumerCode === code && out.length < limit) out.push(model);
  }
  return out.sort();
}
