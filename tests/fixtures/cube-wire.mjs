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
