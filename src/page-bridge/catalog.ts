/**
 * 页面能力目录：页面自己声明"这一屏能做什么"，桥据此生成给模型看的工具。
 *
 * 这是通用层：不出现任何具体页面/业务的名字。业务只提供一句句动作说明和参数形状，
 * 工具名、`kind` 枚举、参数表、说明文字全部由这里生成，避免每加一个页面动作
 * 就要去改工具定义和手写说明。
 *
 * 约束（同样与业务无关）：动作数量、命名、说明与参数长度都有上限；
 * 参数只允许标量，避免把复杂结构塞进模型工具。
 */

import { focusTokens, truncateText } from "@cleverc2200/dsh-agent-workbench/page-interaction/payload-budget";

export type PageActionScalarType =
  | "string"
  | "integer"
  | "number"
  | "boolean";

export type PageActionScalar = {
  type: PageActionScalarType;
  required?: boolean;
  description?: string;
  enum?: readonly string[];
};

export type PageActionParam =
  | PageActionScalar
  | {
      type: "array";
      required?: boolean;
      description?: string;
      items: { type: PageActionScalarType; description?: string };
    }
  | {
      type: "object";
      required?: boolean;
      description?: string;
      properties: Record<string, PageActionScalar>;
    };

export type PageAction = {
  /** 动作名，会作为工具 `kind` 的枚举值。 */
  name: string;
  /** 一句话说明这个动作做什么，会拼进工具说明。 */
  description: string;
  /**
   * 动作影响面：view 只改"这一屏怎么看"（默认）；data 会改业务数据。
   * 只有宿主明确放开时，data 动作才会被暴露给模型。
   */
  scope?: "view" | "data";
  /** 这个动作接受的参数。 */
  params?: Record<string, PageActionParam>;
};

export type PageCatalog = {
  /** 页面标识，宿主用白名单判断"这个页面允不允许被对话改"。 */
  surface: string;
  /** 工具名，例如 `gea_workbench_apply`。 */
  tool: string;
  /** 工具说明的总述，业务自己写"这个工具能改这一屏的什么"。 */
  description: string;
  /** 可解释意图的自由文本字段名（可选），例如 `reason`。 */
  reasonField?: string;
  /**
   * 页面自述的元素（通用写法）：模型只按元素和通用动词操作，
   * 只读元素照样列出来（能读），但不允许被改。
   */
  elements?: PageElement[];
  /** 兼容写法：页面自定义动作名（旧形状，逐步迁移到 elements）。 */
  actions?: PageAction[];
};

/** 通用动词：与页面无关，模型只会这四种操作。 */
export const PAGE_ACTION_VERBS = [
  "invoke",
  "setValue",
  "select",
  "clear",
] as const;
export type PageActionVerb = (typeof PAGE_ACTION_VERBS)[number];

export type PageElementRole = "row" | "field" | "control" | "collection";

/**
 * 元素的影响等级：draft 只改页面草稿（默认）；submit / approve 会提交或审批，
 * 必须由用户明确要求、且页面当前可点时才允许。
 */
export const PAGE_ELEMENT_EFFECTS = ["draft", "submit", "approve"] as const;
export type PageElementEffect = (typeof PAGE_ELEMENT_EFFECTS)[number];

/**
 * 页面上的一个元素。页面只声明"渲染出来、人能看见/能操作"的东西；
 * 后台状态、内部缓存、接口凭据不属于元素，不在这里出现。
 */
export type PageElement = {
  /** 稳定 id，模型下指令时引用它。 */
  id: string;
  role: PageElementRole;
  /** 人能看到的文案，模型靠它对齐用户的话。 */
  label: string;
  /** 当前值（只读元素也带，供模型读）。 */
  value?: string;
  /** 可选值（下拉/切换类控件）。 */
  options?: readonly string[];
  /** 该元素支持的操作名，invoke 只能从这里选。 */
  actions?: readonly string[];
  /** 只有 field 且 editable=true 才允许 setValue。 */
  editable?: boolean;
  /** collection 的成员元素 id（用于"这一列的字段一起改"）。 */
  members?: readonly string[];
  /** 这个元素操作下去的后果等级，缺省按草稿处理。 */
  effect?: PageElementEffect;
};

export const PAGE_CATALOG_LIMITS = {
  maxActions: 24,
  maxElements: 300,
  maxParamsPerAction: 12,
  maxNameLength: 48,
  maxDescriptionLength: 200,
  /**
   * 说明长度上限。真实页面会有几十个元素（20 行 + 筛选 + 展开行的字段），
   * 上限太小会让工具直接注册不上（页面就"不可用"）。这里给足余量，
   * 超长时由 compileElementCatalog 截断说明，绝不因为长度把工具弄没。
   */
  maxToolDescriptionLength: 20_000,
  /** 说明里最多逐条列出多少个"实例元素"（行/字段/集合）。 */
  maxListedElements: 120,
  maxEnumValues: 24,
} as const;

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
/** 页面标识允许连字符/点（例如 `gea-workbench`、`inventory.dealer`）。 */
const SURFACE_PATTERN = /^[a-z][a-z0-9._-]*$/;
/**
 * 元素 id：允许冒号分层（例如 `field:p-1:sku:1001:qty`）。
 * 迁移过来的业务页面由宿主按"行 + 表头"生成 id，表头是中文，所以这里允许中日韩文，
 * 但仍然禁止空白、引号与换行，避免 id 把工具说明的结构撑破。
 */
const ELEMENT_PATTERN = /^[A-Za-z][A-Za-z0-9:._\-\u4e00-\u9fa5]*$/;
const ELEMENT_ROLES = ["row", "field", "control", "collection"] as const;

function catalogElements(value: unknown): PageElement[] {
  if (!Array.isArray(value) || value.length > PAGE_CATALOG_LIMITS.maxElements)
    throw new Error("INVALID_PAGE_CATALOG");
  const elements: PageElement[] = value.map((raw) => {
    const element = catalogObject(raw);
    if (
      Object.keys(element).some(
        (key) =>
          key !== "id" &&
          key !== "role" &&
          key !== "label" &&
          key !== "value" &&
          key !== "options" &&
          key !== "actions" &&
          key !== "editable" &&
          key !== "members" &&
          key !== "effect",
      )
    )
      throw new Error("INVALID_PAGE_CATALOG");
    const id = catalogText(element.id, 120);
    if (!ELEMENT_PATTERN.test(id)) throw new Error("INVALID_PAGE_CATALOG");
    const role = element.role;
    if (!ELEMENT_ROLES.includes(role as (typeof ELEMENT_ROLES)[number]))
      throw new Error("INVALID_PAGE_CATALOG");
    const label = catalogText(element.label, 200);
    const text = (candidate: unknown, max: number) =>
      candidate === undefined
        ? undefined
        : catalogText(candidate, max);
    const list = (candidate: unknown, max: number): readonly string[] | undefined => {
      if (candidate === undefined) return undefined;
      if (!Array.isArray(candidate) || candidate.length > max)
        throw new Error("INVALID_PAGE_CATALOG");
      return candidate.map((item) => catalogText(item, 120));
    };
    if (element.editable !== undefined && typeof element.editable !== "boolean")
      throw new Error("INVALID_PAGE_CATALOG");
    if (
      element.effect !== undefined &&
      !(PAGE_ELEMENT_EFFECTS as readonly unknown[]).includes(element.effect)
    )
      throw new Error("INVALID_PAGE_CATALOG");
    // 可编辑 = 用户能改：输入框（field）和可选项控件（control，如下拉/分段/页码）都算。
    if (element.editable === true && role !== "field" && role !== "control")
      throw new Error("INVALID_PAGE_CATALOG");
    return {
      id,
      role: role as PageElementRole,
      label,
      ...(text(element.value, 200) === undefined
        ? {}
        : { value: text(element.value, 200) as string }),
      ...(list(element.options, PAGE_CATALOG_LIMITS.maxEnumValues) === undefined
        ? {}
        : { options: list(element.options, PAGE_CATALOG_LIMITS.maxEnumValues)! }),
      ...(list(element.actions, 8) === undefined
        ? {}
        : { actions: list(element.actions, 8)! }),
      ...(element.editable === undefined ? {} : { editable: element.editable }),
      ...(list(element.members, 300) === undefined
        ? {}
        : { members: list(element.members, 300)! }),
      ...(element.effect === undefined
        ? {}
        : { effect: element.effect as PageElementEffect }),
    };
  });
  if (new Set(elements.map((element) => element.id)).size !== elements.length)
    throw new Error("INVALID_PAGE_CATALOG");
  return elements;
}

function catalogObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("INVALID_PAGE_CATALOG");
  return value as Record<string, unknown>;
}

function catalogText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error("INVALID_PAGE_CATALOG");
  return value;
}

function catalogScalar(value: unknown): PageActionScalar {
  const param = catalogObject(value);
  const type = param.type;
  if (
    type !== "string" &&
    type !== "integer" &&
    type !== "number" &&
    type !== "boolean"
  )
    throw new Error("INVALID_PAGE_CATALOG");
  if (param.required !== undefined && typeof param.required !== "boolean")
    throw new Error("INVALID_PAGE_CATALOG");
  if (
    param.description !== undefined &&
    (typeof param.description !== "string" ||
      param.description.length > PAGE_CATALOG_LIMITS.maxDescriptionLength)
  )
    throw new Error("INVALID_PAGE_CATALOG");
  if (
    param.enum !== undefined &&
    (!Array.isArray(param.enum) ||
      param.enum.length === 0 ||
      param.enum.length > PAGE_CATALOG_LIMITS.maxEnumValues ||
      param.enum.some(
        (item) => typeof item !== "string" || !NAME_PATTERN.test(item as string),
      ))
  )
    throw new Error("INVALID_PAGE_CATALOG");
  return {
    type,
    ...(param.required === undefined ? {} : { required: param.required }),
    ...(param.description === undefined
      ? {}
      : { description: param.description as string }),
    ...(param.enum === undefined
      ? {}
      : { enum: param.enum as readonly string[] }),
  };
}

function catalogParams(value: unknown): Record<string, PageActionParam> {
  const params = catalogObject(value);
  const entries = Object.entries(params);
  if (entries.length > PAGE_CATALOG_LIMITS.maxParamsPerAction)
    throw new Error("INVALID_PAGE_CATALOG");
  const result: Record<string, PageActionParam> = {};
  for (const [name, raw] of entries) {
    if (!NAME_PATTERN.test(name)) throw new Error("INVALID_PAGE_CATALOG");
    const param = catalogObject(raw);
    if (param.type === "array") {
      const items = catalogObject(param.items);
      if (
        Object.keys(param).some(
          (key) =>
            key !== "type" &&
            key !== "required" &&
            key !== "description" &&
            key !== "items",
        )
      )
        throw new Error("INVALID_PAGE_CATALOG");
      const itemType = items.type;
      if (
        itemType !== "string" &&
        itemType !== "integer" &&
        itemType !== "number" &&
        itemType !== "boolean"
      )
        throw new Error("INVALID_PAGE_CATALOG");
      result[name] = {
        type: "array",
        ...(param.required === undefined
          ? {}
          : { required: param.required as boolean }),
        ...(param.description === undefined
          ? {}
          : { description: param.description as string }),
        items: {
          type: itemType,
          ...(items.description === undefined
            ? {}
            : { description: items.description as string }),
        },
      };
      continue;
    }
    if (param.type === "object") {
      if (
        Object.keys(param).some(
          (key) =>
            key !== "type" &&
            key !== "required" &&
            key !== "description" &&
            key !== "properties",
        )
      )
        throw new Error("INVALID_PAGE_CATALOG");
      const properties = catalogObject(param.properties);
      result[name] = {
        type: "object",
        ...(param.required === undefined
          ? {}
          : { required: param.required as boolean }),
        ...(param.description === undefined
          ? {}
          : { description: param.description as string }),
        properties: Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [
            key,
            catalogScalar(value),
          ]),
        ),
      };
      continue;
    }
    result[name] = catalogScalar(param);
  }
  return result;
}

/** 校验页面自述的能力目录；页面上报的内容一律按不可信数据处理。 */
export function validatePageCatalog(value: unknown): PageCatalog {
  const catalog = catalogObject(value);
  if (
    Object.keys(catalog).some(
      (key) =>
        key !== "surface" &&
        key !== "tool" &&
        key !== "description" &&
        key !== "reasonField" &&
        key !== "elements" &&
        key !== "actions",
    )
  )
    throw new Error("INVALID_PAGE_CATALOG");
  const surface = catalogText(catalog.surface, PAGE_CATALOG_LIMITS.maxNameLength);
  if (!SURFACE_PATTERN.test(surface)) throw new Error("INVALID_PAGE_CATALOG");
  const tool = catalogText(catalog.tool, PAGE_CATALOG_LIMITS.maxNameLength);
  if (!NAME_PATTERN.test(tool)) throw new Error("INVALID_PAGE_CATALOG");
  const description = catalogText(
    catalog.description,
    PAGE_CATALOG_LIMITS.maxToolDescriptionLength,
  );
  const reasonField =
    catalog.reasonField === undefined
      ? undefined
      : catalogText(catalog.reasonField, PAGE_CATALOG_LIMITS.maxNameLength);
  if (reasonField !== undefined && !NAME_PATTERN.test(reasonField))
    throw new Error("INVALID_PAGE_CATALOG");
  const elements =
    catalog.elements === undefined ? undefined : catalogElements(catalog.elements);
  if (catalog.actions !== undefined && !Array.isArray(catalog.actions))
    throw new Error("INVALID_PAGE_CATALOG");
  const actions: PageAction[] = (catalog.actions ?? []).map((raw) => {
    const action = catalogObject(raw);
    if (
      Object.keys(action).some(
        (key) =>
          key !== "name" &&
          key !== "description" &&
          key !== "scope" &&
          key !== "params",
      )
    )
      throw new Error("INVALID_PAGE_CATALOG");
    if (
      action.scope !== undefined &&
      action.scope !== "view" &&
      action.scope !== "data"
    )
      throw new Error("INVALID_PAGE_CATALOG");
    const name = catalogText(action.name, PAGE_CATALOG_LIMITS.maxNameLength);
    if (!NAME_PATTERN.test(name)) throw new Error("INVALID_PAGE_CATALOG");
    return {
      name,
      description: catalogText(
        action.description,
        PAGE_CATALOG_LIMITS.maxDescriptionLength,
      ),
      scope: (action.scope as "view" | "data" | undefined) ?? "view",
      ...(action.params === undefined
        ? {}
        : { params: catalogParams(action.params) }),
    };
  });
  if (new Set(actions.map((action) => action.name)).size !== actions.length)
    throw new Error("INVALID_PAGE_CATALOG");
  if (actions.length === 0 && (elements?.length ?? 0) === 0)
    throw new Error("INVALID_PAGE_CATALOG");
  if (actions.length > PAGE_CATALOG_LIMITS.maxActions)
    throw new Error("INVALID_PAGE_CATALOG");
  return {
    surface,
    tool,
    description,
    ...(reasonField === undefined ? {} : { reasonField }),
    ...(elements === undefined ? {} : { elements }),
    ...(actions.length === 0 ? {} : { actions }),
  };
}

/** 同一个参数被多个动作共用时，说明里要写清哪些动作用它。 */
function paramDescription(
  catalog: PageCatalog,
  name: string,
): string | undefined {
  const declared = catalog.actions ?? [];
  const owners = declared
    .filter((action) => action.params?.[name])
    .map((action) => action.name);
  const own = declared
    .map((action) => action.params?.[name]?.description)
    .find((text) => text !== undefined);
  if (owners.length <= 1) return own;
  return `${owners.join(" / ")} 使用：${own ?? ""}`.trim();
}

/**
 * 把目录编译成"给模型看的工具说明 + 参数表"。
 * `kind` 是动作名；其余参数按目录并集生成，出现在多个动作里就注明归属。
 */
export function compilePageCatalog(catalog: PageCatalog): {
  description: string;
  parameters: Array<{ name: string } & PageActionParam>;
} {
  if (catalog.elements) return compileElementCatalog(catalog);
  const declared = catalog.actions ?? [];
  const parameters: Array<{ name: string } & PageActionParam> = [
    {
      name: "kind",
      type: "string",
      required: true,
      enum: declared.map((action) => action.name),
      description: declared
        .map((action) => `${action.name}（${action.description}）`)
        .join("；"),
    },
  ];
  const seen = new Set<string>(["kind"]);
  for (const action of declared) {
    for (const [name, param] of Object.entries(action.params ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      const description = paramDescription(catalog, name);
      // 合并成"一个工具 + 动作枚举"时，只有 kind 是全局必填；
      // 各动作自己的必填关系写进说明，运行期由业务校验兜底。
      const requiredIn = declared
        .filter((action) => action.params?.[name]?.required === true)
        .map((action) => action.name);
      parameters.push({
        ...param,
        name,
        required: false,
        description: [description, requiredIn.length === 0 ? undefined : `${requiredIn.join(" / ")} 必填`]
          .filter((text): text is string => Boolean(text))
          .join("｜"),
      });
    }
  }
  if (catalog.reasonField !== undefined && !seen.has(catalog.reasonField)) {
    parameters.push({
      name: catalog.reasonField,
      type: "string",
      required: false,
      description: "可选：一句话说明为什么改这一屏。",
    });
  }
  const lines = declared.map((action) => {
    const params = Object.entries(action.params ?? {})
      .map(([name, param]) => `${name}${param.required ? "（必填）" : ""}`)
      .join(", ");
    return `- ${action.name}：${action.description}${params ? `｜参数：${params}` : "｜无参数"}`;
  });
  const description = `${catalog.description}\n可用的动作（kind）：\n${lines.join("\n")}`;
  if (description.length > PAGE_CATALOG_LIMITS.maxToolDescriptionLength)
    throw new Error("INVALID_PAGE_CATALOG");
  return { description, parameters };
}

/** 元素目录的说明：把"能读什么、能操作什么"直接写给模型。 */
function compileElementCatalog(catalog: PageCatalog): {
  description: string;
  parameters: Array<{ name: string } & PageActionParam>;
} {
  const elements = catalog.elements ?? [];
  const interactive = elements.filter(
    (element) =>
      element.editable === true ||
      (element.actions?.length ?? 0) > 0 ||
      element.role === "collection",
  );
  const readOnly = elements.filter((element) => !interactive.includes(element));
  const count = (effect: PageElement["effect"]) =>
    elements.filter((element) => element.effect === effect).length;
  const description = [
    catalog.description,
    "",
    // 元素目录**不写进工具说明**：它每次请求都要付一次 token。改成先要目录、按需取。
    `可操作元素 ${interactive.length} 个（可编辑 ${
      elements.filter((element) => element.editable === true).length
    }、可点 ${
      elements.filter((element) => (element.actions?.length ?? 0) > 0).length
    }、提交类 ${count("submit")}、审批类 ${count("approve")}）；只读元素 ${
      readOnly.length
    } 个。`,
    "元素目录不在说明里：先用 directory=true 取这一屏的 id、名称与当前值（只关心某几行/某字段时带 focus=用户提到的对象或字段名），拿到 id 再用 kind 操作。",
    "",
    "规则：invoke 只能执行元素列出的可执行动作；setValue 只能写「可编辑」的 field，或用 collection 一次写它的成员字段；select 只能选可操作元素；后台状态、内部缓存、接口都不在清单里，禁止臆造 id。" +
      "标了「提交类」「审批类」的元素默认不要动：只有用户这一轮明确要求提交/审批时才调用，并且必须带 confirm=true；页面没标这类元素就说明它不提供该动作，不要找别的办法绕过。",
  ].join("\n");
  // 长度兜底：宁可截断说明，也不能因为说明太长让工具注册不上。
  const bounded =
    description.length > PAGE_CATALOG_LIMITS.maxToolDescriptionLength
      ? `${description.slice(0, PAGE_CATALOG_LIMITS.maxToolDescriptionLength)}\n…（说明超长已截断；规则同上）`
      : description;
  return {
    description: bounded,
    parameters: [
      {
        name: "kind",
        type: "string",
        // directory 是"只取元素目录"的口语写法：线上实测模型会这么写，索性认它。
        enum: [...PAGE_ACTION_VERBS, "directory"],
        description:
          "invoke 执行元素动作；setValue 写可编辑字段；select 选中元素；clear 关浮层/清当前筛选；directory 只取元素目录（等价于传 directory=true）。只要目录时也可以不传 kind。",
      },
      {
        name: "target",
        type: "string",
        description: "单个元素 id（invoke 必填；setValue 也可以只写一个）",
      },
      {
        name: "targets",
        type: "array",
        items: { type: "string" },
        description: "多个元素 id（select 必填；setValue 批量改字段时用）",
      },
      {
        name: "action",
        type: "string",
        description: "invoke 使用：元素列出的可执行动作名",
      },
      {
        name: "value",
        type: "string",
        description: "setValue 使用：要写入的值",
      },
      {
        name: catalog.reasonField ?? "reason",
        type: "string",
        description: "可选：一句话说明为什么改这一屏。",
      },
      {
        name: "confirm",
        type: "boolean",
        description:
          "提交类/审批类元素必填 true，表示用户这一轮明确要求提交或审批；其它情况不要传。",
      },
      {
        name: "directory",
        type: "boolean",
        description:
          "true 时只返回这一屏的元素目录（id、名称、当前值、能不能改），不下发任何操作。",
      },
      {
        name: "focus",
        type: "string",
        description:
          "只看与这些关键词相关的行或字段（用户提到的对象名、编码、字段名）；不带 focus 默认只回摘要。",
      },
      {
        name: "values",
        type: "boolean",
        description:
          "directory=true 时带上：除字段索引外再回当前值与可选项（默认不带，省上下文）。",
      },
    ],
  };
}

/**
 * 元素目录：只读、按需、可收窄。
 *
 * 线上实测这份目录曾经有 19.8KB 被写进工具说明，每次请求都付一次；现在它只在
 * `directory=true` 时返回，并且可以按 focus 收窄、有硬上限。
 */
export function elementDirectory(
  catalog: PageCatalog,
  options: { focus?: string; limit?: number; values?: boolean } = {},
): {
  counts: {
    total: number;
    interactive: number;
    readOnly: number;
    submit: number;
    approve: number;
  };
  entries: Array<{
    id: string;
    role?: string;
    label?: string;
    value?: string;
    options?: readonly string[];
    editable?: boolean;
    actions?: readonly string[];
    effect?: PageElementEffect;
  }>;
  omitted: number;
  note: string;
} {
  const elements = catalog.elements ?? [];
  const tokens = focusTokens(options.focus);
  const limit = Math.max(1, options.limit ?? PAGE_CATALOG_LIMITS.maxListedElements);
  const interactive = (element: PageElement) =>
    element.editable === true ||
    (element.actions?.length ?? 0) > 0 ||
    element.role === "collection";
  const matched = elements.filter(
    (element) =>
      tokens.length === 0 ||
      tokens.some((token) =>
        [element.id, element.label, element.value, ...(element.options ?? [])]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(token)),
      ),
  );
  // 可操作的排前面：模型先要的是"能改什么"。
  const ordered = [
    ...matched.filter(interactive),
    ...matched.filter((element) => !interactive(element)),
  ];
  const kept = ordered.slice(0, limit);
  // 渐进式暴露：默认只回"字段索引"（id、名称、能不能改）。当前值和可选项要显式
  // 带 values=true，免得把一整屏的值塞进上下文。
  const withValues = options.values === true;
  return {
    counts: {
      total: elements.length,
      interactive: elements.filter(interactive).length,
      readOnly: elements.filter((element) => !interactive(element)).length,
      submit: elements.filter((element) => element.effect === "submit").length,
      approve: elements.filter((element) => element.effect === "approve").length,
    },
    entries: kept.map((element) => ({
      id: element.id,
      ...(element.role === undefined ? {} : { role: element.role }),
      ...(element.label === undefined ? {} : { label: truncateText(element.label, 40) }),
      ...(!withValues || element.value === undefined
        ? {}
        : { value: truncateText(element.value, 60) }),
      ...(!withValues || !element.options?.length
        ? {}
        : { options: element.options.slice(0, 20) }),
      ...(element.editable === true ? { editable: true } : {}),
      ...(element.actions?.length ? { actions: element.actions } : {}),
      ...(element.effect === undefined ? {} : { effect: element.effect }),
    })),
    omitted: ordered.length - kept.length,
    note:
      (tokens.length > 0
        ? `已按 focus「${tokens.join(" ")}」收窄目录`
        : "只回了目录，没有下发任何操作") +
      (withValues
        ? "；含当前值与可选项。"
        : "；默认只给字段索引（id／名称／能不能改），要看当前值或可选项再带 values=true，并尽量配 focus。"),
  };
}

/** 取一次调用涉及到的最高影响等级（没有元素信息时按 draft）。 */
export function pageActionEffect(
  catalog: PageCatalog,
  args: Record<string, unknown>,
): PageElementEffect {
  if (!catalog.elements) return "draft";
  const byId = new Map(catalog.elements.map((element) => [element.id, element]));
  const targets = [
    ...(typeof args.target === "string" ? [args.target] : []),
    ...(Array.isArray(args.targets)
      ? (args.targets as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : []),
  ];
  let effect: PageElementEffect = "draft";
  for (const id of targets) {
    const declared = byId.get(id)?.effect;
    if (declared === "approve") return "approve";
    if (declared === "submit") effect = "submit";
  }
  return effect;
}

/**
 * 宿主侧硬校验：只读元素不能被改，后台元素根本不存在。
 * 返回 null 表示允许，否则返回拒绝原因码。
 */
export function resolvePageAction(
  catalog: PageCatalog,
  args: Record<string, unknown>,
): string | null {
  if (!catalog.elements) return null; // 旧形状由业务自己校验
  const byId = new Map(catalog.elements.map((element) => [element.id, element]));
  const kind = typeof args.kind === "string" ? args.kind : "";
  if (!(PAGE_ACTION_VERBS as readonly string[]).includes(kind))
    return "INVALID_PAGE_ACTION";
  const one = typeof args.target === "string" ? args.target : undefined;
  const many = Array.isArray(args.targets)
    ? (args.targets as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const targets = [...(one === undefined ? [] : [one]), ...many];
  if (kind === "clear") return null;
  if (targets.length === 0) return "MISSING_TARGET";
  for (const id of targets) {
    const element = byId.get(id);
    if (!element) return "UNKNOWN_ELEMENT";
    if (kind === "setValue") {
      if (element.role === "collection") continue;
      if (
        (element.role !== "field" && element.role !== "control") ||
        element.editable !== true
      )
        return "ELEMENT_NOT_EDITABLE";
      continue;
    }
    if (kind === "invoke") {
      const action = typeof args.action === "string" ? args.action : "";
      if (!element.actions?.includes(action)) return "ACTION_NOT_ALLOWED";
      // 提交/审批类动作必须由用户明确要求：缺 confirm 一律不下发。
      if (
        (element.effect === "submit" || element.effect === "approve") &&
        args.confirm !== true
      )
        return "CONFIRMATION_REQUIRED";
      continue;
    }
    if (kind === "select") {
      if (!element.actions?.includes("select")) return "ELEMENT_NOT_SELECTABLE";
      continue;
    }
  }
  if (kind === "setValue" && typeof args.value !== "string")
    return "MISSING_VALUE";
  if (kind === "invoke" && typeof args.action !== "string")
    return "MISSING_ACTION";
  return null;
}
