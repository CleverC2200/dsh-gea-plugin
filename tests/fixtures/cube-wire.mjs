/** Explicit loopback server contract for native MCP model-loop fixtures. */
export const fixtureCubeCode = "cube";
export const inspectSchema = {
  type: "object",
  properties: { keyword: { type: "string" } },
  additionalProperties: false,
};
export const querySchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["query"] },
    queries: { type: "array", items: { type: "object" } },
    response_mode: { type: "string" },
  },
  required: ["action", "queries"],
  additionalProperties: false,
};
export const fixtureCubeTools = [
  {
    name: "inspect_cube_model",
    description: "Fixture server inspection",
    inputSchema: inspectSchema,
    _meta: { sourceType: "MCP", sourceCode: fixtureCubeCode },
  },
  {
    name: "query_business_data",
    description: "Fixture server query",
    inputSchema: querySchema,
    _meta: { sourceType: "MCP", sourceCode: fixtureCubeCode },
  },
];

/** Native discovery only; scenarios still own every business tool response. */
export function fixtureCubeDiscovery(request, response, reply) {
  if (!request.url.pathname.endsWith("/ai/gateway/mcp/proxy/mcp")) return false;
  const wire = JSON.parse(request.body);
  if (wire.method === "notifications/initialized") {
    response.writeHead(202);
    response.end();
    return true;
  }
  const result =
    wire.method === "initialize"
      ? { protocolVersion: wire.params.protocolVersion }
      : wire.method === "tools/list"
        ? { tools: fixtureCubeTools }
        : undefined;
  if (!result) return false;
  reply({ jsonrpc: "2.0", id: wire.id, result });
  return true;
}
