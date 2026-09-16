/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import type { GeaSalesPlanListItem } from '../../../bridge.ts';

export type SalesPlanProgressNode = {
  key: string;
  level: 'area' | 'province' | 'region' | 'customer';
  code?: string;
  name?: string;
  total: number;
  pending: number;
  completed: number;
  children: SalesPlanProgressNode[];
};

/** 列表已由 GEA 限定范围；只聚合返回的标识，绝不虚构缺失客户。 */
export const buildSalesPlanProgressTree = (records: readonly GeaSalesPlanListItem[]): SalesPlanProgressNode[] => {
  const roots: SalesPlanProgressNode[] = [];
  const nodes = new Map<string, SalesPlanProgressNode>();
  for (const row of records) {
    if (row.status === 0) continue;
    const levels = [
      ['area', row.areaCode, row.areaName ?? row.regionName],
      ['province', row.provinceCode, row.provinceName ?? row.provinceRegionName],
      ['region', row.orgCode, row.orgName ?? row.salesGroupName],
      ['customer', row.dealerCode, row.dealerName],
    ] as const;
    let siblings = roots;
    const path: Array<string | null> = [];
    for (const [level, rawCode, rawName] of levels) {
      const code = rawCode?.trim() || undefined;
      path.push(code ?? null);
      const key = JSON.stringify(path);
      let node = nodes.get(key);
      if (!node) {
        node = {
          key,
          level,
          code,
          name: code ? rawName?.trim() || undefined : undefined,
          total: 0,
          pending: 0,
          completed: 0,
          children: [],
        };
        nodes.set(key, node);
        siblings.push(node);
      }
      node.total++;
      if (row.status === 10) node.completed++;
      else node.pending++;
      siblings = node.children;
    }
  }
  return roots;
};
