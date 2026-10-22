export function assertHtmlMcp(mcp, consumerCode, mock) {
  if (
    mcp?.provider !== "gea" ||
    mcp.transport !== "host-provided" ||
    mcp.contract !== "gea-html-v2" ||
    mcp.consumer?.consumerCode !== consumerCode ||
    mcp.consumer?.consumerType !== "AGENT" ||
    JSON.stringify(mcp.capabilities) !== JSON.stringify(mock ? [] : ["governed-sql-read"])
  )
    throw Error("INVALID_GEA_CAPABILITY");
}
