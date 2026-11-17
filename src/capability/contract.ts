import { CAPABILITY_LAYERS, layersForContract, type CapabilityLayer } from "./layers.ts";

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

export type CapabilityViewProtocol = "self-report";

export type CapabilityView = {
  surface: string;
  protocol: CapabilityViewProtocol;

  pageIds: string[];
};

export type CapabilityData = {
  consumerCode: string;

  tables: string[];

  rules: string[];

  mock?: boolean;
};

export type CapabilityRouting = {
  keywords: string[];

  summary: string;
};

export type CapabilityContract = {
  enabled?: boolean;

  source?: string;
  id: string;
  label: string;
  view?: CapabilityView;
  data?: CapabilityData;

  maxEffect: CapabilityEffect;

  layers?: CapabilityLayer[];
  skills: string[];
  routing: CapabilityRouting;
};

function commonTableExpressions(sql: string): Set<string> {
  const names = new Set<string>();
  for (const match of sql.matchAll(/([a-z_][a-z0-9_]*)\s+as\s*\(/gi))
    names.add(match[1].toLowerCase());
  return names;
}

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

      if (schema !== undefined && schema !== "data_service") continue;
      if (NOT_A_TABLE.has(name) || cte.has(name)) continue;
      if (!/^agents?_/.test(name)) continue;
      tables.add(name);
    }
  }
  return [...tables].sort();
}

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

  description?: string;

  sources?: readonly string[];

  maxEffect?: CapabilityEffect;

  mock?: boolean;
};

export function contractFromPlugin(input: PluginContractInput): CapabilityContract {
  const tables = tablesFromSource(...(input.sources ?? []));
  const rules = rulesFromSkill(input.skill ?? "");
  const description = input.description;
  const maxEffect = input.maxEffect ?? "draft";
  return {
    id: input.id,
    label: input.label,
    view: {
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
    if (typeof consumerCode !== "string" || !/^[a-z][a-z0-9_-]+$/.test(consumerCode))
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
        .slice(0, 50)
    : [];
  const routingRaw =
    typeof raw.routing === "object" && raw.routing !== null
      ? (raw.routing as Record<string, unknown>)
      : {};

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
