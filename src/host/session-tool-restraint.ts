/** Keep browser/terminal global tools out of business questions through the official scoped registry. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
export const BROWSER_TOOL_PREFIX='mcp__browser';
export const TERMINAL_TOOL_PREFIX='terminal_';
export const SIDEBAR_TOOL_NAME='sidebar_open';
export const CODING_PRESETS=['auto-negotiation','standard'];
export function denyTargetsFor(known:readonly string[],preset:string|undefined):string[]{
 const coding=preset!==undefined&&CODING_PRESETS.includes(preset);
 return known.filter(name=>name.startsWith(BROWSER_TOOL_PREFIX)||(!coding&&(name.startsWith(TERMINAL_TOOL_PREFIX)||name===SIDEBAR_TOOL_NAME)));
}
/** One explicit scoped mask, based on registry data rather than an error-message probe. */
export function restrictToolsForAgent(agent:Pick<Agent,'ctx'>,known:readonly string[],preset:string|undefined):(()=>void)|undefined {
 const deny=denyTargetsFor(known.filter(name=>name!=='run_code'),preset);
 return deny.length?agent.ctx.tools.restrict({deny}):undefined;
}
export function mountSessionToolRestraint(ctx:Context):()=>void {
 const masks=new Map<Agent,{key:string;dispose?:()=>void}>();
 let updating=false;
 const sync=(agent?:Agent)=>{
  if(updating)return;updating=true;
  try{
   const known=ctx.tools.schemas().map(tool=>tool.name);
   const agents=agent?[agent]:ctx.agents.list();
   for(const current of agents){
    const preset=ctx.sessionProjections.stateOf(current.session,'agentPreset')??undefined;
    const deny=denyTargetsFor(known,preset);const key=deny.sort().join('|');
    const old=masks.get(current);if(old?.key===key)continue;
    const dispose=restrictToolsForAgent(current,known,preset);
    masks.set(current,{key,dispose});old?.dispose?.();
   }
  }finally{updating=false;}
 };
 const off=ctx.on('agent/pre-step',async({agent},next)=>{sync(agent);return next();});
 const changed=ctx.on('tools/change',()=>sync());
 const disposed=ctx.on('agent/disposed',({agent})=>{const mask=masks.get(agent);masks.delete(agent);mask?.dispose?.();});
 const selected=ctx.on('agent-preset/selected',()=>sync());
 return ()=>{off();changed();disposed();selected();for(const mask of masks.values())mask.dispose?.();masks.clear();};
}
