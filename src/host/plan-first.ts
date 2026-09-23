/**
 * "先想清楚再取数"的判定。
 *
 * 背景（线上实测）：只要有工具可用，模型会一路调工具、**一个字都不说**——
 * 最近 6 个会话里 3 个从头到尾 0 字符文本，另一个到第 25 步才开口；
 * 结果就是边想边试、上下文被读爆（那轮 44 次调用合计 21 万字符）。
 * 原因之一是预设里写了"不汇报工具调用、查询过程或内部计划"——把规划逼成了隐形的。
 *
 * 这里做的是确定性检查点：不靠模型自觉。
 * - 连打 `NUDGE_AFTER` 次、这一轮还没说过一句话 → 在工具结果里催它先给计划；
 * - 到 `PAUSE_AFTER` 次仍未开口 → 直接暂停取数，只回"先给计划"。
 * 判据只有"这一轮是否已出现助手文本 + 这是第几次取数调用"，不认识任何业务。
 */

/** 第几次取数调用开始催"先给计划"。 */
export const PLAN_NUDGE_AFTER = 2;
/** 第几次取数调用开始暂停取数。 */
export const PLAN_PAUSE_AFTER = 5;

export type PlanVerdict = "ok" | "nudge" | "pause";

/**
 * @param callIndex 这一轮第几次取数调用（从 1 开始）。
 * @param spoke 这一轮模型是否已经输出过文本（计划或结论都算）。
 */
export function planVerdict(callIndex: number, spoke: boolean): PlanVerdict {
  if (spoke) return "ok";
  if (callIndex >= PLAN_PAUSE_AFTER) return "pause";
  if (callIndex >= PLAN_NUDGE_AFTER) return "nudge";
  return "ok";
}

/** 催它开口时追加在工具结果后面的那句（短文，不占上下文）。 */
export const PLAN_NUDGE_NOTE =
  "\n\n（宿主提示：这一轮你还没说过打算怎么答。先用一句话讲清计划——这一问要回答什么、要取哪几个数、走哪条通道、拿不到就说什么——再继续取数；正文里不用逐步播报工具调用。）";

/** 暂停取数时返回给模型的内容。 */
export function planPausePayload(callIndex: number): string {
  return JSON.stringify({
    source: "GEA_PLAN_FIRST",
    availability: "plan-required",
    code: "PLAN_REQUIRED",
    note:
      `【先给计划】这一轮已经调了 ${callIndex} 次取数工具，还没有说过一句话。` +
      "**这不是取数失败、也不是权限或网关限制**：你只要先用 1–2 句写下计划" +
      "（要回答什么、要取哪几个数、走哪条通道、拿不到就说什么），**同一轮立刻就能继续取数**，" +
      "不需要等用户回复，也不要把这一轮结论写成「拿不到数据」。已经拿到的数据直接用。",
  });
}
