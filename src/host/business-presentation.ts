/** Presentation preference only; never changes a query, identity, permission or source. */
export function prefersBusinessCards(question: string): boolean {
  if (/纯文字|纯文本|只用一句|只用文字|仅用文字|不要卡片|不用卡片|不需要可视化/.test(question)) return false;
  return /可视化|卡片|图表|看板|概览|情况|预测|对比|比较|分布|结构|风险|缺口|经营/.test(question);
}
