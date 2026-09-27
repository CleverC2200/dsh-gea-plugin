/** Reclaim only owned, unreferenced automatic graphs after a verified boot. */
import {lstat,readFile,readdir,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {physicalFs} from './physical-fs.mjs';

const automatic=/^channel-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const trashName=/^gc-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const optional=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
async function directory(path){
  const s=await lstat(path);
  if(!s.isDirectory()||s.isSymbolicLink())throw Error('PLUGIN_STORAGE_UNSAFE_PATH');
}
function protect(state,ids,depth=0){
  if(!state||typeof state!=='object'||depth>8)return;
  for(const key of ['active','previous','verified','booting'])if(typeof state[key]==='string')ids.add(state[key]);
  protect(state.upgradedFrom,ids,depth+1);
}

export async function collectPluginStorage(store){
  let plan;
  try{
    plan=await store.withLock(async()=>{
      await directory(store.root);
      const state=await store.status();
      if(state.booting||state.error||state.active!==state.verified)return {skipped:'boot-not-verified'};
      // Validate the active receipt before considering any other graph for removal.
      await store.selected();
      const update=await optional(join(store.root,'update-state.json'));
      if(['downloading','installing','restarting'].includes(update?.phase))return {skipped:'update-in-progress'};
      const ids=new Set(['baseline']);protect(state,ids);
      if(typeof update?.pending==='string'&&update.phase==='pending')ids.add(update.pending);
      const versions=join(store.root,'versions'),trash=join(store.root,'trash');
      try{await directory(versions);}catch(error){if(error.code==='ENOENT')return {skipped:'no-versions'};throw error;}
      await mkdir(trash,{recursive:true,mode:0o700});await directory(trash);
      const candidates=[];const retained=[];
      for(const entry of await readdir(versions,{withFileTypes:true})){
        const id=entry.name;
        if(ids.has(id)||!automatic.test(id)||!entry.isDirectory()||entry.isSymbolicLink()){retained.push(id);continue;}
        const path=join(versions,id);
        try{
          await directory(path);
          const receiptPath=join(path,'version.json');const meta=await lstat(receiptPath);
          if(!meta.isFile()||meta.isSymbolicLink())throw Error('INVALID_RECEIPT');
          const receipt=await optional(receiptPath);
          if(receipt?.id!==id||receipt.state!=='prepared'||receipt.pinned===true){retained.push(id);continue;}
          const token=randomUUID(),target=join(trash,'gc-'+token),marker=target+'.json';
          await writeFile(marker,JSON.stringify({schema:1,id,token}),{flag:'wx',mode:0o600});
          try{await rename(path,target);candidates.push({id,path:target,marker});}
          catch(error){await rm(marker,{force:true});throw error;}
        }catch{retained.push(id);}
      }
      const coreIds=new Set();let coreInventoryValid=true;
      try{
        if((await readdir(store.root)).some(name=>name.startsWith('staging-')))coreInventoryValid=false;
        for(const entry of await readdir(versions,{withFileTypes:true})){
          if(!entry.isDirectory()||entry.isSymbolicLink()){coreInventoryValid=false;continue;}
          const receipt=await optional(join(versions,entry.name,'version.json'));
          if(!receipt||receipt.id!==entry.name){coreInventoryValid=false;continue;}
          if(receipt.coreId)coreIds.add(receipt.coreId);
        }
        const preparedCore=await store.corePromise;if(preparedCore)coreIds.add(preparedCore.id);
        const cores=join(store.root,'cores');
        try{await directory(cores);}catch(error){if(error.code!=='ENOENT')throw error;}
        if(coreInventoryValid)for(const entry of await readdir(cores).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
          if(!/^[a-f0-9]{64}$/.test(entry)||coreIds.has(entry))continue;
          const path=join(cores,entry);await directory(path);
          const metadata=await optional(join(path,'core.json'));
          if(metadata?.schema!==1||metadata.id!==entry||!/^[a-f0-9]{64}$/.test(metadata.archiveSha256??''))continue;
          const token=randomUUID(),target=join(trash,'gc-'+token),marker=target+'.json';
          await writeFile(marker,JSON.stringify({schema:1,kind:'core',id:entry,token}),{flag:'wx',mode:0o600});
          try{await rename(path,target);candidates.push({id:entry,kind:'core',path:target,marker});}
          catch{await rm(marker,{force:true});}
        }
      }catch{coreInventoryValid=false;}
      // Retry only quarantines created by this collector; never sweep unknown folders.
      for(const entry of await readdir(trash,{withFileTypes:true})){
        if(!trashName.test(entry.name)||!entry.isDirectory()||entry.isSymbolicLink())continue;
        const path=join(trash,entry.name);if(candidates.some(c=>c.path===path))continue;
        try{
          await directory(path);
          const marker=path+'.json';const stat=await lstat(marker);
          if(!stat.isFile()||stat.isSymbolicLink())continue;
          const owner=await optional(marker);
          if(owner?.schema===1&&entry.name==='gc-'+owner.token){
            if(owner.kind==='core'&&coreInventoryValid&&/^[a-f0-9]{64}$/.test(owner.id)&&!coreIds.has(owner.id))candidates.push({id:owner.id,kind:'core',path,marker});
            else if(owner.kind===undefined&&automatic.test(owner.id)&&!ids.has(owner.id))candidates.push({id:owner.id,path,marker});
          }
        }catch{}
      }
      return {candidates,retained};
    },{purpose:'maintenance'});
  }catch(error){return {skipped:error.message==='PLUGIN_UPDATE_BUSY'?'store-busy':'invalid-storage-state',removed:[],failed:[]};}
  if(plan.skipped)return {...plan,removed:[],failed:[]};
  // The writer lock is released before slow recursive removal. Updates may continue.
  const removed=[],coresRemoved=[],failed=[];
  for(const item of plan.candidates){
    try{await physicalFs.rm(item.path,{recursive:true,force:false,maxRetries:0});await rm(item.marker,{force:true});(item.kind==='core'?coresRemoved:removed).push(item.id);}
    catch{failed.push(item.id);}
  }
  return {removed,coresRemoved,failed,retained:plan.retained};
}

/** New graphs need only archives referenced by their final manifest/workspace/lock. */
export async function pruneUnreferencedArchives(graph){
  let declarations='';
  for(const name of ['package.json','pnpm-workspace.yaml','pnpm-lock.yaml']){
    try{declarations+='\n'+await readFile(join(graph,name),'utf8');}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const root=join(graph,'packages');let entries;
  try{entries=await readdir(root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
  await directory(root);
  const removed=[];
  for(const entry of entries){
    // Only content-addressed plugin downloads, never named core archives or user files.
    if(entry.isFile()&&/^[a-f0-9]{64}\.tgz$/.test(entry.name)&&!declarations.includes(entry.name)){
      await rm(join(root,entry.name));removed.push(entry.name);
    }
  }
  return removed;
}
