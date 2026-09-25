import { Decimal } from 'decimal.js';

/** Dashboard amounts are yuan; keep the unrounded value available in the title. */
export function readableMoney(input: string | number): { display: string; exact: string } {
  if (input === '' || input === null || input === undefined) return {display:'—',exact:'—'};
  let value: Decimal;
  try { value = new Decimal(input); } catch { return {display:'—',exact:'—'}; }
  if (!value.isFinite()) return {display:'—',exact:'—'};
  const sign = value.isNegative() && !value.isZero() ? '−' : '';
  const absolute = value.abs();
  const units: Array<[number,string]> = [[100000000,'亿'],[10000000,'千万'],[10000,'万']];
  const unit = units.find(([size])=>absolute.greaterThanOrEqualTo(size));
  const [whole,fraction] = absolute.toFixed().split('.');
  const exactValue = whole.replace(/\B(?=(\d{3})+(?!\d))/g,',') + (fraction ? '.'+fraction : '');
  const scaled = unit ? absolute.div(unit[0]) : absolute;
  const rounded = scaled.toDecimalPlaces(2);
  const displayValue = !scaled.isZero() && rounded.isZero() ? scaled.toFixed() : rounded.toFixed();
  return {display:`${sign}¥${displayValue}${unit?.[1] ?? ''}`,exact:`${sign}¥${exactValue}`};
}
