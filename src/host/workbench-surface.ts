import { MAIN_MENU } from "../business-navigation.ts";

export { MAIN_MENU };

export const MENU_MAX_CHARS = 80;

export type WorkbenchSurface = {
  menu: string;

  title: string;

  at: number;
};

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

export function isMainSurface(surface: WorkbenchSurface | undefined): boolean {
  return surface === undefined || surface.menu === MAIN_MENU;
}

export function surfaceLabel(surface: WorkbenchSurface | undefined): string {
  if (surface === undefined) return "主对话（未上报菜单状态）";
  return surface.menu === MAIN_MENU ? surface.title || "主对话" : surface.title;
}

export function surfacePromptLine(surface: WorkbenchSurface | undefined): string {
  return isMainSurface(surface)
    ? "页面：未绑定。整体范围查询直接走专用读取或 query_business_data；用户指向这一屏时说明需要页面或具体对象，不空读页面。"
    : `页面：${surfaceLabel(surface)}。仅用户引用可见内容时读取相关页面证据；独立范围问题走专用读取或 query_business_data。`;
}
