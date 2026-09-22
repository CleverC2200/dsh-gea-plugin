/**
 * "这个对话现在到底在不在业务工作台里"的校验。
 *
 * 线上现象：用户在**主对话**（AI 工作台）里问业务问题，助手却把几分钟前在业务工作台里
 * 留下的页面快照当成"你眼前这一屏"，还照着它去读页面证据。快照本身没有"我还在不在页面"
 * 的语义，所以要单独判定：
 *
 * 1. 页面桥心跳（页面每秒轮询会刷新声明）——最权威；
 * 2. HTML 插件页的页面身份（90 秒内活动过）；
 * 3. 原生工作台快照的新鲜度——页面停止上报超过窗口就只算"上次留下的"。
 */

/** 快照多久没更新就不再当作"当前这一屏"。 */
export const WORKBENCH_PRESENCE_TTL_MS = 60_000;

export type WorkbenchPresence = {
  inWorkbench: boolean;
  /** 判断依据，写进工具结果，方便模型和排查时对照。 */
  signal: "page-bridge" | "page-identity" | "snapshot-fresh" | "none";
  /** 手上那份快照的年龄（秒）；没有快照时 undefined。 */
  staleSnapshotSeconds?: number;
};

export function workbenchPresence(input: {
  /** 页面桥心跳：这个会话此刻有活着的业务页面。 */
  livePage?: boolean;
  /** 这个会话当前的页面身份（HTML 插件页）。 */
  hasPageIdentity?: boolean;
  /** 最近一次原生工作台快照的接收时间（毫秒）；没有快照就不传。 */
  snapshotReceivedAt?: number;
  now?: number;
  ttlMs?: number;
}): WorkbenchPresence {
  const now = input.now ?? Date.now();
  const ttl = input.ttlMs ?? WORKBENCH_PRESENCE_TTL_MS;
  const age =
    input.snapshotReceivedAt === undefined
      ? undefined
      : Math.max(0, Math.round((now - input.snapshotReceivedAt) / 1000));
  const withAge = age === undefined ? {} : { staleSnapshotSeconds: age };
  if (input.livePage === true)
    return { inWorkbench: true, signal: "page-bridge", ...withAge };
  if (input.hasPageIdentity === true)
    return { inWorkbench: true, signal: "page-identity", ...withAge };
  if (
    input.snapshotReceivedAt !== undefined &&
    now - input.snapshotReceivedAt <= ttl
  )
    return { inWorkbench: true, signal: "snapshot-fresh", ...withAge };
  return { inWorkbench: false, signal: "none", ...withAge };
}
