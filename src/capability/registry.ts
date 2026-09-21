/**
 * 能力注册表：宿主唯一的"这个客户端现在有哪些业务能力"的入口。
 *
 * 页面桥的白名单、只读数据工具的模块清单、首页问答的模块索引，全部由这里产出，
 * 宿主其它地方不再按模块写死分支（加一个模块 = 注册表里多一条契约）。
 */
import {
  effectRank,
  type CapabilityContract,
  type CapabilityEffect,
} from "./contract.ts";

export type CapabilityRegistry = {
  /** 全部契约（稳定顺序，模块 id 排序）。 */
  list(): CapabilityContract[];
  get(id: string): CapabilityContract | undefined;
  /** 允许被对话操作的页面标识。 */
  surfaces(): string[];
  /** 允许被对话改到草稿及以上等级的页面标识。 */
  draftSurfaces(): string[];
  /** 有受管只读数据契约的模块。 */
  readModules(): CapabilityContract[];
  /** 按受管 consumerCode 找模块。 */
  byConsumer(consumerCode: string): CapabilityContract | undefined;
  /** 关键词 -> 模块（首页问题路由用）。 */
  route(text: string): CapabilityContract[];
  /** 只读数据工具的模块说明（模块清单 + 可读表 + 口径）。 */
  readToolIndex(): string;
  /** 该等级是否被这个页面允许。 */
  allows(surface: string, effect: CapabilityEffect): boolean;
  /** 给浏览器看的模块索引（页面用它把 pageId 映射到 consumerCode，不在前端写死）。 */
  modules(): Array<{
    id: string;
    label: string;
    surface?: string;
    consumerCode?: string;
    pageIds: string[];
  }>;
};

const CONSUMER_PATTERN = /^[a-z][a-z0-9-]+$/;

function tableList(tables: readonly string[], max: number): string {
  if (tables.length === 0) return "未声明可读表（先用 describe 发现）";
  const shown = tables.slice(0, max);
  return (
    shown.join("、") +
    (tables.length > shown.length
      ? ` 等 ${tables.length} 张表`
      : "")
  );
}

export function createCapabilityRegistry(
  contracts: readonly CapabilityContract[],
): CapabilityRegistry {
  const byId = new Map<string, CapabilityContract>();
  for (const contract of contracts) {
    if (byId.has(contract.id))
      throw new Error("DUPLICATE_CAPABILITY_CONTRACT: " + contract.id);
    if (contract.data && !CONSUMER_PATTERN.test(contract.data.consumerCode))
      throw new Error("INVALID_CONSUMER_CODE: " + contract.data.consumerCode);
    byId.set(contract.id, contract);
  }
  const ordered = () => [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const surfaceOf = (contract: CapabilityContract) =>
    contract.view?.surface;

  return {
    list: ordered,
    get: (id) => byId.get(id),
    surfaces: () =>
      ordered()
        .map(surfaceOf)
        .filter((surface): surface is string => typeof surface === "string"),
    draftSurfaces: () =>
      ordered()
        .filter((contract) => effectRank(contract.maxEffect) >= effectRank("draft"))
        .map(surfaceOf)
        .filter((surface): surface is string => typeof surface === "string"),
    readModules: () => ordered().filter((contract) => contract.data !== undefined),
    byConsumer: (consumerCode) =>
      ordered().find(
        (contract) => contract.data?.consumerCode === consumerCode,
      ),
    route: (text) => {
      const haystack = text.toLowerCase();
      const hits: Array<{ contract: CapabilityContract; score: number }> = [];
      for (const contract of ordered()) {
        const keywords = [
          ...(contract.routing.keywords ?? []),
          contract.label,
          contract.id,
        ].filter((keyword) => keyword.length >= 2);
        let score = 0;
        for (const keyword of keywords)
          if (haystack.includes(keyword.toLowerCase())) score += 1;
        if (score > 0) hits.push({ contract, score });
      }
      return hits
        .sort((a, b) => b.score - a.score || a.contract.id.localeCompare(b.contract.id))
        .map((hit) => hit.contract);
    },
    readToolIndex: () => {
      const modules = ordered().filter((contract) => contract.data !== undefined);
      if (modules.length === 0) return "（当前没有可直读的业务模块）";
      return modules
        .map((contract) => {
          const data = contract.data!;
          const rules = data.rules.length
            ? `；口径：${data.rules.join(" / ")}`
            : "";
          return `- ${contract.label}：consumerCode=${data.consumerCode}；可读表：${tableList(data.tables, 12)}${rules}`;
        })
        .join("\n");
    },
    allows: (surface, effect) => {
      for (const contract of ordered())
        if (surfaceOf(contract) === surface)
          return effectRank(effect) <= effectRank(contract.maxEffect);
      return false;
    },
    modules: () =>
      ordered().map((contract) => ({
        id: contract.id,
        label: contract.label,
        ...(contract.view === undefined ? {} : { surface: contract.view.surface }),
        ...(contract.data === undefined
          ? {}
          : { consumerCode: contract.data.consumerCode }),
        pageIds: contract.view?.pageIds ?? [],
      })),
  };
}
