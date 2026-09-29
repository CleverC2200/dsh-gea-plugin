/**
 * 能力注册表：宿主唯一的"这个客户端现在有哪些业务能力"的入口。
 *
 * 页面桥的白名单、只读数据工具的模块清单、首页问答的模块索引，全部由这里产出，
 * 宿主其它地方不再按模块写死分支（加一个模块 = 注册表里多一条契约）。
 */
import {
  CAPABILITY_EFFECTS,
  effectRank,
  type CapabilityContract,
  type CapabilityEffect,
} from "./contract.ts";
import {
  layerForEffect,
  layersForContract,
  type CapabilityLayer,
} from "./layers.ts";
import { truncateText } from "../shared/payload-budget.ts";

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

/** 表名去前缀：`agents_scm_inventory_age` → `inventory_age`，够模型认出主题又不占字节。 */
const shortTableName = (table: string): string =>
  table.replace(/^agents?_scm_/, "").replace(/^agents?_/, "");

/** 模块有哪几层能力：模块自己声明过就用它，否则按页面/数据/最大等级派生。 */
const layersOf = (contract: CapabilityContract): CapabilityLayer[] =>
  contract.layers ??
  layersForContract({
    hasView: contract.view !== undefined,
    hasData: contract.data !== undefined,
    maxEffect: contract.maxEffect,
  });

export function createCapabilityRegistry(
  contracts: readonly CapabilityContract[],
): CapabilityRegistry {
  const byId = new Map<string, CapabilityContract>();
  const surfaces = new Map<string, CapabilityContract>();
  const pages = new Map<string, CapabilityContract>();
  const claim = (map: Map<string, CapabilityContract>, id: string, contract: CapabilityContract, code: string) => {
    const previous = map.get(id);
    if (previous) throw Error(`${code}: ${id} [source: ${previous.source ?? previous.id}; ${contract.source ?? contract.id}]`);
    map.set(id, contract);
  };
  for (const contract of contracts) {
    const source = contract.source ?? contract.id;
    if (!CAPABILITY_EFFECTS.includes(contract.maxEffect))
      throw Error(`INVALID_CAPABILITY_EFFECT: ${contract.maxEffect} [source: ${source}]`);
    if (contract.data && !CONSUMER_PATTERN.test(contract.data.consumerCode))
      throw Error(`INVALID_CONSUMER_CODE: ${contract.data.consumerCode} [source: ${source}]`);
    claim(byId, contract.id, contract, "DUPLICATE_CAPABILITY_CONTRACT");
    if (contract.view) {
      claim(surfaces, contract.view.surface, contract, "DUPLICATE_CAPABILITY_SURFACE");
      for (const page of contract.view.pageIds)
        claim(pages, page, contract, "DUPLICATE_CAPABILITY_PAGE");
    }
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
      // 渐进式暴露：只给"模块名 + 编码 + 一句话 + 表名关键词"，列、配方、口径仍用
      // describe=true 按需取。表名关键词是选模块的关键信号：线上实测模型为了找
      // "货龄"数据会把两三个模块的契约逐个翻一遍（gea_plugin_read describe），
      // 这里给三张代表表就能直接指到 agents_scm_inventory_age 这类表。
      return modules
        .map((contract) => {
          const data = contract.data!;
          const tables = data.tables
            .slice(0, 3)
            .map(shortTableName)
            .join("、");
          const more =
            data.tables.length > 3 ? ` 等 ${data.tables.length} 张` : "";
          // 演示模块要标出来：它的数字是原型数据、没有真实通道，调它只会拿到
          // mock-module 提示并被计进"白跑总账"（线上实测 6 次就到上限停手）。
          const mock =
            data.mock === true
              ? "；**演示模块**：页面数字是原型数据，没有真实数据通道，不要调它取数"
              : "";
          return `- ${contract.label}：consumerCode=${
            data.consumerCode
          }；${truncateText(contract.routing.summary, 80)}；表：${
            tables || "（未登记）"
          }${more}；能力层：${layersOf(contract).join("、")}${mock}`;
        })
        .join("\n");
    },
    allows: (surface, effect) => {
      for (const contract of ordered())
        if (surfaceOf(contract) === surface) {
          // 统一按能力层判定：读层看这个页面在不在、写层看模块声明的层。
          return effectRank(effect) <= effectRank(contract.maxEffect) &&
            layersOf(contract).includes(layerForEffect(effect));
        }
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
