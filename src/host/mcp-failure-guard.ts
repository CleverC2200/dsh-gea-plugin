/**
 * 模块 MCP 通道的失败熔断。
 *
 * 线上实测的两类空转：① 同一个模块连续被拒（例如库龄缺资源 ALLOW），模型换写法、
 * 换成员、换模型继续试；② 一轮打了 17 次工具调用还没结论，中间开始跑偏。只读 SQL
 * 通道早就有这套（business 里的 `GEA_PLUGIN_RETRY_STOPPED`），MCP 通道一直缺。
 *
 * 口径与 SQL 通道一致：按 consumerCode 记连续失败，**成功即清零**；到上限后在窗口内
 * 直接停手，逼模型用手上的证据作答，或说清缺哪一项，而不是继续换着试。
 */

export type McpFailureGuard = {
  /** 到上限就抛 `GEA_MCP_RETRY_STOPPED`；窗口过了自动放行。 */
  check(consumerCode: string): void;
  /** 记一次结果：成功清零，失败累加。 */
  note(consumerCode: string, ok: boolean): void;
};

export const MCP_FAILURE_LIMIT = 2;
export const MCP_FAILURE_WINDOW_MS = 10 * 60 * 1000;

export function createMcpFailureGuard(
  options: { limit?: number; windowMs?: number; now?: () => number } = {},
): McpFailureGuard {
  const limit = options.limit ?? MCP_FAILURE_LIMIT;
  const windowMs = options.windowMs ?? MCP_FAILURE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const failures = new Map<string, { count: number; at: number }>();
  return {
    check(consumerCode) {
      const entry = failures.get(consumerCode);
      if (!entry || entry.count < limit) return;
      if (now() - entry.at >= windowMs) {
        failures.delete(consumerCode);
        return;
      }
      throw new Error(
        `GEA_MCP_RETRY_STOPPED: ${consumerCode} 已经连续失败 ${entry.count} 次，本轮不要再换模型、换成员或换写法重试。请用已经拿到的证据作答；确实缺数据时，直接说清缺哪一项（哪张模型、缺哪项授权），让用户去找管理员补。`,
      );
    },
    note(consumerCode, ok) {
      if (ok) {
        failures.delete(consumerCode);
        return;
      }
      failures.set(consumerCode, {
        count: (failures.get(consumerCode)?.count ?? 0) + 1,
        at: now(),
      });
    },
  };
}
