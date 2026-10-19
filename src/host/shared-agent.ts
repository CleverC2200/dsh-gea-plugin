import type { CapabilityContract } from "../capability/contract.ts";

export const WORKBENCH_AGENT_CODE = "workbench";
export const WORKBENCH_SOURCE_REF = "gea-workbench-tools";

export const sharedAgentCapability: CapabilityContract = {
  id: WORKBENCH_SOURCE_REF,
  label: "GEA Workbench",
  data: { consumerCode: WORKBENCH_AGENT_CODE, tables: [], rules: [] },
  maxEffect: "view",
  skills: [],
  routing: {
    keywords: [],
    summary: "用户模式共用的 GEA Cube 查询与知识库能力。",
  },
};
