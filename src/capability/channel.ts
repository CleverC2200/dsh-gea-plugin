/**
 * 通道路由：宿主替模型把"这一场该按什么顺序选通道"算出来。
 *
 * 三条通道本来写在工具说明里让模型自己选，线上实测两次翻车都在"选"这一步：页面上
 * 有九个模块的页面工具，模型挑了不是当前页的那个；或者拿着能读的模块去换表猜。
 * 宿主已经知道当前页是谁、哪些模块能读，这里把它算成一个明确的顺序交出去。
 *
 * 只算"该用什么"，不认识任何具体业务，也不执行任何动作。
 */
import type { PageIdentity } from "../host/page-identity.ts";

export type ChannelName = "page" | "module-mcp" | "governed-read";

export type ChannelChoice = {
  channel: ChannelName;
  /** 该用的工具名。 */
  tool: string;
  consumerCode?: string;
  label?: string;
  /** 什么时候用它（写给模型看的一句话）。 */
  when: string;
};

export type ChannelPlan = {
  /** 问"这一屏 / 这几行 / 当前选中的对象"时用；页面没开就没有这一条。 */
  page?: ChannelChoice;
  /** 命中模块、且模块自带受管查询时用。 */
  module?: ChannelChoice;
  /** 兜底：受管只读（sql / recipe / describe）；问答侧关掉 SQL 时没有这一条。 */
  read?: ChannelChoice;
  /** 选择顺序（一句话）。 */
  note: string;
};

export type ChannelInput = {
  /** 宿主侧的当前页身份（page-identity.ts）。 */
  currentPage?: PageIdentity;
  /** 已经命中的模块；不知道就只给页面与兜底。 */
  module?: {
    consumerCode: string;
    label: string;
    readableTables?: number;
    hasModuleMcp?: boolean;
  };
  /**
   * 问答侧是否还允许调用受管只读 SQL（`/ai/gateway/sql/execute`）。
   * 默认允许；关掉之后取数只剩页面证据和模块 MCP 两条路。
   */
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
