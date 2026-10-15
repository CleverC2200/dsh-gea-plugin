/**
 * "这个对话现在到底在不在业务工作台里"的判定。
 *
 * 线上现象：用户在**主对话**（AI 工作台首页）里问业务问题，助手却把之前在工作台里
 * 留下的页面快照当成"你眼前这一屏"，还照着它去读页面证据。
 *
 * 现在只认一个事实：前端上报的菜单状态字段（见 host/workbench-surface.ts）。
 *   - 没上报过 / 报了 `main` → 主对话：不交页面证据；
 *   - 报了某个业务菜单      → 在工作台，且知道是哪一页菜单。
 *
 * 不用页面心跳或快照新鲜度当判据：它们只能证明"页面还在轮询"，证明不了"用户在看这一页"。
 */
import {
  MAIN_MENU,
  surfaceLabel,
  type WorkbenchSurface,
} from "./workbench-surface.ts";

export type WorkbenchPresence = {
  inWorkbench: boolean;
  /** 判断依据：菜单状态字段是唯一权威来源。 */
  signal: "menu";
  /** 菜单 id；主对话时为 `main`。 */
  menu: string;
  
  menuTitle: string;
  /** 前端上报时间（ISO），排查用；没上报过就没有。 */
  menuReportedAt?: string;
};

export function workbenchPresence(input: {
  /** 前端上报的菜单状态；没上报过就不传。 */
  surface?: WorkbenchSurface;
}): WorkbenchPresence {
  const surface = input.surface;
  return {
    inWorkbench: surface !== undefined && surface.menu !== MAIN_MENU,
    signal: "menu",
    menu: surface?.menu ?? MAIN_MENU,
    menuTitle: surfaceLabel(surface),
    ...(surface === undefined
      ? {}
      : { menuReportedAt: new Date(surface.at).toISOString() }),
  };
}
