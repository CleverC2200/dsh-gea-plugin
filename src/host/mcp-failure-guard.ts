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
  check(consumerCode: string, scope?: string): void;
  /** 记一次结果：成功清零，失败累加。 */
  note(consumerCode: string, ok: boolean, scope?: string, reason?: string): void;
  clear(scope?: string): void;
};

export const MCP_FAILURE_LIMIT = 2;
export const MCP_FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** 本轮"白跑"多少次就整体停手（授权拒绝 / 上游失败 / 样例值取空 / 演示模块 / 模块未开通…）。 */
export const MCP_WASTE_LIMIT = 6;

export type McpWasteGuard = {
  /** 白跑一次（这类调用没有带来任何新证据）。 */
  waste(scope: string): void;
  /** 真拿到数据了：把这一轮的账清零，允许继续。 */
  progress(scope: string): void;
  /** 白跑到上限就抛 `GEA_TURN_RETRY_STOPPED`。 */
  check(scope: string): void;
  /** 换身份时清空。 */
  clear(): void;
};

/**
 * 本轮整体熔断：单个模块的熔断挡不住"换着模块试"。
 * 线上实测一轮 119 步、168 次调用，其中样例值取空 27 次、演示模块 24 次、授权拒绝若干——
 * 单个 consumer 的熔断对它们无效，所以这里按"会话 + 时间窗"记总账。
 */
export function createMcpWasteGuard(
  options: { limit?: number; windowMs?: number; now?: () => number } = {},
): McpWasteGuard {
  const limit = options.limit ?? MCP_WASTE_LIMIT;
  const windowMs = options.windowMs ?? MCP_FAILURE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const wasted = new Map<string, { count: number; at: number }>();
  const read = (scope: string) => {
    const entry = wasted.get(scope);
    if (!entry) return undefined;
    if (now() - entry.at >= windowMs) {
      wasted.delete(scope);
      return undefined;
    }
    return entry;
  };
  return {
    waste(scope) {
      const entry = read(scope);
      wasted.set(scope, { count: (entry?.count ?? 0) + 1, at: now() });
    },
    progress(scope) {
      wasted.delete(scope);
    },
    check(scope) {
      const entry = read(scope);
      if (!entry || entry.count < limit) return;
      throw new Error(
        `GEA_TURN_RETRY_STOPPED: 这一轮已经白跑了 ${entry.count} 次（找不到的模块、取不到的样例值、被拒的查询都算），` +
          "现在停手：不要再换模块、换模型、换成员或换写法试。请用已经拿到的证据作答；" +
          "确实缺数据时，直接说清缺哪一项、需要谁补，然后结束这一轮。",
      );
    },
    clear() {
      wasted.clear();
    },
  };
}

export function createMcpFailureGuard(
  options: { limit?: number; windowMs?: number; now?: () => number } = {},
): McpFailureGuard {
  const limit = options.limit ?? MCP_FAILURE_LIMIT;
  const windowMs = options.windowMs ?? MCP_FAILURE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const failures = new Map<string, { count: number; at: number; scope: string; reason?: string }>();
  const keyOf = (consumerCode: string, scope: string) => JSON.stringify([scope, consumerCode]);
  return {
    check(consumerCode, scope = 'global') {
      const key = keyOf(consumerCode, scope);
      const entry = failures.get(key);
      if (!entry || entry.count < limit) return;
      if (now() - entry.at >= windowMs) {
        failures.delete(key);
        return;
      }
      throw new Error(
        `GEA_MCP_RETRY_STOPPED: ${consumerCode} 已经连续失败 ${entry.count} 次，本轮此通道不要再换模型、换成员或换写法重试。` +
        `最近失败：${entry.reason ?? '原因未确定'}。其它已成功取得的数据仍有效；按原始错误说明缺口，不能一概归为缺授权。`,
      );
    },
    note(consumerCode, ok, scope = 'global', reason) {
      const key = keyOf(consumerCode, scope);
      if (ok) {
        failures.delete(key);
        return;
      }
      const previous = failures.get(key);
      failures.set(key, {
        count: previous && now() - previous.at < windowMs ? previous.count + 1 : 1,
        at: now(),
        scope,
        reason: reason?.slice(0, 800),
      });
    },
    clear(scope) {
      if (scope === undefined) failures.clear();
      else for (const [key, entry] of failures) if (entry.scope === scope) failures.delete(key);
    },
  };
}
