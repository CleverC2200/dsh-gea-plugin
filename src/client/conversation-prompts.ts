/**
 * 右侧 AI 会话区文案。
 * 销售计划两版文案来源：《销售计划 · 右侧 AI 会话区原型说明 V1》（提报版 / 审批版），
 * 原型见 docs/prototypes/sales-plan-conversation-prototype-v1.html。
 */
export type ConversationPromptAction = {
  icon: string;
  label: string;
  /** 点击后填入输入框的内容。 */
  prompt: string;
};

export type ConversationPromptConfig = {
  name: string;
  intro: string;
  actions: ConversationPromptAction[];
  prompts: string[];
};

/** 方案 A · 提报版：客户 / 代报人（KA、行销综合、业务员）的提报界面。 */
export const reportingConversation: ConversationPromptConfig = {
  name: "销售计划助手",
  intro:
    "我可以帮你核对本月计划的合理性与风险，解释每个商品是怎么算出来的，并按你的意见调整草稿的数量与金额。最终提交仍然由你自己在确认入口完成。",
  actions: [
    { icon: "▦", label: "看本月计划建议", prompt: "看本月计划建议" },
    { icon: "◔", label: "看需要重点关注的商品", prompt: "看需要重点关注的商品" },
    { icon: "∑", label: "解释预测依据", prompt: "解释预测依据" },
    { icon: "➔", label: "按工作台当前结果提交", prompt: "按工作台当前结果提交" },
  ],
  prompts: [
    "这次预测能按现状走吗？",
    "哪些商品需要重点复核？",
    "为什么这个客户上调了？",
    "按建议帮我把数量调下来",
  ],
};

/** 方案 B · 审批版：城市经理 / 省区总 / 大区总 / 品类计划各节点审核人的审批工作台。 */
export const approvalConversation: ConversationPromptConfig = {
  name: "销售计划审批助手",
  intro:
    "我可以按你当前节点的口径核对这张计划：先给结论，再给依据，异常项逐条给处理建议。我只做分析建议，不改变审批状态。",
  actions: [
    { icon: "✓", label: "审这张单", prompt: "审这张单：先给结论，再给依据" },
    { icon: "⚠", label: "看异常清理清单", prompt: "看异常清理清单" },
    { icon: "⇄", label: "看双版本差异", prompt: "看双版本差异" },
    { icon: "✎", label: "生成审批意见", prompt: "生成审批意见" },
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
  intro: "我可以帮你分析客户库存，生成补货建议并跟进执行进度",
  actions: [
    { icon: "▥", label: "查看整体库存情况", prompt: "请分析当前整体库存情况" },
    { icon: "◔", label: "查看品类库存", prompt: "请查看各品类库存情况" },
    { icon: "▤", label: "生成补货建议", prompt: "请生成本周补货建议" },
    { icon: "♧", label: "分析重点客户", prompt: "请分析需要重点关注的客户" },
  ],
  prompts: [
    "哪些客户需要补货？",
    "重点客户的库存情况如何？",
    "生成下周的补货建议",
    "导出客户库存分析报告",
  ],
};
