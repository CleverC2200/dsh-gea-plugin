/**
 * 把工作台当前这一屏"渲染出来的元素"翻译成页面桥的元素清单。
 *
 * 只描述屏幕上看得见、人能操作的东西：行、控件、可编辑字段。
 * 内部状态、缓存、接口都不进清单，所以模型也调不到。
 */
import type { PageElement } from "../page-bridge/catalog.ts";

export type WorkbenchElementInput = {
  /** 当前可见的计划行。 */
  rows: Array<{
    planId: string;
    label: string;
    value: string;
    expanded: boolean;
  }>;
  selectedPlanIds: string[];
  /** 审批阶段：all 表示不限。 */
  stage: string;
  stageOptions: Array<{ value: string; label: string }>;
  /** 筛选控件（areaCode/provinceCode/orgCode/dealerCode/status）。 */
  filters: Array<{
    field: string;
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
  }>;
  page: number;
  pages: number;
  /** 打开中的详情抽屉。 */
  detail?: { planId: string; label: string };
  /** 已展开行里的可编辑字段（确认计划量）。 */
  fields: Array<{ id: string; label: string; value: string; editable: boolean }>;
  /** 一列一起改用的集合。 */
  collections: Array<{ id: string; label: string; members: string[] }>;
  /** 工具栏动作（例如通过 / 退回），只在按钮当前可点时声明。 */
  actionElements?: Array<{
    id: string;
    label: string;
    value?: string;
    actions: string[];
  }>;
  /** 打开中的审批对话框：确认/取消 + 它自己的输入项（例如退回理由）。 */
  dialog?: {
    label: string;
    actions: string[];
    fields?: Array<{ id: string; label: string; value: string; editable: boolean }>;
  };
};

/**
 * 选项要带人类可读名：模型得把用户说的"河北"映射成编码。
 * 只给编码（0084/0041…）时它根本对不上，只能去别处瞎找。
 */
const optionText = (options: Array<{ value: string; label: string }>) =>
  options.map((option) =>
    option.label && option.label !== option.value
      ? `${option.label}(${option.value})`
      : option.value,
  );

export function buildWorkbenchElements(
  input: WorkbenchElementInput,
): PageElement[] {
  const elements: PageElement[] = [];
  for (const row of input.rows) {
    elements.push({
      id: `row:${row.planId}`,
      role: "row",
      label: row.label,
      value: row.value,
      actions: [
        row.expanded ? "collapse" : "expand",
        "openDetail",
        "select",
      ],
    });
  }
  if (input.detail)
    elements.push({
      id: "detail",
      role: "control",
      label: `详情抽屉（${input.detail.label}）`,
      value: input.detail.planId,
      actions: ["close"],
    });
  elements.push({
    id: "stage",
    role: "control",
    label: "审批阶段",
    value: input.stage,
    options: optionText(input.stageOptions),
    editable: true,
  });
  for (const filter of input.filters)
    elements.push({
      id: `filter:${filter.field}`,
      role: "control",
      label: filter.label,
      value: filter.value,
      ...(filter.options.length === 0
        ? {}
        : { options: optionText(filter.options) }),
      editable: true,
    });
  elements.push({
    id: "filters",
    role: "control",
    label: "筛选",
    actions: ["reset"],
  });
  elements.push({
    id: "pager",
    role: "control",
    label: `分页（共 ${input.pages} 页）`,
    value: String(input.page),
    editable: true,
  });
  for (const field of input.fields)
    elements.push({
      id: field.id,
      role: "field",
      label: field.label,
      value: field.value,
      ...(field.editable ? { editable: true } : {}),
    });
  for (const collection of input.collections)
    elements.push({
      id: collection.id,
      role: "collection",
      label: collection.label,
      members: collection.members,
    });
  for (const action of input.actionElements ?? [])
    elements.push({
      id: action.id,
      role: "control",
      label: action.label,
      ...(action.value === undefined ? {} : { value: action.value }),
      actions: action.actions,
    });
  if (input.dialog) {
    elements.push({
      id: "dialog:approval",
      role: "control",
      label: input.dialog.label,
      ...(input.dialog.actions.length === 0
        ? {}
        : { actions: input.dialog.actions }),
    });
    for (const field of input.dialog.fields ?? [])
      elements.push({
        id: field.id,
        role: "field",
        label: field.label,
        value: field.value,
        ...(field.editable ? { editable: true } : {}),
      });
  }
  return elements;
}
