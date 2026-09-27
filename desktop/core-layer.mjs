/** A version owns its mutable packages; one immutable core can serve many versions. */
import {readFile,writeFile,readdir,lstat,realpath,mkdir,rename,rm,copyFile,readlink,symlink} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {copyGraphEntry} from './copy-graph.mjs';
import {executableBits} from './core-file-mode.mjs';
import {physicalFs} from './physical-fs.mjs';

const packageName=/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
export async function packageDigest(root){
  const hash=createHash('sha256');
  async function visit(path,rel){
    const s=await lstat(path);
    if(s.isSymbolicLink())throw Error('CORE_PACKAGE_LINK_UNSUPPORTED');
    if(s.isDirectory())for(const name of (await readdir(path)).sort())await visit(join(path,name),rel?rel+'/'+name:name);
    else if(s.isFile()){hash.update(rel+'\0'+Boolean(await executableBits(path,s))+'\0');hash.update(await readFile(path));hash.update('\0');}
    else throw Error('CORE_PACKAGE_FILE_UNSUPPORTED');
  }
  await visit(root,'');return hash.digest('hex');
}
export async function readCoreLayout(payload){
  let layout;try{layout=await readJson(join(payload,'core-layout.json'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(layout.schema!==1||layout.runtimeVersion!==1||layout.archive!=='node_modules.asar'||!/^[a-f0-9]{64}$/.test(layout.archiveSha256)||!layout.packages||!Object.keys(layout.packages).every(name=>packageName.test(name)))throw Error('CORE_LAYOUT_INVALID');
  return {path:join(payload,layout.archive),layout};
}

/** Traverse actual installed dependencies, without executing target-platform code. */
export async function corePackageInventory(graph,{seeds}={}){
  const modules=join(graph,'node_modules'),physical=await realpath(modules),queue=[];
  if(seeds){for(const name of seeds){if(!packageName.test(name))throw Error('CORE_PACKAGE_NAME');queue.push(join(modules,name));}}
  else for(const name of await readdir(join(modules,'@deepseek-ai')))queue.push(join(modules,'@deepseek-ai',name));
  const seen=new Set(),top=new Set();
  while(queue.length){
    const dir=await realpath(queue.pop());if(seen.has(dir))continue;seen.add(dir);
    const rel=relative(physical,dir);if(rel.startsWith('..')||resolve(physical,rel)!==dir)throw Error('CORE_EXTERNAL_PACKAGE');
    const parts=rel.split(sep),name=parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0];
    if(!packageName.test(name))throw Error('CORE_PACKAGE_NAME');top.add(name);
    const manifest=await readJson(join(dir,'package.json'));
    // Company and external mutable bundle roots must not shadow profile bundles.
    if(manifest.dsh?.bundle&&!name.startsWith('@deepseek-ai/'))throw Error('CORE_MUTABLE_BUNDLE_DEPENDENCY');
    const require=createRequire(join(dir,'package.json'));
    const dependencies={...manifest.dependencies,...manifest.optionalDependencies,...manifest.peerDependencies};
    for(const dependency of Object.keys(dependencies)){
      if(!packageName.test(dependency))throw Error('CORE_PACKAGE_NAME');
      let found=false;
      for(const search of require.resolve.paths(dependency)??[]){
        const candidate=join(search,dependency);
        if(!candidate.startsWith(physical+sep))continue;
        try{await lstat(join(candidate,'package.json'));queue.push(candidate);found=true;break;}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTDIR')throw error;}
      }
      if(!found&&manifest.dependencies?.[dependency]&&!manifest.optionalDependencies?.[dependency])throw Error('CORE_DEPENDENCY_MISSING: '+dependency);
    }
  }
  const packages={};
  for(const name of [...top].sort()){
    const path=join(modules,name),manifest=await readJson(join(path,'package.json'));
    packages[name]={version:manifest.version,sha256:await packageDigest(path)};
  }
  return packages;
}

/** Called in Electron (ASAR-aware fs). Plain legacy graphs remain supported. */
export async function ensureCoreCache(payload,root){
  const source=await readCoreLayout(payload);if(!source)return null;
  if(digest(await physicalFs.readFile(source.path))!==source.layout.archiveSha256)throw Error('CORE_ARCHIVE_CHANGED');
  // Final signatures can change unpacked native bytes: identify the installed
  // final core, not a pre-signing build directory, once per preparation owner.
  const packages={};
  for(const [name,meta] of Object.entries(source.layout.packages))packages[name]={version:meta.version,sha256:await packageDigest(join(source.path,'node_modules',name))};
  const id=digest(Buffer.from(JSON.stringify({archive:source.layout.archiveSha256,packages})));
  const cores=join(root,'cores'),destination=join(cores,id);
  await mkdir(cores,{recursive:true,mode:0o700});
  const dir=await lstat(cores);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('CORE_CACHE_UNSAFE');
  try{return await readCachedCore(root,id);}catch(error){if(error.code!=='ENOENT')throw error;}
  const stage=join(cores,'staging-'+randomUUID());await mkdir(stage,{mode:0o700});
  try{
    await physicalFs.copyFile(source.path,join(stage,'node_modules.asar'));
    try{await copyGraphEntry(source.path+'.unpacked',join(stage,'node_modules.asar.unpacked'));}catch(error){if(error.code!=='ENOENT')throw error;}
    await writeFile(join(stage,'core.json'),JSON.stringify({schema:1,id,archiveSha256:source.layout.archiveSha256,packages}),{mode:0o600});
    await rename(stage,destination);
  }finally{await physicalFs.rm(stage,{recursive:true,force:true});}
  return readCachedCore(root,id);
}
export async function readCachedCore(root,id){
  if(!/^[a-f0-9]{64}$/.test(id??''))throw Error('CORE_ID_INVALID');
  const directory=join(root,'cores',id),stat=await lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('CORE_CACHE_UNSAFE');
  const metadata=await readJson(join(directory,'core.json'));
  if(metadata.schema!==1||metadata.id!==id||!metadata.packages||!Object.keys(metadata.packages).every(name=>packageName.test(name)))throw Error('CORE_CACHE_INVALID');
  return {id,path:join(directory,'node_modules.asar'),metadata};
}
export async function materializeGraph(selected,target,{signal}={}){
  if(selected.core){
    for(const name of ['node_modules','packages'])try{await copyGraphEntry(join(selected.core.path,name),join(target,name),{signal});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(selected.core){
    // macOS pnpm shims can be links to the now-archived core. Rebase those
    // links into the hydrated graph instead of dereferencing the missing source.
    for(const entry of await readdir(join(selected.path,'node_modules'),{withFileTypes:true})){
      if(entry.name!=='.bin')await copyGraphEntry(join(selected.path,'node_modules',entry.name),join(target,'node_modules',entry.name),{signal});
    }
    const bin=join(selected.path,'node_modules/.bin');
    try{
      await mkdir(join(target,'node_modules/.bin'),{recursive:true});
      for(const entry of await readdir(bin,{withFileTypes:true})){
        const source=join(bin,entry.name),destination=join(target,'node_modules/.bin',entry.name);
        if(entry.isSymbolicLink()){
          const link=await readlink(source),rebased=resolve(join(selected.path,'node_modules/.bin'),link);
          const rel=relative(join(selected.path,'node_modules'),rebased);
          if(rel.startsWith('..')||resolve(join(selected.path,'node_modules'),rel)!==rebased)throw Error('CORE_BIN_LINK_UNSAFE');
          await rm(destination,{force:true});await symlink(relative(join(target,'node_modules/.bin'),join(target,'node_modules',rel)),destination,'file');
        }else await copyGraphEntry(source,destination,{signal});
      }
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  for(const name of [...(selected.core?[]:['node_modules']),'package.json','packages','pnpm-lock.yaml','pnpm-workspace.yaml']){
    try{await copyGraphEntry(join(selected.path,name),join(target,name),{signal});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
export async function compactGraph(graph,core){
  if(!core)return {layout:'full'};
  // Freeze the complete core closure. If even an unchanged A would resolve a
  // changed B from another graph, keep the full graph instead of altering it.
  let current;
  try{current=await corePackageInventory(graph,{seeds:Object.keys(core.metadata.packages)});}
  catch(error){if(error.code==='ENOENT'||error.message.startsWith('CORE_'))return {layout:'full',reason:'core-dependency-changed'};throw error;}
  if(JSON.stringify(current)!==JSON.stringify(core.metadata.packages))return {layout:'full',reason:'core-dependency-changed'};
  for(const name of Object.keys(core.metadata.packages))await rm(join(graph,'node_modules',name),{recursive:true});
  // Identical baseline archives are available from the core during hydration.
  try{for(const entry of await readdir(join(graph,'packages'),{withFileTypes:true}))if(entry.isFile()){
    const file=join(graph,'packages',entry.name);try{if(digest(await readFile(file))===digest(await readFile(join(core.path,'packages',entry.name))))await rm(file);}catch(error){if(error.code!=='ENOENT')throw error;}
  }}catch(error){if(error.code!=='ENOENT')throw error;}
  await writeFile(join(graph,'layer.json'),JSON.stringify({schema:1,coreId:core.id,packages:core.metadata.packages}),{mode:0o600});
  return {layout:'layered',coreId:core.id};
}
