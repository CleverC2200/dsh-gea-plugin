import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
export async function currentHtmlResource(root) {
  const manifest = JSON.parse(await readFile(join(root, "plugin.json"), "utf8"));
  const id = manifest.id, consumerCode = manifest.gea.consumerCode;
  manifest.gea.contract = "gea-html-v2";
  manifest.declarations = {page: "page.json", capability: "capability.json"};
  manifest.agentResources = {provider: "dsh-agent-manage", prompt: "prompt.json"};
  const mcp = JSON.parse(await readFile(join(root, manifest.mcp), "utf8"));
  mcp.contract = "gea-html-v2";
  const capability = {id, label: manifest.name, data: {consumerCode, tables: [], rules: [], ...(manifest.mode === "mock" ? {mock: true} : {})}, maxEffect: "view", layers: ["read"], skills: [id], routing: {keywords: [id], summary: manifest.name}};
  for (const [name, value] of Object.entries({"plugin.json":manifest, [manifest.mcp]:mcp, "page.json": {surface:`gea-html-${id}`, protocol:"self-report", pageIds:(manifest.pages ?? [{id}]).map(page=>page.id), consumerCode, maxEffect:"view"}, "capability.json":capability, "prompt.json": {label:manifest.name, consumerCode, persona:"只读测试页面，保留用户会话与权限边界。", skills:[id]}}))
    await writeFile(join(root, name), JSON.stringify(value));
}
