import type { PageIdentity } from "../host/page-identity.ts";

export type ChannelName = "page" | "module-mcp" | "governed-read";

export type ChannelChoice = {
  channel: ChannelName;

  tool: string;
  consumerCode?: string;
  label?: string;

  when: string;
};

export type ChannelPlan = {
  page?: ChannelChoice;

  module?: ChannelChoice;

  read?: ChannelChoice;

  note: string;
};

export type ChannelInput = {
  currentPage?: PageIdentity;

  module?: {
    consumerCode: string;
    label: string;
    readableTables?: number;
    hasModuleMcp?: boolean;
  };

  governedRead?: boolean;
};

export function channelPlan(input: ChannelInput = {}): ChannelPlan {
  const page = input.currentPage;
  const module = input.module;
  const pageChoice: ChannelChoice | undefined = page
    ? {
        channel: "page",
        tool: page.pageTool,
        consumerCode: page.consumerCode,
        label: page.label,
        when:
          `**默认不要用它**（快照会带整屏的行与字段，一进来就读会把上下文撑爆）。` +
          `只有用户这一轮明确表达了页面意图——说"这一屏 / 这几行 / 展开 / 当前选中的 / 这单 / 当前页"——` +
          `才用它生成一次快照（当前页是「${page.label}」），并把用户提到的对象或字段放进 focus。`,
      }
    : undefined;
  const moduleChoice: ChannelChoice | undefined = module
    ? {
        channel: "module-mcp",
        tool: "mcp__gea-gateway__query_business_data",
        consumerCode: module.consumerCode,
        label: module.label,
        when:
          "页面没开，或问题超出这一屏（按范围、按月、要全量）时用它：" +
          "先用 inspect_cube_model 读取实际模型与 aliasMember，再用 query_business_data 提交该模型的只读查询。身份由当前 Agent 决定，不传 consumerCode。",
      }
    : undefined;
  const governedRead = input.governedRead !== false;
  const readChoice: ChannelChoice | undefined = governedRead
    ? {
        channel: "governed-read",
        tool: "gea_plugin_read",
        ...(module === undefined ? {} : { consumerCode: module.consumerCode, label: module.label }),
        when:
          "口径、范围或跨模块的数据问题用它：先 describe=true 取表与列名，常见问题优先用契约里的 recipe。" +
          (module?.readableTables === 0
            ? "（这个模块没有登记可直读的表，只能读页面或走模块 MCP。）"
            : ""),
      }
    : undefined;
  const order = [
    pageChoice ? "①当前页" : undefined,
    moduleChoice ? "②模块 MCP" : undefined,
    readChoice ? "③受管只读" : undefined,
    !readChoice && !moduleChoice ? "②模块 MCP" : undefined,
  ].filter(Boolean);
  return {
    ...(pageChoice ? { page: pageChoice } : {}),
    ...(moduleChoice ? { module: moduleChoice } : {}),
    ...(readChoice ? { read: readChoice } : {}),
    note:
      (pageChoice
        ? "默认走模块 MCP/受管只读取数；①当前页**只在用户明确要看这一屏时**才用（快照占上下文，别一进来就读）。"
        : "") +
      (readChoice
        ? `按 ${order.join(" → ")} 选一条就够：同一条问题不要三条通道各试一遍。`
        : `按 ${order.join(" → ")} 选一条就够：同一条问题不要重复试。取数使用 query_business_data：先用 inspect_cube_model 查成员说明，再按原始 schema 查询；Consumer 由当前业务会话决定；不要尝试写 SQL。`) +
      (page?.mock ? `注意：当前页「${page.label}」是演示模块，它的数字不能当业务事实引用。` : ""),
  };
}
