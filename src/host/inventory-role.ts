import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { gatewayMcpTransport } from "./gateway-mcp.ts";

const list = (value: unknown, max = 64): string[] =>
  [
    ...new Set(
      (typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 160),
    ),
  ].slice(0, max);

const text = (value: unknown, max = 160): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;

export type InventoryRoleProfile = Readonly<{
  roleCodes: string[];
  roleNames: string[];
  roles: Array<{ code: string; name: string | null }>;
  /**
   * The gateway may omit this until the customer-inventory authorization
   * contract is deployed. An omitted scope is deliberately not treated as
   * broad access by presentation code.
   */
  customerInventoryScope: {
    status: "granted" | "unconfigured";
    regions: string[];
    provinces: string[];
    customerCodes: string[];
    version: string | null;
    expiresAt: string | null;
  };
}>;

/**
 * Verify that a gateway role/scope receipt belongs to exactly this delegated
 * session. The browser receives only this projection, never the delegation
 * token or the raw gateway receipt.
 */
export function verifiedRoleProfile(
  payload: any,
  expected: { sessionId: string; conversationId: string; agentCode?: string },
  userId: string,
): InventoryRoleProfile {
  if (
    payload?.success !== true ||
    payload?.code !== "OK" ||
    payload.userId !== userId ||
    payload.sessionId !== expected.sessionId ||
    payload.conversationId !== expected.conversationId ||
    payload.agentId !== expected.agentCode
  )
    throw Error("GEA_ROLE_IDENTITY_MISMATCH");

  const codes = list(payload.roleCodes);
  const names = list(payload.roleNames);
  const roles = new Map<string, { code: string; name: string | null }>();
  codes.forEach((code, index) => roles.set(code, { code, name: names[index] ?? null }));
  if (Array.isArray(payload.roles))
    for (const role of payload.roles.slice(0, 64)) {
      const code = list([role?.code])[0];
      const name = list([role?.name])[0];
      if (code) roles.set(code, { code, name: name ?? roles.get(code)?.name ?? null });
    }

  const rawScope =
    payload.customerInventoryScope &&
    typeof payload.customerInventoryScope === "object" &&
    !Array.isArray(payload.customerInventoryScope)
      ? payload.customerInventoryScope
      : null;
  const regions = list(rawScope?.regions);
  const provinces = list(rawScope?.provinces);
  const customerCodes = list(rawScope?.customerCodes, 10_000);
  const configured = rawScope?.status === "granted";
  return {
    roleCodes: [...roles.keys()],
    roleNames: [...new Set([...names, ...[...roles.values()].flatMap((role) => (role.name ? [role.name] : []))])],
    roles: [...roles.values()],
    customerInventoryScope: {
      status: configured ? "granted" : "unconfigured",
      regions: configured ? regions : [],
      provinces: configured ? provinces : [],
      customerCodes: configured ? customerCodes : [],
      version: configured ? text(rawScope?.version) : null,
      expiresAt: configured ? text(rawScope?.expiresAt) : null,
    },
  };
}

export async function resolveInventoryRoles(
  base: string,
  credentials: { sessionId: string; conversationId: string; delegationToken: string; agentCode?: string },
  userId: string,
  signal: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<InventoryRoleProfile> {
  const connection = gatewayMcpTransport(base, credentials, signal, timeoutMs, fetchImpl);
  const client = new Client({ name: "inventory-workbench-role", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { fetch: connection.fetch }));
    let cursor: string | undefined;
    let found = false;
    do {
      const result = await client.listTools(cursor ? { cursor } : {});
      found = result.tools.some((tool) => tool.name === "gateway.session.currentUser.resolve");
      cursor = result.nextCursor;
      if (found) break;
    } while (cursor);
    if (!found) throw Error("GEA_CURRENT_USER_TOOL_UNAVAILABLE");
    const result = await client.callTool({ name: "gateway.session.currentUser.resolve", arguments: {} });
    if (result.isError) throw Error("GEA_CURRENT_USER_RESOLVE_FAILED");
    const payload =
      result.structuredContent ??
      JSON.parse((result.content as any[])?.find((content) => content.type === "text")?.text ?? "null");
    signal.throwIfAborted();
    return verifiedRoleProfile(payload, credentials, userId);
  } finally {
    await client.close().catch(() => {});
  }
}
