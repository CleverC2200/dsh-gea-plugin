import {readFile,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Bootstrap helper imports with the same frozen core as the eventual Host. */
export async function openCoreRuntime(core,graph,home){
  if(!process.versions.electron)throw Error('LAYERED_RUNTIME_REQUIRES_ELECTRON');
  const require=createRequire(join(core,'package.json'));
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const {createProfileResolutionGeneration,PluginPackages}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  const layer=JSON.parse(await readFile(join(graph,'layer.json'),'utf8'));
  if(layer.schema!==1||!layer.packages)throw Error('GEA_LAYER_INVALID');
  const original=await createProfileResolutionGeneration({installAnchor:require.resolve('@deepseek-ai/dsh/package.json'),profile:{dir:graph,layers:[],patches:[],name:'gea-bootstrap',patchReload:'startup'},home});
  const generation={...original,profileDir:await realpath(graph),entries:Object.entries(layer.packages).map(([name,meta])=>{
    if(!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))throw Error('GEA_LAYER_PACKAGE_INVALID');
    return {name,packageDir:join(core,'node_modules',name),declarer:join(core,'package.json'),version:meta.version,scope:'installation'};
  })};
  const ctx=new Context();await ctx.plugin(PluginPackages,{generation});return ctx;
}
