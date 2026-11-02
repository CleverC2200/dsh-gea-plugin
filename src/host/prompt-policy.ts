import { currentShortageResource } from "./current-shortage-contract.ts";
import policy from "../../presets/execution-policy.json" with { type: "json" };

export const PROMPT_VERSION = policy.version;
export const PROMPT_BUDGET = {
  system: 2200,
  tools: 10000,
  initial: 16000,
  target: 12000,
  result: 6000,
} as const;
export type PromptProfile = {
  label: string;
  /** Trusted Agent catalog metadata, independent of the business page title. */
  presetName?: string;
  description?: string;
  consumerCode: string;
  skills: string[];
  crossConsumers?: string[];
};
export const PROFILES: Readonly<Record<string, PromptProfile>> = policy.profiles;
export function profileFor(preset: string | undefined): PromptProfile | undefined {
  return preset ? PROFILES[preset] : undefined;
}

const mountedProfiles = new Set<string>();

/** Mount a validated Agent Manage resource; an existing identity cannot be overwritten. */
export function installPromptProfile(preset: string, profile: PromptProfile): () => void {
  if (mountedProfiles.has(preset)) throw Error("PROMPT_PROFILE_ALREADY_MOUNTED");
  const previous = policy.profiles[preset as keyof typeof policy.profiles];
  if (previous && previous.consumerCode !== profile.consumerCode)
    throw Error("PROMPT_PROFILE_IDENTITY_MISMATCH");
  const profiles: Record<string, PromptProfile> = policy.profiles;
  mountedProfiles.add(preset);
  profiles[preset] = profile;
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    mountedProfiles.delete(preset);
    if (profiles[preset] === profile) {
      if (previous) profiles[preset] = previous;
      else delete profiles[preset];
    }
  };
}

/** GEA owns actual business execution. Optional UI tools keep their Host registration and user-setting guards. */
export const CORE_TOOLS = [
  "gea_capabilities",
  "gea_evidence_read",
  "mcp__gea-gateway__inspect_cube_model",
  "mcp__gea-gateway__query_business_data",
  "mcp__gea-gateway__weknora_list_knowledge_bases",
  "mcp__gea-gateway__weknora_ask",
  "gea_visible_workbench_context",
];
export function allowedTools(profile: PromptProfile, pageTool?: string): Set<string> {
  const names = new Set(CORE_TOOLS);
  if (currentShortageResource(profile.consumerCode)) names.add("gea_current_shortage");
  if (profile.consumerCode === "base-safety-stock") names.add("gea_base_inventory");
  if (profile.consumerCode === "branch-inventory") names.add("gea_branch_inventory");
  for (const name of [
    "skill",
    "skill_reference_read",
    "forecast_compute",
    "render_ui",
    "validate_dsh_ui",
    "visualize",
    "sidebar_open",
  ])
    names.add(name);
  if (pageTool) names.add(pageTool);
  if (pageTool === "gea_page") names.add("gea_plugin_page_apply");
  if (profile === PROFILES["gea-readonly"]) names.add("gea_sales_plan_read");
  return names;
}

export function promptMeasurement(system: string, tools: readonly unknown[], extras = "") {
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
    "在线销售计划只读：实时审批、日志、操作前版本或用户指定的在线数据。提报/计划结果走授权Hive Cube，不作替代。周期先periods取periodId；在线汇总用aggregate；baseName是基地。金额/ID保持精确，注明覆盖。versionSkus首次用versionId及pageSize；未读完时将返回的nextQuery原样作为query续读，直到nextQuery=null。",
  gea_visible_workbench_context:
    "读取当前销售工作台中与 focus 相关的可见证据。只用于用户引用当前页面的任务，结果不是全量。没有页面时不要重复调用；独立范围查询直接走数据工具。",
  gea_page:
    "读取当前绑定业务页面（action=context，focus 收窄范围），或执行它实际声明的 refresh/filter 动作；parameters 有值时是 JSON 字符串。只代表当前页面。元素操作先用本步可见的页面 apply 工具读目录；未提供的动作不可调用。",
};
