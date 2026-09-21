/**
 * V1.8 #14：差额配色口径——正数红、负数绿，颜色只作用于差额数值本身，正负号保留。
 * 与达成率的阈值分档（D23）是两套独立口径（D24 推荐），这里只负责差额。
 */
export type SalesPlanVarianceSign = 'positive' | 'negative' | 'zero';

const EXACT_DECIMAL = /^-?\d+(?:\.\d+)?$/;
const EXACT_ZERO = /^-?0(?:\.0+)?$/;

/** 只有合法的十进制差额才有符号；缺值（如「—」）不下结论，交给调用方保持中性。 */
export const salesPlanVarianceSign = (value: string | null | undefined): SalesPlanVarianceSign | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!EXACT_DECIMAL.test(text)) return undefined;
  if (EXACT_ZERO.test(text)) return 'zero';
  return text.startsWith('-') ? 'negative' : 'positive';
};

/** 正数用红色类、负数用绿色类；零和缺值不加类，保持默认字色。 */
export const salesPlanVarianceClass = (
  value: string | null | undefined,
  positiveClass: string,
  negativeClass: string
): string | undefined => {
  const sign = salesPlanVarianceSign(value);
  if (sign === 'positive') return positiveClass;
  if (sign === 'negative') return negativeClass;
  return undefined;
};
