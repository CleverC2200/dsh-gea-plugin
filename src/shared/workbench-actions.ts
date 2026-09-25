/**
 * GEA 审批工作台的自述：页面标识、工具名与总述。
 *
 * 具体"这一屏有什么元素"由工作台按当前状态动态上报（见 src/workbench/workbench-elements.ts），
 * 工具名、参数表与说明全部由通用桥按这份目录 + 元素清单生成（src/page-bridge/catalog.ts）。
 * 新增页面元素只需要页面多声明一个元素，这里和桥都不用改。
 */
import type { PageElement } from "../page-bridge/catalog.ts";

export const WORKBENCH_SURFACE = "gea-workbench" as const;
export const WORKBENCH_TOOL_NAME = "gea_workbench_apply" as const;

export const WORKBENCH_CATALOG = {
  surface: WORKBENCH_SURFACE,
  tool: WORKBENCH_TOOL_NAME,
  reasonField: "reason",
  description:
    "改当前 GEA 审批工作台这一屏，并且只改页面开放的部分。" +
    "invoke 执行元素声明的动作（展开/收起某行、打开详情、清筛选等）；" +
    "setValue 只写「可编辑」元素（审批阶段、筛选值、页码、确认计划量）；" +
    "select 勾选行；clear 关闭抽屉。" +
    "只读元素（金额、状态、物料描述等）只能读不能改；" +
    "只执行当前目录实际开放的动作，不可直接改后台状态。草稿不等于提交；提交/审批类元素需本轮明确要求、confirm=true 和有效业务权限，以真实回执为准。不要擅自改筛选或阶段。",
} as const;

/**
 * 工具定义 = 固定总述 + 当前这一屏的元素清单。
 *
 * 这一屏没有可操作元素时返回 null（而不是一份空目录）：null 在桥里的含义是
 * "这个会话现在没有页面能力"，宿主会立刻注销工具。切走页面、加载中、页面报空
 * 都走这条，避免把上一屏的元素留在会话里（那会让模型对着不存在的元素下指令）。
 */
export const workbenchCatalog = (elements: PageElement[]) =>
  elements.length === 0
    ? null
    : {
        ...WORKBENCH_CATALOG,
        elements,
      };
