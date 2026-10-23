import z from "@deepseek-ai/schemastery";
import type {
  BusinessNavigationAgent,
  BusinessNavigationDomain,
} from "@cleverc2200/dsh-agent-workbench/client";

const agents = z
  .array(
    z
      .object({
        id: z.string().required(),
        agentCode: z.string(),
        agentName: z.string(),
        businessDomain: z.string(),
      })
      .required(),
  )
  .required();
const domains = z
  .array(
    z
      .object({
        value: z.string().required(),
        text: z.string().required(),
        description: z.string(),
      })
      .required(),
  )
  .required();

export function navigationAgents(value: unknown): BusinessNavigationAgent[] {
  try {
    const parsed: ReturnType<typeof agents> = z.resolve(value, agents, {})[0];
    return parsed.map((item) => ({
      id: item.id,
      agentCode: item.agentCode ?? null,
      agentName: item.agentName ?? null,
      businessDomain: item.businessDomain ?? null,
    }));
  } catch {
    throw Error("NAVIGATION_INVALID_RESPONSE");
  }
}

export function navigationDomains(value: unknown): BusinessNavigationDomain[] {
  try {
    const parsed: ReturnType<typeof domains> = z.resolve(value, domains, {})[0];
    return parsed.map((item) => ({
      value: item.value,
      text: item.text,
      description: item.description ?? null,
    }));
  } catch {
    throw Error("NAVIGATION_INVALID_RESPONSE");
  }
}
