/**
 * 把工作台当前这一屏"渲染出来的元素"翻译成页面桥的元素清单。
 *
 * 只描述屏幕上看得见、人能操作的东西：行、控件、可编辑字段。
 * 内部状态、缓存、接口都不进清单，所以模型也调不到。
 */
import {
  PAGE_CATALOG_LIMITS,
  type PageElement,
} from "../page-bridge/catalog.ts";

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
    /** 通过/退回这类会落审批状态的元素，标记为 approve，必须用户明确要求才执行。 */
    effect?: "submit" | "approve";
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

/**
 * 页面自述必须落在桥的硬校验里，否则整份目录会被判为 INVALID_PAGE_CATALOG：
 * 工具注册不上，这一屏对对话来说就等于"没有能力"。真实数据里客户筛选有成
 * 百项、个别 SKU 的确认量是空串，所以先在页面侧收口，而不是让宿主去放宽校验。
 * 选项只是"给模型对齐名字用"，超长时截断并在 label 里说明，值本身照样可以填。
 */
const MAX_OPTIONS = PAGE_CATALOG_LIMITS.maxEnumValues;
const withOptions = (options: Array<{ value: string; label: string }>) => {
  const all = optionText(options);
  const listed = all.slice(0, MAX_OPTIONS);
  return {
    listed,
    truncated: all.length > listed.length ? all.length : 0,
  };
};
const withCount = (label: string, total: number) =>
  `${label}（共 ${total} 项，只列出前 ${MAX_OPTIONS} 项，也可直接填名称或编码）`;
/** 空串不是合法 value（宿主按"要么没有、要么有内容"处理）。 */
const optionalValue = (value: string | undefined) => {
  const text = (value ?? "").slice(0, 200);
  return text.length === 0 ? {} : { value: text };
};
const text = (value: string, max: number) => value.slice(0, max);

export function buildWorkbenchElements(
  input: WorkbenchElementInput,
): PageElement[] {
  const elements: PageElement[] = [];
  for (const row of input.rows) {
    elements.push({
      id: `row:${row.planId}`,
      role: "row",
      label: text(row.label || row.planId, 200),
      ...optionalValue(row.value),
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
      label: text(`详情抽屉（${input.detail.label}）`, 200),
      ...optionalValue(input.detail.planId),
      actions: ["close"],
    });
  const stage = withOptions(input.stageOptions);
  elements.push({
    id: "stage",
    role: "control",
    label: "审批阶段",
    ...optionalValue(input.stage),
    ...(stage.listed.length === 0 ? {} : { options: stage.listed }),
    editable: true,
  });
  for (const filter of input.filters) {
    const options = withOptions(filter.options);
    elements.push({
      id: `filter:${filter.field}`,
      role: "control",
      label:
        options.truncated === 0
          ? text(filter.label || filter.field, 200)
          : text(withCount(filter.label || filter.field, options.truncated), 200),
      ...optionalValue(filter.value),
      ...(options.listed.length === 0 ? {} : { options: options.listed }),
      editable: true,
    });
  }
  elements.push({
    id: "filters",
    role: "control",
    label: "筛选",
    actions: ["reset"],
  });
  elements.push({
    id: "pager",
    role: "control",
    label: text(`分页（共 ${input.pages} 页）`, 200),
    value: String(input.page),
    editable: true,
  });
  for (const field of input.fields)
    elements.push({
      id: field.id,
      role: "field",
      label: text(field.label || field.id, 200),
      ...optionalValue(field.value),
      ...(field.editable ? { editable: true } : {}),
    });
  for (const collection of input.collections)
    elements.push({
      id: collection.id,
      role: "collection",
      label: text(collection.label || collection.id, 200),
      members: collection.members,
    });
  for (const action of input.actionElements ?? [])
    elements.push({
      id: action.id,
      role: "control",
      label: text(action.label || action.id, 200),
      ...optionalValue(action.value),
      actions: action.actions,
      ...(action.effect === undefined ? {} : { effect: action.effect }),
    });
  if (input.dialog) {
    elements.push({
      id: "dialog:approval",
      role: "control",
      label: text(input.dialog.label || "审批对话框", 200),
      ...(input.dialog.actions.length === 0
        ? {}
        : { actions: input.dialog.actions }),
    });
    for (const field of input.dialog.fields ?? [])
      elements.push({
        id: field.id,
        role: "field",
        label: text(field.label || field.id, 200),
        ...optionalValue(field.value),
        ...(field.editable ? { editable: true } : {}),
      });
  }
  // 展开行多的时候字段会很多：超上限时先保"控件 + 行"（动作、对话框、筛选、分页都在这里），
  // 再保集合与字段；宁可少列几个字段，也不能让整份目录判非法、工具直接注册不上。
  if (elements.length <= PAGE_CATALOG_LIMITS.maxElements) return elements;
  const keep = new Set<string>();
  for (const element of elements)
    if (element.role === "control" || element.role === "row") keep.add(element.id);
  for (const element of elements)
    if (
      keep.size < PAGE_CATALOG_LIMITS.maxElements &&
      (element.role === "collection" || element.role === "field")
    )
      keep.add(element.id);
  return elements
    .filter((element) => keep.has(element.id))
    .slice(0, PAGE_CATALOG_LIMITS.maxElements);
}
