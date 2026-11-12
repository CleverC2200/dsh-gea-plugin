import {
  CAPABILITY_EFFECTS,
  effectRank,
  type CapabilityContract,
  type CapabilityEffect,
} from "./contract.ts";
import { layerForEffect, layersForContract, type CapabilityLayer } from "./layers.ts";
import { truncateText } from "@cleverc2200/dsh-agent-workbench/page-interaction/payload-budget";

export type CapabilityRegistry = {
  list(): CapabilityContract[];
  get(id: string): CapabilityContract | undefined;

  surfaces(): string[];

  draftSurfaces(): string[];

  readModules(): CapabilityContract[];

  byConsumer(consumerCode: string): CapabilityContract | undefined;

  route(text: string): CapabilityContract[];

  readToolIndex(): string;

  allows(surface: string, effect: CapabilityEffect): boolean;

  modules(): Array<{
    id: string;
    label: string;
    surface?: string;
    consumerCode?: string;
    pageIds: string[];
  }>;
};

const CONSUMER_PATTERN = /^[a-z][a-z0-9_-]+$/;

const shortTableName = (table: string): string =>
  table.replace(/^agents?_scm_/, "").replace(/^agents?_/, "");

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
  const claim = (
    map: Map<string, CapabilityContract>,
    id: string,
    contract: CapabilityContract,
    code: string,
  ) => {
    const previous = map.get(id);
    if (previous)
      throw Error(
        `${code}: ${id} [source: ${previous.source ?? previous.id}; ${contract.source ?? contract.id}]`,
      );
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
  const enabled = () => ordered().filter((contract) => contract.enabled !== false);
  const surfaceOf = (contract: CapabilityContract) => contract.view?.surface;

  return {
    list: ordered,
    get: (id) => byId.get(id),
    surfaces: () =>
      enabled()
        .map(surfaceOf)
        .filter((surface): surface is string => typeof surface === "string"),
    draftSurfaces: () =>
      enabled()
        .filter((contract) => effectRank(contract.maxEffect) >= effectRank("draft"))
        .map(surfaceOf)
        .filter((surface): surface is string => typeof surface === "string"),
    readModules: () => enabled().filter((contract) => contract.data !== undefined),
    byConsumer: (consumerCode) =>
      enabled().find((contract) => contract.data?.consumerCode === consumerCode),
    route: (text) => {
      const haystack = text.toLowerCase();
      const hits: Array<{ contract: CapabilityContract; score: number }> = [];
      for (const contract of enabled()) {
        const keywords = [...(contract.routing.keywords ?? []), contract.label, contract.id].filter(
          (keyword) => keyword.length >= 2,
        );
        let score = 0;
        for (const keyword of keywords) if (haystack.includes(keyword.toLowerCase())) score += 1;
        if (score > 0) hits.push({ contract, score });
      }
      return hits
        .sort((a, b) => b.score - a.score || a.contract.id.localeCompare(b.contract.id))
        .map((hit) => hit.contract);
    },
    readToolIndex: () => {
      const modules = enabled().filter((contract) => contract.data !== undefined);
      if (modules.length === 0) return "（当前没有可直读的业务模块）";

      return modules
        .map((contract) => {
          const data = contract.data!;
          const tables = data.tables.slice(0, 3).map(shortTableName).join("、");
          const more = data.tables.length > 3 ? ` 等 ${data.tables.length} 张` : "";

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
      for (const contract of enabled())
        if (surfaceOf(contract) === surface) {
          return (
            effectRank(effect) <= effectRank(contract.maxEffect) &&
            layersOf(contract).includes(layerForEffect(effect))
          );
        }
      return false;
    },
    modules: () =>
      ordered().map((contract) => ({
        id: contract.id,
        label: contract.label,
        ...(contract.view === undefined ? {} : { surface: contract.view.surface }),
        ...(contract.data === undefined ? {} : { consumerCode: contract.data.consumerCode }),
        pageIds: contract.view?.pageIds ?? [],
      })),
  };
}
