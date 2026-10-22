export function assertHtmlMcp(mcp, consumerCode, mock) {
  if (
    mcp?.provider !== "gea" ||
    mcp.transport !== "host-provided" ||
    mcp.contract !== "gea-html-v2" ||
    mcp.consumer?.consumerCode !== consumerCode ||
    mcp.consumer?.consumerType !== "AGENT" ||
    !(mock
      ? JSON.stringify(mcp.capabilities) === "[]"
      : ['["governed-sql-read"]', '["governed-sql-read","governed-cube-read"]'].includes(
          JSON.stringify(mcp.capabilities),
        ))
  )
    throw Error("INVALID_GEA_CAPABILITY");
}
