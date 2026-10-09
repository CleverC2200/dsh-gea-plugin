/**
 * 同一轮里的重复读收敛。
 *
 * 线上实测（session-af74ce65，2026-09-23）：一轮 117 步、224 次工具调用，其中同一个模型明细
 * 读了 31 次、不带参数的目录索引读了 24 次、同一个 9 月计划单查询读了 15 次。元信息去重
 * （call-dedup）只省了带宽——还是每次都占掉模型一步。这里补两层硬闸门：
 *
 * - 单键：同一个 key（同一份目录/成员明细/同参数的查询）最多"认真回" `perKey` 次，
 *   再读就只回一句"本轮已经读过"，不再把正文塞回去；
 * - 一轮总量：累计重复读超过 `perTurn` 次返回 stop，由调用层停止对应读取类别。
 *
 * 判据只有"同一轮 + 同一个 key"，不认识任何具体业务问题。
 */

export const REPEAT_PER_KEY_LIMIT = 2;
/** 聚合入口已承接全量需求，重复读 8 次即收敛，避免目录循环拖长上下文。 */
export const REPEAT_TURN_LIMIT = 8;

export type RepeatVerdict = "fresh" | "repeat" | "stop";

export type RepeatGuard = {
  /**
   * 记一次读取。`fresh` = 照常读（前 perKey 次）；`repeat` = 本轮已读过，回一句提示；
   * `stop` = 一轮里的重复已经太多；元数据停止探索，业务读取使用整轮止损。
   */
  note(scope: string, key: string): RepeatVerdict;
  /** 同一轮里重复读了多少次（诊断/测试用）。 */
  repeats(scope: string): number;
  clear(scope?: string): void;
};

export function createRepeatGuard(
  options: { perKey?: number; perTurn?: number } = {},
): RepeatGuard {
  const perKeyLimit = options.perKey ?? REPEAT_PER_KEY_LIMIT;
  const perTurnLimit = options.perTurn ?? REPEAT_TURN_LIMIT;
  const perKey = new Map<string, number>();
  const perTurn = new Map<string, number>();
  return {
    note(scope, key) {
      const composed = `${scope}|${key}`;
      const seen = (perKey.get(composed) ?? 0) + 1;
      perKey.set(composed, seen);
      if (seen <= perKeyLimit) return "fresh";
      const total = (perTurn.get(scope) ?? 0) + 1;
      perTurn.set(scope, total);
      return total >= perTurnLimit ? "stop" : "repeat";
    },
    repeats: (scope) => perTurn.get(scope) ?? 0,
    clear(scope) {
      if (scope !== undefined) {
        for (const key of perKey.keys()) if (key.startsWith(`${scope}|`)) perKey.delete(key);
        perTurn.delete(scope);
      } else {
        perKey.clear();
        perTurn.clear();
      }
    },
  };
}
