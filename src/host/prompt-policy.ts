import policy from "../../presets/prompt-policy.json" with { type: "json" };

export const PROMPT_VERSION = policy.version;
export const COMMON_PROMPT = policy.common + "\n" + policy.output;
export const PROMPT_BUDGET = {
  system: 2200,
  tools: 10000,
  initial: 16000,
  target: 12000,
  result: 6000,
  calls: 20,
  evidenceCalls: 12,
  complexCalls: 40,
} as const;
export type PromptProfile = {
  label: string;
  consumerCode: string;
  persona: string;
  skills: string[];
  crossConsumers?: string[];
};
export const PROFILES: Readonly<Record<string, PromptProfile>> =
  policy.profiles;
export function profileFor(
  preset: string | undefined,
): PromptProfile | undefined {
  return preset
    ? PROFILES[
        preset === "gea-html-inventory-all" ? "gea-html-inventory-qll" : preset
      ]
    : undefined;
}

const mountedProfiles = new Set<string>();

/** Replace the existing preset's prompt with its validated Agent Manage resource. */
export function installPromptProfile(preset: string, profile: PromptProfile): () => void {
  if (mountedProfiles.has(preset)) throw Error("PROMPT_PROFILE_ALREADY_MOUNTED");
  const previous = policy.profiles[preset as keyof typeof policy.profiles];
  if (!previous || previous.consumerCode !== profile.consumerCode)
    throw Error("PROMPT_PROFILE_IDENTITY_MISMATCH");
  const profiles: Record<string, PromptProfile> = policy.profiles;
  mountedProfiles.add(preset);
  profiles[preset] = profile;
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    mountedProfiles.delete(preset);
    if (profiles[preset] === profile) profiles[preset] = previous;
  };
}

export const TOOL_PACKS = {
  page: [
    "gea_page",
    "gea_visible_workbench_context",
    "gea_workbench_apply",
    "gea_plugin_page_apply",
  ],
  knowledge: ["gea_module_mcp"],
  sales: ["gea_sales_plan_read"],
  ui: ["render_ui", "validate_dsh_ui", "visualize"],
  delegate: ["subagents_run"],
  forecast: ["gea_forecast_compute"],
} as const;
export type ToolPack = keyof typeof TOOL_PACKS;
export const CORE_TOOLS = [
  "gea_capabilities",
  "gea_skill",
  "gea_evidence_read",
  "gea_gateway_catalog",
  "gea_cube_query",
];

/** A small fixed vocabulary, not a free-form tool proxy. Existing tools retain their schemas. */
export function allowedTools(
  profile: PromptProfile,
  packs: ReadonlySet<ToolPack>,
): Set<string> {
  const names = new Set(CORE_TOOLS);
  if (profile === PROFILES["gea-readonly"]) names.add("gea_sales_plan_read");
  for (const pack of packs)
    for (const name of TOOL_PACKS[pack]) names.add(name);
  return names;
}

/** Known application prose only. Platform safety, permission and other unknown sections survive. */
const APPLICATION_SECTIONS = new Set([
  "deployment:persona-prefix",
  "deployment:persona-suffix",
  "app:web-surface",
  "app:harness-source",
  "genui:fence",
  "harness:source",
  "ui:deliverable-file-references",
  "gea:gateway-mcp-protocol",
  "gea:sales-plan-protocol",
  "gea:successful-read-evidence",
  "gea:workbench-surface",
  "tools:changed-files",
]);
export function businessSections<T extends { name: string; text: string }>(
  sections: T[],
): T[] {
  return sections.filter((section) => !APPLICATION_SECTIONS.has(section.name));
}

export function shortSkillCatalog(
  skills: { name: string; description: string }[],
): string {
  return skills
    .map((skill) => `${skill.name}：${skill.description.slice(0, 70)}`)
    .join("\n");
}

/** GenUI's sign-based colours and auto totals have no domain meaning. Require explicit business labels instead. */
export function businessUiIssue(input: unknown): string | undefined {
  let value = input;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const args = value as Record<string, unknown>;
    value = args.spec ?? args.json ?? value;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!node || typeof node !== "object") return false;
    const record = node as Record<string, unknown>;
    if (
      ["stat", "hero"].includes(String(record.type)) &&
      record.delta !== undefined
    )
      return true;
    if (
      record.type === "table" &&
      (record.total === true ||
        (Array.isArray(record.types) && record.types.includes("delta")) ||
        (Array.isArray(record.rows) &&
          record.rows.some(
            (row) =>
              Array.isArray(row) &&
              row.some(
                (cell) =>
                  typeof cell === "string" &&
                  /^[+−-]\s*[\d.]/.test(cell.trim()),
              ),
          )))
    )
      return true;
    return Object.values(record).some(visit);
  };
  return visit(value)
    ? "GEA_UI_BUSINESS_SEMANTICS: 不使用自动合计或按正负自动着色的 delta。使用已核实汇总；差额写成带业务含义的中性文字（例如“超计划 100”），需要颜色时明确业务状态。"
    : undefined;
}

export function promptMeasurement(
  system: string,
  tools: readonly unknown[],
  extras = "",
) {
  const definitions = JSON.stringify(tools);
  return {
    version: PROMPT_VERSION,
    systemChars: system.length,
    toolsChars: definitions.length,
    extraChars: extras.length,
    totalChars: system.length + definitions.length + extras.length,
    utf8Bytes: Buffer.byteLength(system + definitions + extras),
    tokenSource: "unavailable" as const,
  };
}

export const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  gea_sales_plan_read:
    "在线销售计划只读：实时审批、日志、操作前版本或用户指定的在线数据。提报/计划结果走授权Hive Cube，不作替代。周期先periods取periodId；在线汇总用aggregate；baseName是基地。金额/ID保持精确，注明覆盖。",
  gea_gateway_catalog:
    "查看所选Agent授权模型：model精确匹配优先；members定向读成员定义、单位和格式，values=true才抽样取值。已有成员直接gea_cube_query，重复目录不会补出隐藏知识。目录不替代字段/行权限。",
  gea_module_mcp:
    "调用其它受管 MCP 能力或续读产物。仅传 consumerCode 列工具，tool + schema=true 读参数，tool + arguments 执行。Cube 查询用 gea_cube_query。产物已内联则无需重读；后续片段传原 artifact 和 offset。只读，不绕过授权。",
  gea_visible_workbench_context:
    "读取当前销售工作台中与 focus 相关的可见证据。只用于用户引用当前页面的任务，结果不是全量。没有页面时不要重复调用；独立范围查询直接走数据工具。",
  gea_page:
    "读取当前绑定业务页面（action=context，focus 收窄范围），或执行它实际声明的 refresh/filter 动作；parameters 有值时是 JSON 字符串。只代表当前页面。元素操作先用本步可见的页面 apply 工具读目录；未提供的动作不可调用。",
};
