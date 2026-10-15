import { CAPABILITY_LAYERS, layersForContract, type CapabilityLayer } from "./layers.ts";

/**
 * 原生销售与 HTML 模块使用同一能力形状，声明页面、数据、最大影响等级和路由。
 * 当前 HTML 装载要求分离的 page/capability 声明，不扫描页面 SQL 或 Skill 正文。
 * contractFromPlugin 提供已校验安装元数据的基础形状，不能代替缺失的声明文件。
 */

/** 能力的影响等级：页面看得见 < 页面草稿 < 会提交 < 会审批。 */
export const CAPABILITY_EFFECTS = ["view", "draft", "submit", "approve"] as const;
export type CapabilityEffect = (typeof CAPABILITY_EFFECTS)[number];

const EFFECT_RANK: Record<CapabilityEffect, number> = {
  view: 0,
  draft: 1,
  submit: 2,
  approve: 3,
};

export function effectRank(effect: CapabilityEffect): number {
  return EFFECT_RANK[effect];
}

/** Pages publish their own elements through the current protocol. */
export type CapabilityViewProtocol = "self-report";

export type CapabilityView = {
  /** 页面桥用的页面标识，例如 `gea-workbench`、`gea-html-inventory-fc`。 */
  surface: string;
  protocol: CapabilityViewProtocol;
  /** 这个模块会注册成工作台的哪几个页面。 */
  pageIds: string[];
};

export type CapabilityData = {
  consumerCode: string;
  /** 安装能力声明提供的受管业务表；不授予服务端数据权限。 */
  tables: string[];
  /** 安装能力声明提供的业务口径，进入只读工具说明。 */
  rules: string[];
  /** 演示（mock）模块：页面里的数字是原型数据，也没有真实数据通道。 */
  mock?: boolean;
};

export type CapabilityRouting = {
  /** 首页路由用的关键词（用户话里出现就落到这个模块）。 */
  keywords: string[];

  summary: string;
};

export type CapabilityContract = {
  /** Installed capability availability, independent of page menu visibility. */
  enabled?: boolean;
  /** Installed declaration files for load diagnostics; never used as authority. */
  source?: string;
  id: string;
  label: string;
  view?: CapabilityView;
  data?: CapabilityData;
  /** 这个模块允许被对话改到的最大等级。 */
  maxEffect: CapabilityEffect;
  /**
   * 这个模块实际上有哪几层能力（读 / 改草稿 / 提交 / 审批 / 导出）。
   * 未显式提供时从页面、数据与最大等级派生；声明仍受安装模块允许等级约束。
   */
  layers?: CapabilityLayer[];
  skills: string[];
  routing: CapabilityRouting;
};

/** CTE 名字（`WITH x AS (`、`…)`），它们不是业务表。 */
function commonTableExpressions(sql: string): Set<string> {
  const names = new Set<string>();
  for (const match of sql.matchAll(/([a-z_][a-z0-9_]*)\s+as\s*\(/gi))
    names.add(match[1].toLowerCase());
  return names;
}

/** SQL 里明显不是表的词（函数、集合构造）。 */
const NOT_A_TABLE = new Set([
  "select",
  "values",
  "lateral",
  "only",
  "unnest",
  "generate_series",
  "jsonb_array_elements",
  "jsonb_to_recordset",
  "format",
]);

/**
 * 从模块自己的 SQL 里提取受管业务表。
 *
 * 只认两种形态：带 `data_service.` 前缀的（GEA 受管表的标准写法），以及不带前缀但
 * 以 `agent` / `agents` 开头的业务表；CTE 名与函数名一律排掉，避免把查询中间结果
 * 当成"可以读的表"写进给模型的说明里。
 */
export function tablesFromSource(...sources: readonly string[]): string[] {
  const tables = new Set<string>();
  for (const source of sources) {
    if (typeof source !== "string" || source.length === 0) continue;
    const cte = commonTableExpressions(source);
    for (const match of source.matchAll(
      /\b(?:from|join)\s+(?:([a-z_][a-z0-9_]*)\s*\.\s*)?("?)([a-z_][a-z0-9_]*)\2/gi,
    )) {
      const schema = match[1]?.toLowerCase();
      const name = match[3].toLowerCase();
      // 带 schema 前缀的只认 GEA 受管 schema；别的 schema 不是业务表。
      if (schema !== undefined && schema !== "data_service") continue;
      if (NOT_A_TABLE.has(name) || cte.has(name)) continue;
      if (!/^agents?_/.test(name)) continue;
      tables.add(name);
    }
  }
  return [...tables].sort();
}

/**
 * 从 SKILL.md 里摘"必须保留的口径"。
 *
 * 模块的 SKILL.md 是给它自己的 agent 看的完整提示词，直接整段塞进只读工具说明会
 * 把工具说明撑爆；这里只取标题里带口径/规则/边界的小节，且每节有长度上限。
 */
export function rulesFromSkill(
  skill: string,
  options: {
    maxSections?: number;
    maxCharsPerSection?: number;
    maxTotal?: number;
  } = {},
): string[] {
  const maxSections = options.maxSections ?? 3;
  const maxCharsPerSection = options.maxCharsPerSection ?? 600;
  const maxTotal = options.maxTotal ?? 1500;
  if (typeof skill !== "string" || skill.length === 0) return [];
  const lines = skill.split(/\r?\n/);
  const sections: string[] = [];
  let current: { wanted: boolean; body: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    if (current.wanted) {
      const body = current.body
        .join("\n")
        .replace(/\n{2,}/g, "\n")
        .trim();
      if (body) sections.push(body.slice(0, maxCharsPerSection));
    }
    current = undefined;
  };
  for (const line of lines) {
    const heading = /^#{1,6}\s*(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      current = {
        wanted: /口径|规则|边界|必须保留/.test(heading[1]),
        body: [],
      };
      continue;
    }
    if (current) current.body.push(line);
  }
  flush();
  const picked: string[] = [];
  let total = 0;
  for (const section of sections) {
    if (picked.length >= maxSections) break;
    if (total + section.length > maxTotal) break;
    picked.push(section);
    total += section.length;
  }
  return picked;
}

export type PluginContractInput = {
  id: string;
  label: string;
  consumerCode: string;
  pageIds: readonly string[];
  skill?: string;
  /** Parsed by the Agent resource owner; GEA does not parse Skill metadata. */
  description?: string;
  /** 模块自己的文本资源（index.html、脚本等），用来静态提取可读表。 */
  sources?: readonly string[];
  /** 该模块允许被对话改到的最大等级，默认只改页面草稿。 */
  maxEffect?: CapabilityEffect;
  /** 演示（mock）模块：页面数字是原型数据，也没有真实数据通道。 */
  mock?: boolean;
};

/** Derive the installed identity and permission bounds checked against required declarations. */
export function contractFromPlugin(input: PluginContractInput): CapabilityContract {
  const tables = tablesFromSource(...(input.sources ?? []));
  const rules = rulesFromSkill(input.skill ?? "");
  const description = input.description;
  const maxEffect = input.maxEffect ?? "draft";
  return {
    id: input.id,
    label: input.label,
    view: {
      // 页面标识只允许小写字母/数字/点/横线（工具名的同一套约束），所以用横线连接。
      surface: `gea-html-${input.id}`,
      protocol: "self-report",
      pageIds: [...input.pageIds],
    },
    data: {
      consumerCode: input.consumerCode,
      tables,
      rules,
      ...(input.mock === true ? { mock: true } : {}),
    },
    maxEffect,
    layers: layersForContract({ hasView: true, hasData: true, maxEffect }),
    skills: [input.id],
    routing: {
      keywords: [...new Set([input.label, input.id, ...tables])],
      summary: description ?? input.label,
    },
  };
}

/** 宿主自带的原生工作台（页面自述元素）。 */
export function workbenchContract(input: {
  enabled?: boolean;
  surface: string;
  pageIds: readonly string[];
  data?: CapabilityData;
  maxEffect?: CapabilityEffect;
  keywords?: readonly string[];
}): CapabilityContract {
  const maxEffect = input.maxEffect ?? "approve";
  return {
    id: "gea-workbench",
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    label: "区域计划审批工作台",
    view: {
      surface: input.surface,
      protocol: "self-report",
      pageIds: [...input.pageIds],
    },
    ...(input.data === undefined ? {} : { data: input.data }),
    maxEffect,
    layers: layersForContract({
      hasView: true,
      hasData: input.data !== undefined,
      maxEffect,
    }),
    skills: [],
    routing: {
      keywords: [...(input.keywords ?? [])],
      summary: "区域计划工作台：审批阶段、筛选、翻页、确认计划量草稿，以及通过/退回。",
    },
  };
}

const NAME_PATTERN = /^[a-z][a-z0-9._:-]*$/i;

/** 校验模块自己交上来的契约（不可信输入）：形状不对就整份丢掉，不猜。 */
export function normalizeContract(value: unknown): CapabilityContract {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("INVALID_CAPABILITY_CONTRACT");
  const raw = value as Record<string, unknown>;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    throw Error("INVALID_CAPABILITY_ENABLED");
  const id = raw.id;
  const label = raw.label;
  if (typeof id !== "string" || !NAME_PATTERN.test(id) || id.length > 64)
    throw new Error("INVALID_CAPABILITY_CONTRACT");
  if (typeof label !== "string" || !label.trim() || label.length > 120)
    throw new Error("INVALID_CAPABILITY_CONTRACT");
  const maxEffect = raw.maxEffect === undefined ? "draft" : raw.maxEffect;
  if (
    typeof maxEffect !== "string" ||
    !(CAPABILITY_EFFECTS as readonly string[]).includes(maxEffect)
  )
    throw new Error("INVALID_CAPABILITY_CONTRACT");
  const view = raw.view;
  let normalizedView: CapabilityView | undefined;
  if (view !== undefined) {
    if (typeof view !== "object" || view === null || Array.isArray(view))
      throw new Error("INVALID_CAPABILITY_CONTRACT");
    const candidate = view as Record<string, unknown>;
    const surface = candidate.surface;
    const protocol = candidate.protocol;
    const pageIds = candidate.pageIds;
    if (typeof surface !== "string" || !NAME_PATTERN.test(surface))
      throw new Error("INVALID_CAPABILITY_CONTRACT");
    if (protocol !== "self-report") throw new Error("INVALID_CAPABILITY_CONTRACT");
    if (!Array.isArray(pageIds) || pageIds.some((page) => typeof page !== "string"))
      throw new Error("INVALID_CAPABILITY_CONTRACT");
    normalizedView = {
      surface,
      protocol,
      pageIds: (pageIds as string[]).slice(0, 50),
    };
  }
  const data = raw.data;
  let normalizedData: CapabilityData | undefined;
  if (data !== undefined) {
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new Error("INVALID_CAPABILITY_CONTRACT");
    const candidate = data as Record<string, unknown>;
    const consumerCode = candidate.consumerCode;
    if (typeof consumerCode !== "string" || !/^[a-z][a-z0-9-]+$/.test(consumerCode))
      throw new Error("INVALID_CAPABILITY_CONTRACT");
    const tables = Array.isArray(candidate.tables)
      ? (candidate.tables as unknown[]).filter(
          (table): table is string => typeof table === "string" && /^agents?_/.test(table),
        )
      : [];
    const rules = Array.isArray(candidate.rules)
      ? (candidate.rules as unknown[])
          .filter((rule): rule is string => typeof rule === "string")
          .slice(0, 5)
          .map((rule) => rule.slice(0, 800))
      : [];
    normalizedData = {
      consumerCode,
      tables: tables.slice(0, 200),
      rules,
      ...(candidate.mock === true ? { mock: true } : {}),
    };
  }
  const skills = Array.isArray(raw.skills)
    ? (raw.skills as unknown[])
        .filter((skill): skill is string => typeof skill === "string")
        .slice(0, 10)
    : [];
  const routingRaw =
    typeof raw.routing === "object" && raw.routing !== null
      ? (raw.routing as Record<string, unknown>)
      : {};
  // layersForContract 统一归一化显式层与页面、数据和影响等级，安装声明另受装载上限约束。
  const declaredLayers = Array.isArray(raw.layers)
    ? (raw.layers as unknown[]).filter(
        (layer): layer is CapabilityLayer =>
          typeof layer === "string" && (CAPABILITY_LAYERS as readonly string[]).includes(layer),
      )
    : [];
  const keywords = Array.isArray(routingRaw.keywords)
    ? (routingRaw.keywords as unknown[])
        .filter((keyword): keyword is string => typeof keyword === "string")
        .slice(0, 50)
        .map((keyword) => keyword.slice(0, 40))
    : [];
  return {
    id,
    label,
    ...(raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean }),
    ...(normalizedView === undefined ? {} : { view: normalizedView }),
    ...(normalizedData === undefined ? {} : { data: normalizedData }),
    maxEffect: maxEffect as CapabilityEffect,
    layers: layersForContract({
      hasView: normalizedView !== undefined,
      hasData: normalizedData !== undefined,
      maxEffect: maxEffect as CapabilityEffect,
      declared: declaredLayers,
    }),
    skills,
    routing: {
      keywords,
      summary: typeof routingRaw.summary === "string" ? routingRaw.summary.slice(0, 300) : label,
    },
  };
}
