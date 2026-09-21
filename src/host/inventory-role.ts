import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { gatewayMcpTransport } from './gateway-mcp.ts';
const list=(v:unknown):string[]=>[...new Set((typeof v==='string'?v.split(','):Array.isArray(v)?v:[]).filter((s):s is string=>typeof s==='string').map(s=>s.trim()).filter(s=>s.length>0&&s.length<=160))].slice(0,64);
export function verifiedRoleProfile(payload:any,expected:{sessionId:string;conversationId:string;agentCode?:string},userId:string){
 if(payload?.success!==true||payload?.code!=='OK'||payload.userId!==userId||payload.sessionId!==expected.sessionId||payload.conversationId!==expected.conversationId||payload.agentId!==expected.agentCode)throw Error('GEA_ROLE_IDENTITY_MISMATCH');
 const codes=list(payload.roleCodes),names=list(payload.roleNames);
 const roles=new Map<string,{code:string;name:string|null}>();
 codes.forEach((code,i)=>roles.set(code,{code,name:names[i]??null}));
 if(Array.isArray(payload.roles))for(const r of payload.roles.slice(0,64)){const code=list([r?.code])[0],name=list([r?.name])[0];if(code)roles.set(code,{code,name:name??roles.get(code)?.name??null});}
 return {roleCodes:[...roles.keys()],roleNames:[...new Set([...names,...[...roles.values()].flatMap(r=>r.name?[r.name]:[])])],roles:[...roles.values()]};
}
export async function resolveInventoryRoles(base:string,credentials:{sessionId:string;conversationId:string;delegationToken:string;agentCode?:string},userId:string,signal:AbortSignal,timeoutMs:number,fetchImpl:typeof fetch){
 const connection=gatewayMcpTransport(base,credentials,signal,timeoutMs,fetchImpl);
 const client=new Client({name:'inventory-workbench-role',version:'1.0.0'});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url),{fetch:connection.fetch}));
  let cursor:string|undefined;let found=false;
  do {const result=await client.listTools(cursor?{cursor}:{});found=result.tools.some(t=>t.name==='gateway.session.currentUser.resolve');cursor=result.nextCursor;if(found)break;}while(cursor);
  if(!found)throw Error('GEA_CURRENT_USER_TOOL_UNAVAILABLE');
  const result=await client.callTool({name:'gateway.session.currentUser.resolve',arguments:{}});
  if(result.isError)throw Error('GEA_CURRENT_USER_RESOLVE_FAILED');
  const payload=result.structuredContent??JSON.parse((result.content as any[])?.find(c=>c.type==='text')?.text??'null');
  signal.throwIfAborted();return verifiedRoleProfile(payload,credentials,userId);
 }finally{await client.close().catch(()=>{});}
}
