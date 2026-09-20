/**
 * 右侧 AI 会话区文案与固定功能。
 * 来源：《销售计划 · 右侧 AI 会话区原型说明 V1》＋配套原型
 * docs/prototypes/sales-plan-conversation-prototype-v1.html（五段结构：头像与名称 / 简介 / 固定功能 4 项 / 推荐问题 4 条 / 指令输入区）。
 */
export type ConversationActionIcon =
  | "chart"
  | "alert"
  | "info"
  | "check"
  | "versions"
  | "opinion"
  | "box"
  | "users";
export type ConversationActionTone = "brand" | "info" | "success";

export type ConversationPromptAction = {
  icon: ConversationActionIcon;
  tone: ConversationActionTone;
  /** 功能标题。 */
  label: string;
  /** 一行说明。 */
  detail: string;
  /** 点击后填入输入框的内容。 */
  prompt: string;
};

export type ConversationPromptConfig = {
  name: string;
  /** 会话区顶栏名称下的副标（原型 phead 第二行）。 */
  headerSub: string;
  /** 名称下的能力标签。 */
  tagline: string;
  intro: string;
  /** 简介里加粗的边界句。 */
  boundary: string;
  actions: ConversationPromptAction[];
  prompts: string[];
};

/** 方案 A · 提报版：客户 / 代报人（KA、行销综合、业务员）的提报界面。 */
export const reportingConversation: ConversationPromptConfig = {
  name: "销售计划助手",
  headerSub: "需求预测 Agent · 提报辅助",
  tagline: "提报辅助",
  intro:
    "我可以帮你核对本月计划的合理性与风险，解释每个商品是怎么算出来的，并按你的意见调整草稿的数量与金额。",
  boundary: "最终提交仍然由你自己在确认入口完成。",
  actions: [
    {
      icon: "chart",
      tone: "brand",
      label: "看本月计划建议",
      detail: "任务头、总量建议、关键变化、风险提示",
      prompt: "看本月计划建议",
    },
    {
      icon: "alert",
      tone: "brand",
      label: "看需要重点关注的商品",
      detail: "发货概率偏低、库存或货龄偏高的商品",
      prompt: "看需要重点关注的商品",
    },
    {
      icon: "info",
      tone: "info",
      label: "解释预测依据",
      detail: "公式怎么套算、用了哪些数据、哪项没取到",
      prompt: "解释预测依据",
    },
    {
      icon: "check",
      tone: "success",
      label: "按工作台当前结果提交",
      detail: "只把你带到确认入口，不代替你提交",
      prompt: "按工作台当前结果提交",
    },
  ],
  prompts: [
    "这次预测能按现状走吗？",
    "哪些商品需要重点复核？",
    "为什么这个客户上调了？",
    "按建议帮我把数量调下来",
  ],
};

/** 方案 B · 审批版：城市经理（区域计划审批）/ 省区总 / 大区总 / 品类计划审核人的审批工作台。 */
export const approvalConversation: ConversationPromptConfig = {
  name: "销售计划审批助手",
  headerSub: "需求预测 Agent · 审批辅助",
  tagline: "审批辅助",
  intro: "我可以按你当前节点的口径核对这张计划：先给结论，再给依据，异常项逐条给处理建议。",
  boundary: "我只做分析建议，不改变审批状态。",
  actions: [
    {
      icon: "check",
      tone: "brand",
      label: "审这张单",
      detail: "结论先行：能不能直接同意，不能同意卡在哪",
      prompt: "审这张单",
    },
    {
      icon: "alert",
      tone: "brand",
      label: "看异常清理清单",
      detail: "下市与预下市、非季节品、货龄超期、需复核",
      prompt: "看异常清理清单",
    },
    {
      icon: "versions",
      tone: "info",
      label: "看双版本差异",
      detail: "最新版与上一版改了哪些客户和商品",
      prompt: "看双版本差异",
    },
    {
      icon: "opinion",
      tone: "success",
      label: "生成审批意见",
      detail: "采纳记录留痕：谁采纳、改前改后",
      prompt: "生成审批意见",
    },
  ],
  prompts: [
    "这张单能直接同意吗？",
    "哪些客户需要退回重提？",
    "汤圆品类为什么比上一版降了？",
    "省区整体达成偏乐观吗？",
  ],
};

/** 经销商补货（库存）业务页沿用原有助手文案。 */
export const inventoryConversation: ConversationPromptConfig = {
  name: "经销商补货助手",
  headerSub: "库存 Agent · 补货辅助",
  tagline: "补货辅助",
  intro: "我可以帮你分析客户库存，生成补货建议并跟进执行进度。",
  boundary: "建议只做参考，补货决策仍由你确认。",
  actions: [
    {
      icon: "box",
      tone: "brand",
      label: "查看整体库存情况",
      detail: "总库存、在途与周转概览",
      prompt: "请分析当前整体库存情况",
    },
    {
      icon: "chart",
      tone: "brand",
      label: "查看品类库存",
      detail: "各品类库存与库龄分布",
      prompt: "请查看各品类库存情况",
    },
    {
      icon: "check",
      tone: "success",
      label: "生成补货建议",
      detail: "按库存覆盖与动销给出补货量",
      prompt: "请生成本周补货建议",
    },
    {
      icon: "users",
      tone: "info",
      label: "分析重点客户",
      detail: "重点客户的库存与补货节奏",
      prompt: "请分析需要重点关注的客户",
    },
  ],
  prompts: [
    "哪些客户需要补货？",
    "重点客户的库存情况如何？",
    "生成下周的补货建议",
    "导出客户库存分析报告",
  ],
};
