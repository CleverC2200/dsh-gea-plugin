import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {profile,readSession,until} from '../../../tests/profile.mjs';
const marker='MANDATORY_RULE_UNIQUE_MARKER_95_PERCENT';
await mkdir('.runtime/inventory-qa-20260926',{recursive:true});
test('compare session history with actual model-visible Skill body across turns',async t=>{
 const app=await profile(t,{config:base=>({analysis:{mode:'model',baseUrl:base+'/v1',model:'fixture',apiKeyEnv:'QA_MODEL_KEY',agentCode:'sales_forecast',contextWindow:32768,maxTokens:2048}}),env:{QA_MODEL_KEY:'fixture'}});
 await mkdir(app.runtime+'/home/business-skills/sinian-demand-dialogue',{recursive:true});
 await writeFile(app.runtime+'/home/business-skills/sinian-demand-dialogue/SKILL.md','---\nname: sinian-demand-dialogue\ndescription: fixture\n---\n'+marker);
 let step=0;const requests=[];
 app.route((req,res)=>{if(req.url.pathname!=='/v1/chat/completions')return false;const b=JSON.parse(req.body);requests.push(b);const delta=step++%2===0?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'gea_skill',arguments:JSON.stringify({name:'sinian-demand-dialogue'})}}]}:{content:'规则已核对。'};res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');return true;});
 await app.login();const created=await app.remote('session/create',{cwd:app.runtime+'/workspace',agentPreset:'gea-readonly'});const id=created.value.sessionId;await app.remote('session/selectModel',{sessionId:id,provider:'gea-analysis',model:'fixture'});
 for(let i=0;i<2;i++){await app.remote('session/prompt',{requestId:randomUUID(),sessionId:id,mode:'queue',content:[{type:'text',text:'核对规则第'+i+'轮'}]});await until(()=>readSession(app.runtime,id),r=>r.filter(e=>e.type==='turn/end').length===i+1);}
 const rows=await readSession(app.runtime,id);const replies=rows.filter(e=>e.type==='tool/result').flatMap(e=>e.data.message.content.flatMap(b=>b.type==='tool-result'?b.content.map(c=>JSON.parse(c.text)):[]));
 const result={requests:requests.map((b,i)=>({i,roles:b.messages.map(m=>m.role),containsBody:JSON.stringify(b.messages).includes(marker)})),replies:replies.map(({alreadyLoaded,content,instructionId})=>({alreadyLoaded,hasBody:!!content,instructionId})),secondTurnFalsePositive:replies[1].alreadyLoaded===true&&!JSON.stringify(requests[3].messages).includes(marker)};
 await writeFile('.runtime/inventory-qa-20260926/skill-visibility.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 assert.equal(result.secondTurnFalsePositive,false,'Skill reuse must not hide the only model-visible copy');
});
