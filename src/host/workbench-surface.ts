/**
 * 「这个对话现在停在哪一页」的状态字段。
 *
 * 设计：默认是主对话（AI 工作台首页）。用户在左侧功能区点某个业务菜单时，前端把
 * 菜单 id + 菜单名报给宿主；之后所有"要不要交页面证据"的判断只认这一个字段，
 * 不再靠"页面还在不在轮询""快照新不新鲜"去猜——那两件事都不能证明用户此刻在看业务页。
 */

import { MAIN_MENU } from "../business-navigation.ts";

/** 主对话（AI 工作台首页）：没有业务页面，也没有页面证据。 */
export { MAIN_MENU };
/** 菜单 id 与菜单名的长度上限：菜单只有 id 和名字，超过就是脏数据。 */
export const MENU_MAX_CHARS = 80;

export type WorkbenchSurface = {
  /** 菜单/面板 id；`main` 表示主对话。 */
  menu: string;
  /** 菜单名（人话），给模型和排查用；主对话时为「主对话」。 */
  title: string;
  /** 最近一次上报时间（毫秒）。 */
  at: number;
};

/** 菜单字段按不可信输入处理：去掉控制字符、裁长度，空值算没报。 */
function cleanMenuText(value: unknown, max = MENU_MAX_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = Array.from(value, (char) =>
    char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
  )
    .join("")
    .trim();
  if (!text) return undefined;
  return text.slice(0, max);
}

/** 归一化一次上报；menu 缺失或非法直接报错，避免"默默当成主对话"。 */
export function normalizeSurface(
  input: { menu?: unknown; title?: unknown },
  now = Date.now(),
): WorkbenchSurface {
  const menu = cleanMenuText(input.menu);
  if (!menu) throw new Error("INVALID_WORKBENCH_MENU");
  const title = cleanMenuText(input.title);
  return {
    menu,
    title: title ?? (menu === MAIN_MENU ? "主对话" : menu),
    at: now,
  };
}

/** 没上报过、或报了 main，都算主对话。 */
export function isMainSurface(surface: WorkbenchSurface | undefined): boolean {
  return surface === undefined || surface.menu === MAIN_MENU;
}

/** 给模型/日志看的一句话菜单名。 */
export function surfaceLabel(surface: WorkbenchSurface | undefined): string {
  if (surface === undefined) return "主对话（未上报菜单状态）";
  return surface.menu === MAIN_MENU ? surface.title || "主对话" : surface.title;
}

/**
 * 每一轮都注入模型的"我在哪"事实。
 *
 * 线上现象：位置判定本身是对的，但模型一上来不知道自己在哪，只能先调
 * `gea_page` / `gea_visible_workbench_context` 去问（那两次调用必然白跑，
 * 返回 not-in-workbench），然后才开始取数。所以把这条事实放进系统提示，
 * 让模型第一步就按位置选通道。
 */
export function surfacePromptLine(surface: WorkbenchSurface | undefined): string {
  return isMainSurface(surface)
    ? "页面：未绑定。整体范围查询直接走专用读取或 query_business_data；用户指向这一屏时说明需要页面或具体对象，不空读页面。"
    : `页面：${surfaceLabel(surface)}。仅用户引用可见内容时读取相关页面证据；独立范围问题走专用读取或 query_business_data。`;
}
