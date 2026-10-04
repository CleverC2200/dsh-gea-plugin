import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHtmlPlugins} from '../src/html-plugins.ts';
import {currentHtmlResource} from './fixtures/html-resource.mjs';
const session='session-11111111-1111-4111-8111-111111111111';
async function fixture(t,options={}){
 const directory=await realpath(await mkdtemp(join(tmpdir(),'gea-business-grant-')));t.after(()=>rm(directory,{recursive:true,force:true}));
 const id='inventory-grant',preset='gea-html-'+id,consumer=id+'-consumer';
 await writeFile(join(directory,'index.html'),'<html><body>Unchanged original</body></html>');
 await writeFile(join(directory,'SKILL.md'),'---\nname: inventory-grant\ndescription: original\n---\nOriginal business rule.\n');
 await writeFile(join(directory,'plugin.json'),JSON.stringify({schemaVersion:1,id,name:'Original page',html:'index.html',skills:['SKILL.md'],mcp:'mcp.json',...(options.mock?{mode:'mock'}:{}),gea:{contract:'gea-html-v2',consumerCode:consumer,readonly:true}}));
 await writeFile(join(directory,'mcp.json'),JSON.stringify({provider:'gea',transport:'host-provided',contract:'gea-html-v2',consumer:{consumerType:'AGENT',consumerCode:consumer},capabilities:['governed-sql-read']}));
 await currentHtmlResource(directory);const manifest=JSON.parse(await readFile(join(directory,'plugin.json'),'utf8'));
 const cleanups=[],adapters=new Map(),resources=new Set(),routes=new Map(),identities=new Map(),queries=[],launches=[];
 let identity=new AbortController(),scope='original-principal',selected=preset,authenticated=!options.mock;
 const ctx={agents:{get:id=>id===session?{session:{}}:undefined},sessionProjections:{stateOf:()=>selected},get:()=>({resolve:async id=>({id})}),effect(fn){const off=fn();if(typeof off==='function')cleanups.push(off);},connection:{fetch:{register(route){routes.set(route.path,route);return()=>routes.delete(route.path);}}},agentResources:{register:async entries=>{entries.forEach(e=>resources.add(e.id));return()=>entries.forEach(e=>resources.delete(e.id));},interpreters:()=>[...resources]},workbenchPages:{registerBusinessPage(page,authorize){adapters.set(page.id,authorize);return()=>adapters.delete(page.id);}}};
 const business={config:{analysisAgentCode:'aps',runtimeDir:directory},status:()=>({environment:'test',authenticated,user:authenticated?{id:'user',tenantId:'tenant'}:null}),pageSessionScope:()=>scope,identitySignal:()=>identity.signal,htmlLaunch:async(code,signal)=>{launches.push(code);if(options.launch)return options.launch(signal);return {sessionId:'delegation',roleProfile:{roles:['reader']}};},pluginSql:async(input,signal)=>{signal.throwIfAborted();queries.push(input);if(options.queryError)throw Error(options.queryError);return {rows:[{qty:42}]};},touchPageIdentity:(id,value)=>identities.set(id,value),clearPageIdentity:(id,plugin)=>{if(identities.get(id)?.pluginId===plugin)identities.delete(id);},currentPageIdentity:id=>identities.get(id)};
 await registerHtmlPlugins(ctx,business,[{directory,htmlPath:join(directory,'index.html'),manifest}]);
 const dispose=()=>{cleanups.splice(0).reverse().forEach(off=>off());};t.after(dispose);
 return {adapters,queries,launches,identities,routes,dispose,authorize:(signal=new AbortController().signal)=>adapters.get(id)(session,preset,signal),changeIdentity(){identity.abort();identity=new AbortController();scope='replacement-principal';},select(value){selected=value;},resources,id,preset};
}
test('actual HTML grant retains its declared Consumer and protected SQL failures without a generic GEA method route',async t=>{
 const h=await fixture(t);const grant=await h.authorize();assert.equal(grant.access.principalId,'user');assert.equal(grant.access.gatewayScopeRef,'delegation');
 assert.equal(grant.allowsEffect('view'),true);assert.equal(grant.allowsEffect('approve'),false);assert.equal(grant.allowsEffect('draft'),false);
 assert.deepEqual(await grant.readSql({consumerCode:'forged',sql:'select 1'},new AbortController().signal),{rows:[{qty:42}]});assert.equal(h.queries[0].consumerCode,'inventory-grant-consumer');
 assert.equal([...h.routes.keys()].some(path=>path.endsWith('/open')||path.endsWith('/call')),false);
 grant.release();assert.equal(h.identities.size,0);
});
test('real grant verifies selected official preset and installed resource before any Consumer launch',async t=>{
 const h=await fixture(t);h.select('unrelated');await assert.rejects(h.authorize(),/PAGE_AGENT_SESSION_MISMATCH/);assert.equal(h.launches.length,0);
 h.select(h.preset);h.resources.clear();await assert.rejects(h.authorize(),/PAGE_AGENT_PRESET_NOT_ALLOWED/);assert.equal(h.launches.length,0);
});
test('identity revocation blocks a pending authorization and the historical Session cannot bind a different principal',async t=>{
 const gate=Promise.withResolvers();const h=await fixture(t,{launch:()=>gate.promise});const opening=h.authorize();await new Promise(r=>setImmediate(r));h.changeIdentity();gate.resolve({sessionId:'obsolete'});await assert.rejects(opening);assert.equal(h.identities.size,0);
 h.dispose();const other=await fixture(t);await other.authorize();other.changeIdentity();await assert.rejects(other.authorize(),/PAGE_SESSION_IDENTITY_MISMATCH/);
});
test('resource teardown or replacement request cannot install a late business projection',async t=>{
 const gate=Promise.withResolvers();const h=await fixture(t,{launch:()=>gate.promise});const controller=new AbortController();const opening=h.authorize(controller.signal);await new Promise(r=>setImmediate(r));controller.abort();gate.resolve({sessionId:'late'});await assert.rejects(opening);assert.equal(h.identities.size,0);
 h.dispose();const gate2=Promise.withResolvers();const other=await fixture(t,{launch:()=>gate2.promise});const pending=other.authorize();await new Promise(r=>setImmediate(r));other.dispose();gate2.resolve({sessionId:'late'});await assert.rejects(pending);assert.equal(other.identities.size,0);
});
test('explicit mock grant never launches GEA and never reads business SQL',async t=>{
 const h=await fixture(t,{mock:true});const grant=await h.authorize();assert.equal(grant.access.mode,'mock');assert.equal(h.launches.length,0);await assert.rejects(grant.readSql({},new AbortController().signal),/MOCK_DATA_ONLY/);
});
test('actual SQL permission refusal stays a refusal rather than selecting another Consumer',async t=>{
 const h=await fixture(t,{queryError:'RESOURCE_ACCESS_DENIED'});const grant=await h.authorize();await assert.rejects(grant.readSql({sql:'select 1'},new AbortController().signal),/RESOURCE_ACCESS_DENIED/);assert.deepEqual(h.launches,['inventory-grant-consumer']);
});

test('releasing an obsolete business grant cannot clear the replacement projection of the same page',async t=>{
 const h=await fixture(t);const old=await h.authorize();const current=await h.authorize();old.release();assert.equal(h.identities.size,1);current.release();assert.equal(h.identities.size,0);
});
