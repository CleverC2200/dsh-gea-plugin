/**
 * 同一份"只读元信息"在同一轮里被反复读取时，直接回上一次的结果。
 *
 * 线上实测：一轮 119 步里 `gea_gateway_catalog` 被调了 **93 次**，其中大量是同一个参数
 * （不带 model 的索引、同一个模型的成员、同一份模块工具清单）。每一次都要重新建 MCP 会话、
 * 拉 33 万字符的 inspect 产物再压缩——纯白跑，还把上下文重复塞一遍。
 *
 * 只用于**元信息**（目录、成员、工具清单），不用于业务数据：业务数据每次都要真查。
 */

export type CallDedup = {
  /** 命中就返回"上一次那份 + 一句提醒"；没命中返回 undefined。 */
  hit(key: string): string | undefined;
  /** 记下这次的结果，返回给模型的原文本。 */
  remember(key: string, text: string): string;
  /** 身份或环境变化时清空（缓存里可能有上一份身份看得见的东西）。 */
  clear(): void;
};

export const CALL_DEDUP_TTL_MS = 10 * 60 * 1000;
/** 最多记多少份：够一轮用，不至于把内存撑起来。 */
export const CALL_DEDUP_LIMIT = 60;

export function createCallDedup(
  options: { ttlMs?: number; limit?: number; now?: () => number } = {},
): CallDedup {
  const ttlMs = options.ttlMs ?? CALL_DEDUP_TTL_MS;
  const limit = options.limit ?? CALL_DEDUP_LIMIT;
  const now = options.now ?? Date.now;
  const seen = new Map<string, { text: string; at: number }>();
  return {
    hit(key) {
      const entry = seen.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) {
        seen.delete(key);
        return undefined;
      }
      return (
        entry.text +
        "\n\n（这份内容同一轮里已经给过一次了：**直接用它**，不要重复读取同样的目录/清单；" +
        "要的是别的模型就换 model 参数。）"
      );
    },
    remember(key, text) {
      seen.delete(key);
      seen.set(key, { text, at: now() });
      while (seen.size > limit) {
        const oldest = seen.keys().next().value as string;
        seen.delete(oldest);
      }
      return text;
    },
    clear() {
      seen.clear();
    },
  };
}
