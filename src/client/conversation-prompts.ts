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
  /** 会话区顶栏名称：统一用「功能模块名 + Agent」，和左侧菜单保持一致；不再挂副标。 */
  name: string;
  intro: string;
  /** 简介里加粗的边界句。 */
  boundary: string;
  actions: ConversationPromptAction[];
  prompts: string[];
};

/** 方案 A · 提报版：客户 / 代报人（KA、行销综合、业务员）的提报界面。 */
export const reportingConversation: ConversationPromptConfig = {
  name: "销售计划Agent",
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
  name: "销售计划Agent",
  intro: "我可以按你当前节点的口径核对这张计划：先给结论，再给依据，异常项逐条给处理建议。",
  boundary: "分析默认只读；按你的明确要求操作已开放页面，审批须有权限并以系统回执为准。",
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

/** 主生产计划（MPS）：统一 Agent 命名，保留原型定位与推荐问题。 */
export const mpsPlanConversation: ConversationPromptConfig = {
  name: "主生产计划Agent",
  intro: "我按链路口径帮你核对月计划：三路需求是否齐备、主数据与约束是否就位，缺口和调拨拆分该怎么看。",
  boundary: "只出建议、不改计划；正式计划仍以月计划编制流程为准。",
  actions: [],
  prompts: [
    "生成 10 月滚动计划初稿",
    "看各基地 M+2 产能",
    "三路需求对不上的地方",
    "M+2 缺口怎么处置",
    "这个月调拨品拆分规则",
  ],
};

/** 经销商补货（库存）业务页沿用原有助手文案。 */
export const regionalPlanConversation: ConversationPromptConfig = {
  name: "区域计划Agent",
  intro: "我可以跨模块盯提报进度、找异常，给提报与跟催的参考意见。",
  boundary: "区域计划不参与审批与退回，我只做跟踪、评估与跟催。",
  actions: [
    {
      icon: "chart",
      tone: "brand",
      label: "看提报与跟催",
      detail: "待跟进事件与四维提报 / 审批下钻",
      prompt: "看提报与跟催",
    },
    {
      icon: "box",
      tone: "brand",
      label: "看品类达成",
      detail: "品类达成与品类 × 大区分布",
      prompt: "看品类达成",
    },
    {
      icon: "info",
      tone: "info",
      label: "看复盘与达成",
      detail: "三个月提报偏差、达成率与偏差象限",
      prompt: "看复盘与达成",
    },
    {
      icon: "alert",
      tone: "success",
      label: "看分析与异常",
      detail: "期间研判建议与跨模块异常清单",
      prompt: "看分析与异常",
    },
  ],
  prompts: [
    "本月还有哪些客户未提报？",
    "哪个品类达成最低？",
    "哪个审批节点滞留最多？",
    "哪些客户的达成偏差最大？",
  ],
};

/** 品类计划工作台：文案沿用原型内的「品类计划助手」（简介 / 4 项固定功能 / 4 条推荐问题）。 */
export const categoryPlanConversation: ConversationPromptConfig = {
  name: "品类计划Agent",
  intro:
    "我按品类计划在管的指标组织事实：原始订单满足率、需求计划准确率、库存周转天数、全链周转与产品新鲜度，并说明每一项未达标的驱动原因。",
  boundary: "负责预警与建议，人来决策与授权。",
  actions: [
    {
      icon: "chart",
      tone: "brand",
      label: "查看品类计划在管的指标",
      detail: "点击任意指标查看口径与明细",
      prompt: "查看品类计划在管哪些指标",
    },
    {
      icon: "alert",
      tone: "brand",
      label: "订单满足率的缺口在哪",
      detail: "未满足订单的成因与短缺客户",
      prompt: "订单满足率的缺口在哪里",
    },
    {
      icon: "info",
      tone: "info",
      label: "计划准确率为什么没达标",
      detail: "偏差来源、上报记录与目标未报备",
      prompt: "需求计划准确率为什么没达标",
    },
    {
      icon: "box",
      tone: "success",
      label: "周转天数与新鲜度",
      detail: "全链周转、工厂仓周转与超期批次",
      prompt: "库存周转天数与产品新鲜度怎么样",
    },
  ],
  prompts: [
    "粽子缺口对订单满足率影响多大？",
    "库存周转差 0.7 天卡在哪？",
    "产品新鲜度低于目标怎么办？",
    "全链周转目标为什么没备案？",
  ],
};

/** 经销商补货（库存）业务页沿用原有助手文案。 */
export const inventoryConversation: ConversationPromptConfig = {
  name: "经销商补货Agent",
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

/** AI 工作台首页：没有打开具体业务页时的通用助手。 */
export const homeConversation: ConversationPromptConfig = {
  name: "AI 工作台Agent",
  intro: "我可以从你正在解决的问题入手：找数据、看计划进度、盯库存和交付风险。",
  boundary: "所有动作先给建议，再由你确认。",
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
      icon: "box",
      tone: "info",
      label: "看库存与供应风险",
      detail: "库存、在途与缺货风险",
      prompt: "看库存与供应风险",
    },
    {
      icon: "users",
      tone: "success",
      label: "看客户提报与审批进度",
      detail: "到哪一步、卡在谁手里",
      prompt: "看客户提报与审批进度",
    },
  ],
  prompts: [
    "本月哪些客户还没提报？",
    "哪些商品需要重点复核？",
    "现在最需要关注的风险是什么？",
    "你能帮我做什么？",
  ],
};

/** 业务待办页：GEA 消息待办与审批提醒。 */
export const inboxConversation: ConversationPromptConfig = {
  name: "业务待办Agent",
  intro: "我可以帮你看 GEA 消息待办：还有多少没处理、哪些卡在你这一节点、下一步该找谁。",
  boundary: "待办状态由你在列表里确认，我只做梳理和建议。",
  actions: [
    {
      icon: "check",
      tone: "brand",
      label: "看未读待办",
      detail: "按业务类型与时间排序的未读消息",
      prompt: "看未读待办",
    },
    {
      icon: "alert",
      tone: "brand",
      label: "看卡在我这的审批",
      detail: "当前节点等处理的计划",
      prompt: "看卡在我这的审批",
    },
    {
      icon: "chart",
      tone: "info",
      label: "看待办分布",
      detail: "按业务类型、状态、来源汇总",
      prompt: "看待办分布",
    },
    {
      icon: "info",
      tone: "success",
      label: "看处理优先级",
      detail: "按通知时间给出先处理谁",
      prompt: "看处理优先级",
    },
  ],
  prompts: [
    "有多少待办还没处理？",
    "哪些审批卡在我这一节点？",
    "今天我应该先处理哪些？",
    "这些待办分别是哪个客户的？",
  ],
};

/** 需求运营管理页：需求信号研判。 */
export const demandOpsConversation: ConversationPromptConfig = {
  name: "需求运营Agent",
  intro: "我可以帮你看需求波动、预测偏差和需求共识待办，给出下期需求计划的调整参考。",
  boundary: "我只做研判与建议，不直接改预测数字。",
  actions: [
    {
      icon: "chart",
      tone: "brand",
      label: "看需求波动概览",
      detail: "预测准确率、偏差率、需求变更率",
      prompt: "看需求波动概览",
    },
    {
      icon: "alert",
      tone: "brand",
      label: "看品类偏差明细",
      detail: "按绝对偏差排序的品类预测与实际",
      prompt: "看品类偏差明细",
    },
    {
      icon: "check",
      tone: "success",
      label: "看需求共识待办",
      detail: "销售、市场与计划待确认的协同动作",
      prompt: "看需求共识待办",
    },
    {
      icon: "info",
      tone: "info",
      label: "看活动纳入率",
      detail: "促销活动是否已经进入需求计划",
      prompt: "看活动纳入率",
    },
  ],
  prompts: [
    "本周需求波动怎么样？",
    "哪些品类偏差最大？",
    "火锅料为什么低于预测？",
    "需求共识待办要谁确认？",
  ],
};

/** 交付运营管理页：订单履约风险。 */
export const deliveryOpsConversation: ConversationPromptConfig = {
  name: "交付运营Agent",
  intro: "我可以帮你看订单履约：准交率、在途订单和重点客户延期，给出优先处理顺序。",
  boundary: "我只做风险研判与建议，不下发派车、不改订单。",
  actions: [
    {
      icon: "alert",
      tone: "brand",
      label: "看交付风险概览",
      detail: "风险订单、重点客户、准交率缺口",
      prompt: "看交付风险概览",
    },
    {
      icon: "box",
      tone: "brand",
      label: "看重点交付订单",
      detail: "按承诺时间与客户等级排序",
      prompt: "看重点交付订单",
    },
    {
      icon: "chart",
      tone: "info",
      label: "看履约链路分布",
      detail: "待分配→待备货→待装车→运输中→已签收",
      prompt: "看履约链路分布",
    },
    {
      icon: "check",
      tone: "success",
      label: "看订单满足率",
      detail: "订单满足率与目标的差距",
      prompt: "看订单满足率",
    },
  ],
  prompts: [
    "今天哪些订单有延期风险？",
    "准交率为什么没达标？",
    "郑州装车延迟影响哪些客户？",
    "重点客户的订单什么时候能到？",
  ],
};

/** 安全库存页：基地口径的库存水位与货龄。 */
export const safetyStockConversation: ConversationPromptConfig = {
  name: "基地库存Agent",
  intro: "我可以按基地口径核对库存水位、周转天数、货龄和订单满足率，指出低于目标的部分。",
  boundary: "我只做核对与建议，不调整库存目标。",
  actions: [
    {
      icon: "box",
      tone: "brand",
      label: "看库存水位差额",
      detail: "当前库存、目标库存与周转天数",
      prompt: "看库存水位差额",
    },
    {
      icon: "alert",
      tone: "brand",
      label: "看超龄与货龄",
      detail: "超龄 SKU 数、超龄库存与平均货龄",
      prompt: "看超龄与货龄",
    },
    {
      icon: "chart",
      tone: "info",
      label: "看基地与品类结构",
      detail: "基地、品类、货龄三个结构",
      prompt: "看基地与品类结构",
    },
    {
      icon: "check",
      tone: "success",
      label: "看订单满足率",
      detail: "当月订单满足率最低的基地",
      prompt: "看订单满足率",
    },
  ],
  prompts: [
    "哪些基地库存低于目标？",
    "哪个基地货龄最高？",
    "超龄 SKU 有多少？",
    "订单满足率最低的是谁？",
  ],
};

/** 分仓库存页：分仓经营与补货。 */
export const branchStockConversation: ConversationPromptConfig = {
  name: "分仓库存Agent",
  intro: "我可以按分仓看缺货订单、补货确认、大日期和滞库风险，给出先处理谁的建议。",
  boundary: "补货只给建议，是否下单由你确认。",
  actions: [
    {
      icon: "alert",
      tone: "brand",
      label: "看缺货订单",
      detail: "缺货量、订单数与影响分仓",
      prompt: "看缺货订单",
    },
    {
      icon: "box",
      tone: "brand",
      label: "看补货确认明细",
      detail: "已核实建议补货量与紧急补货",
      prompt: "看补货确认明细",
    },
    {
      icon: "chart",
      tone: "info",
      label: "看大日期与滞库",
      detail: "大日期库存与滞库风险清单",
      prompt: "看大日期与滞库",
    },
    {
      icon: "check",
      tone: "success",
      label: "看分仓满足率",
      detail: "当月订单满足率与发货缺口",
      prompt: "看分仓满足率",
    },
  ],
  prompts: [
    "哪些分仓缺货最严重？",
    "长沙分仓周转为什么高？",
    "大日期库存怎么消化？",
    "这周分仓给多少补货？",
  ],
};

/** 库存管理工作台：基地 + 分仓的今日运营。 */
export const inventoryWorkbenchConversation: ConversationPromptConfig = {
  name: "库存管理Agent",
  intro: "我可以把基地和分仓的今日运营情况汇总起来，按优先级说清今天先处理什么。",
  boundary: "我只做汇总和建议，处理动作仍由你和责任角色确认。",
  actions: [
    {
      icon: "chart",
      tone: "brand",
      label: "看今日运营概况",
      detail: "库存、缺货、货龄的当日快照",
      prompt: "看今日运营概况",
    },
    {
      icon: "alert",
      tone: "brand",
      label: "看今日优先处理事项",
      detail: "缺货、低库存、货龄、大日期、滞库",
      prompt: "看今日优先处理事项",
    },
    {
      icon: "box",
      tone: "info",
      label: "看缺货与低库存",
      detail: "按对象列出缺口与建议动作",
      prompt: "看缺货与低库存",
    },
    {
      icon: "users",
      tone: "success",
      label: "看责任角色与反馈",
      detail: "谁在跟、反馈到哪一步",
      prompt: "看责任角色与反馈",
    },
  ],
  prompts: [
    "今天我最该先处理什么？",
    "哪些基地缺货？",
    "大日期库存有多少？",
    "给我一份今日跟进清单",
  ],
};

/** 全链路库存页：基地到分仓的链路视角。 */
export const fullChainStockConversation: ConversationPromptConfig = {
  name: "全链库存管理Agent",
  intro: "我可以沿基地到分仓的链路看库存分布、缺货和大日期风险，以及可调拨的机会。",
  boundary: "调拨只给方案建议，执行由业务确认。",
  actions: [
    {
      icon: "box",
      tone: "brand",
      label: "看全链库存概览",
      detail: "基地与分仓的库存分布",
      prompt: "看全链库存概览",
    },
    {
      icon: "chart",
      tone: "brand",
      label: "看各节点库存",
      detail: "按基地、分仓看库存与周转",
      prompt: "看各节点库存",
    },
    {
      icon: "alert",
      tone: "info",
      label: "看缺货与大日期风险",
      detail: "全链路缺货与临期风险清单",
      prompt: "看缺货与大日期风险",
    },
    {
      icon: "check",
      tone: "success",
      label: "看跨仓调拨机会",
      detail: "富余与短缺节点的匹配建议",
      prompt: "看跨仓调拨机会",
    },
  ],
  prompts: [
    "全链路库存分布怎么样？",
    "哪些 SKU 有缺货风险？",
    "基地到分仓的库存怎么走？",
    "需要跨仓调拨哪些货？",
  ],
};

/** 产销协同页：经营计划、库存与履约的跨模块视角。 */
export const supplyCoordinationConversation: ConversationPromptConfig = {
  name: "产销协同Agent",
  intro: "我可以结合计划、库存与订单履约，定位当前产销协同中的偏差和风险。",
  boundary: "我只做分析与行动建议，不直接修改业务数据。",
  actions: [
    { icon: "chart", tone: "brand", label: "看经营概览", detail: "计划、库存与履约关键指标", prompt: "请分析当前产销经营概览" },
    { icon: "alert", tone: "brand", label: "看协同风险", detail: "偏离目标和需要协调的事项", prompt: "请查看当前产销协同风险" },
    { icon: "box", tone: "info", label: "看库存与订单", detail: "库存水位和订单履约异常", prompt: "请分析库存与订单风险" },
    { icon: "check", tone: "success", label: "生成行动建议", detail: "按优先级整理协同动作", prompt: "请生成产销协同行动建议" },
  ],
  prompts: ["哪些指标偏离目标？", "订单满足率近3个月的指标情况如何？", "可发货天数异常的产品有哪些？", "目前哪一个产品缺货较为严重"],
};

/** 客户库存页：客户库存健康度、周转与大日期风险。 */
export const customerStockConversation: ConversationPromptConfig = {
  name: "客户库存Agent",
  intro: "我可以帮你分析客户库存健康度、周转和大日期风险，并给出改善建议。",
  boundary: "建议只做参考，库存处置仍由业务确认。",
  actions: [
    { icon: "box", tone: "brand", label: "看客户库存", detail: "库存规模、结构与周转概览", prompt: "请分析当前客户库存情况" },
    { icon: "alert", tone: "brand", label: "看风险客户", detail: "高库存、低周转与异常客户", prompt: "请查看高风险客户" },
    { icon: "chart", tone: "info", label: "看大日期库存", detail: "临期与大日期库存分布", prompt: "请查看客户大日期库存" },
    { icon: "check", tone: "success", label: "生成改善建议", detail: "按客户整理优先动作", prompt: "请生成客户库存改善建议" },
  ],
  prompts: ["哪些客户库存风险最高？", "重点客户的库存情况如何？", "大日期库存如何处理？", "客户库存结构怎么改善？"],
};

/** 订单工作台：订单状态、供应风险与提报审批进度。 */
export const orderManagementConversation: ConversationPromptConfig = {
  name: "订单管理Agent",
  intro: "我可以帮你分析订单状态、库存与供应风险，并跟进客户提报和审批进度。",
  boundary: "我只做分析和建议，不直接修改订单。",
  actions: [
    { icon: "chart", tone: "brand", label: "看订单概览", detail: "订单规模、状态与关键变化", prompt: "请分析当前订单概览" },
    { icon: "alert", tone: "brand", label: "看重点商品", detail: "需要优先关注的商品和原因", prompt: "请查看需要重点关注的商品" },
    { icon: "box", tone: "info", label: "看库存与供应风险", detail: "订单关联的缺货与供应异常", prompt: "请分析订单相关的库存与供应风险" },
    { icon: "check", tone: "success", label: "跟进提报审批", detail: "客户提报与审批进度", prompt: "请查看客户提报与审批进度" },
  ],
  prompts: ["本月订单情况如何？", "哪些商品需要重点关注？", "当前最需要关注的风险是什么？", "客户提报和审批进度如何？"],
};

/** 订单履约页：接收、校验与 OMS 推送进度。 */
export const orderFulfillmentConversation: ConversationPromptConfig = {
  name: "订单履约Agent",
  intro: "我可以帮你跟进订单接收、校验与 OMS 推送进度，定位履约异常。",
  boundary: "我只做风险分析和处理建议，不直接推送订单。",
  actions: [
    { icon: "chart", tone: "brand", label: "看履约进度", detail: "订单接收、校验与推送状态", prompt: "请分析当前订单履约进度" },
    { icon: "alert", tone: "brand", label: "看校验异常", detail: "规则、商品与客户信息异常", prompt: "请查看订单校验异常" },
    { icon: "box", tone: "info", label: "看待推送订单", detail: "等待生成或推送 OMS 的订单", prompt: "请查看待推送 OMS 的订单" },
    { icon: "check", tone: "success", label: "生成处理建议", detail: "按影响范围整理处理顺序", prompt: "请生成订单履约处理建议" },
  ],
  prompts: ["当前订单履约进度如何？", "哪些订单校验异常？", "有哪些订单等待推送？", "下一步应优先处理什么？"],
};
