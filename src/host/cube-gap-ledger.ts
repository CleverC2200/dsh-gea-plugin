/**
 * 结构性缺口的账本：某个（模块编码 + 模型）已经确认"不是参数问题，就是取不到"时记一笔，
 * 下一次同样的组合直接给结论，不再发一次注定失败的调用。
 *
 * 与 mcp-failure-guard 的分工：
 * - failure-guard 按 consumerCode 数连续失败，到上限整体止损（防"换着模块试"）；
 * - 这个账本按"模块 + 模型"记住**具体缺哪一项**（资源 ALLOW / 方案不匹配 / 资源没发布），
 *   让第二次的答复本身就是结论，而不是再撞一次、再翻译一次。
 *
 * 为什么权限类能当结构性缺口：规约 §14 写得很清楚——"明确资源 ALLOW/方案/范围缺失 →
 * 联系平台维护，参数重试无法补授权"。改参数、换成员、换写法都不会让它变通。
 * TTL 到期后放行一次：管理员刚配好权限时，用户重新问一遍就能立刻恢复，不必重启客户端。
 */

/** 缺口的类型：目前只有"资源授权"这一类是确定的（其它等有实据再分）。 */
export type CubeGapKind = "resource-permission";

export type CubeGap = {
  kind: CubeGapKind;
  /** 网关给的错误码，例如 AI_GATEWAY_DATA_PERMISSION_DENIED。 */
  code: string;
  /** 可读原因（含 reasonCode/resourceCode 这类"缺哪一项"的信息）。 */
  detail: string;
  at: number;
};

export type CubeGapLedger = {
  /** 记一笔：这个模块 + 模型已经确认取不到。 */
  note(
    consumerCode: string,
    model: string,
    gap: { kind: CubeGapKind; code: string; detail: string },
  ): void;
  /** 上次记的缺口（过期返回 undefined）。 */
  find(consumerCode: string, model: string): CubeGap | undefined;
  /** 换身份时清空。 */
  clear(): void;
  size(): number;
};

export const CUBE_GAP_TTL_MS = 10 * 60 * 1000;

const keyOf = (consumerCode: string, model: string): string =>
  `${consumerCode.trim()}|${model.trim()}`;

export function createCubeGapLedger(
  options: { ttlMs?: number; now?: () => number } = {},
): CubeGapLedger {
  const ttlMs = options.ttlMs ?? CUBE_GAP_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CubeGap>();
  const read = (consumerCode: string, model: string): CubeGap | undefined => {
    const key = keyOf(consumerCode, model);
    const gap = entries.get(key);
    if (!gap) return undefined;
    if (now() - gap.at > ttlMs) {
      entries.delete(key);
      return undefined;
    }
    return gap;
  };
  return {
    note(consumerCode, model, gap) {
      if (!consumerCode.trim() || !model.trim()) return;
      entries.set(keyOf(consumerCode, model), { ...gap, at: now() });
    },
    find: read,
    clear() {
      entries.clear();
    },
    size: () => entries.size,
  };
}

/** 这张查询里用的模型（取第一个合法成员名里的模型前缀）；判不出来就返回 undefined。 */
export function modelOfQueries(queries: unknown): string | undefined {
  if (!Array.isArray(queries)) return undefined;
  const fromMember = (member: unknown): string | undefined => {
    if (typeof member !== "string") return undefined;
    const trimmed = member.trim();
    const at = trimmed.lastIndexOf(".");
    return at > 0 && at < trimmed.length - 1 ? trimmed.slice(0, at) : undefined;
  };
  for (const item of queries) {
    const query = (item as { query?: unknown })?.query;
    if (!query || typeof query !== "object") continue;
    const record = query as Record<string, unknown>;
    for (const field of ["dimensions", "measures", "segments"]) {
      const list = record[field];
      if (!Array.isArray(list)) continue;
      for (const member of list) {
        const model = fromMember(member);
        if (model) return model;
      }
    }
  }
  return undefined;
}
