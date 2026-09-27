/** Immutable prepared plugin graphs and an atomic per-user selection. Never stores login data. */
import {mkdir,readFile,writeFile,rename,rm,open,lstat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {relocateVirtualStore} from './copy-graph.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {withPluginStoreLock} from './plugin-store-lock.mjs';
import {collectPluginStorage,pruneUnreferencedArchives} from './plugin-storage.mjs';
import {readCoreLayout,readCachedCore,ensureCoreCache,materializeGraph,compactGraph} from './core-layer.mjs';
import {physicalFs} from './physical-fs.mjs';

function versionId(id) {
  if(typeof id!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id)||id==='baseline')throw Error('INVALID_VERSION_ID');
  return id;
}
async function json(path) {return JSON.parse(await readFile(path,'utf8'));}
function compatibleReceipt(receipt,schema){
  return receipt.layout==='layered'
    ? receipt.coreDataSchema===schema&&receipt.dataSchema===`layered-v1:${schema}`
    : (receipt.dataSchema??1)===schema;
}
async function atomic(path,value) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  const file=await open(temporary,'wx',0o600);
  try {await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  await rename(temporary,path);
}
export class PluginStore {
  constructor({data,baseline,dataSchema=1}) {
    this.root=join(resolve(data),'plugins');this.baseline=resolve(baseline);this.dataSchema=dataSchema;
  }
  async withLock(action,options){return withPluginStoreLock(this.root,action,options);}
  async collectGarbage(){
    if(this.maintenanceTask)return this.maintenanceTask;
    const task=collectPluginStorage(this);this.maintenanceTask=task;
    try{return await task;}finally{if(this.maintenanceTask===task)this.maintenanceTask=undefined;}
  }
  async status() {
    try{return await json(join(this.root,'selection.json'));}
    catch(error){if(error.code!=='ENOENT')throw Error('PLUGIN_SELECTION_INVALID');return {active:'baseline',previous:null};}
  }
  async selected() {
    const {active}=await this.status();
    if(active==='baseline'){
      const layout=await readCoreLayout(this.baseline);
      return {id:active,path:this.baseline,...(layout?{core:{path:layout.path,metadata:layout.layout}}:{})};
    }
    versionId(active);
    const path=join(this.root,'versions',active);
    const receipt=await json(join(path,'version.json'));
    if(receipt.id!==active||receipt.state!=='prepared')throw Error('PLUGIN_VERSION_NOT_PREPARED');
    if(!compatibleReceipt(receipt,this.dataSchema))throw Error('DATA_SCHEMA_INCOMPATIBLE');
    if(receipt.layout==='layered'){
      const core=await readCachedCore(this.root,receipt.coreId),layer=await json(join(path,'layer.json'));
      if(layer.schema!==1||layer.coreId!==core.id||JSON.stringify(layer.packages)!==JSON.stringify(core.metadata.packages))throw Error('PLUGIN_LAYER_INVALID');
      return {id:active,path,receipt,core};
    }
    return {id:active,path,receipt};
  }
  async prepare({id,install,signal}) {
    versionId(id);
    await mkdir(join(this.root,'versions'),{recursive:true,mode:0o700});
    return this.withLock(async(owner,lockPath)=>{
    const stage=join(this.root,'staging-'+randomUUID());
    try {
      const current=await this.selected();
      await mkdir(stage,{recursive:true,mode:0o700});
      // Copy only distributable code and locks, never node binaries, connection files or user state.
      await materializeGraph(current,stage,{signal});
      signal?.throwIfAborted();
      await relocateVirtualStore(stage,{sourceDirectory:current.path,storeRoot:this.root});
      await install(stage,{registerProcess:async workerPid=>atomic(lockPath,{...owner,workerPid})});
      await relocateVirtualStore(stage);
      await pruneUnreferencedArchives(stage);
      const manifest=await json(join(stage,'package.json'));
      if(manifest.desktopDataSchema!==undefined&&manifest.desktopDataSchema!==this.dataSchema)throw Error('DATA_SCHEMA_UNSUPPORTED');
      const versions={};
      const dependency=createRequire(join(stage,'package.json'));
      for(const name of Object.keys(manifest.dependencies??{})) {
        const pkg=await json(dependency.resolve(name+'/package.json'));
        if(pkg.desktopDataSchema!==undefined&&pkg.desktopDataSchema!==this.dataSchema)throw Error('DATA_SCHEMA_UNSUPPORTED');
        versions[name]=pkg.version;
      }
      const lockBytes=await readFile(join(stage,'pnpm-lock.yaml')).catch(error=>{if(error.code==='ENOENT')return Buffer.alloc(0);throw error;});
      if(!this.corePromise)this.corePromise=ensureCoreCache(this.baseline,this.root).catch(error=>{this.corePromise=undefined;throw error;});
      const core=await this.corePromise;
      signal?.throwIfAborted();
      const layout=await compactGraph(stage,core);
      signal?.throwIfAborted();
      // Old desktops compare this field strictly. Refuse a layered graph there
      // instead of allowing an old standalone Node to execute an incomplete tree.
      const schema=layout.layout==='layered'?{dataSchema:`layered-v1:${this.dataSchema}`,coreDataSchema:this.dataSchema}:{dataSchema:this.dataSchema};
      const receipt={id,state:'prepared',...schema,createdAt:new Date().toISOString(),dependencies:manifest.dependencies??{},versions,lockSha256:createHash('sha256').update(lockBytes).digest('hex'),...layout};
      await atomic(join(stage,'version.json'),receipt);
      // The store-wide lock serializes claims; never replace an existing version id.
      const destination=join(this.root,'versions',id);
      try {await lstat(destination);throw Error('PLUGIN_VERSION_EXISTS');}
      catch(error){if(error.code!=='ENOENT')throw error;}
      await rename(stage,destination);
      return receipt;
    } finally {
      await physicalFs.rm(stage,{recursive:true,force:true});
    }
    });
  }
  async recoverPreparation() {
    const path=join(this.root,'prepare.lock');
    let owner;
    try {owner=await json(path);}catch(error){if(error.code==='ENOENT')return 'idle';throw Error('PLUGIN_PREPARATION_LOCK_INVALID');}
    const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
    let groupAlive=false;
    if(process.platform!=='win32'&&Number.isSafeInteger(owner.workerPid)) {
      try{process.kill(-owner.workerPid,0);groupAlive=true;}catch(error){groupAlive=error.code!=='ESRCH';}
    }
    if(alive(owner.pid)||alive(owner.workerPid)||groupAlive)return 'busy';
    // Retain abandoned staging directories: an unregistered descendant may still own one.
    // A retry gets a different directory and never deletes potentially live installation files.
    await rm(path,{force:true});return 'recovered';
  }
  async beginBoot() {
    return this.withLock(async()=>{
    await mkdir(this.root,{recursive:true,mode:0o700});
    let state=await this.status();
    if(this.dataSchema===2&&(state.dataSchema??1)===1){
      // Reserve the new data generation before any new-core writes; old shells refuse it.
      state={active:'baseline',previous:null,verified:'baseline',booting:null,dataSchema:2,upgradedFrom:state};
      await atomic(join(this.root,'selection.json'),state);
    }
    if((state.dataSchema??1)!==this.dataSchema)throw Error("DATA_SCHEMA_INCOMPATIBLE");
    // A previous unconfirmed boot was interrupted. Recover before touching shared user data.
    if(state.booting) {
      state={...state,active:state.verified??state.previous??'baseline',previous:state.active,booting:null,error:'PREVIOUS_BOOT_INTERRUPTED'};
      await atomic(join(this.root,'selection.json'),state);
    }
    await atomic(join(this.root,'selection.json'),{...state,booting:state.active});
    return this.selected();
    });
  }
  async confirmBoot() {
    return this.withLock(async()=>{
    const state=await this.status();
    await atomic(join(this.root,'selection.json'),{...state,booting:null,verified:state.active,error:null,dataSchema:this.dataSchema});
    });
  }
  async failBoot(reason) {
    return this.withLock(async()=>{
    const state=await this.status();
    const fallback=state.verified??state.previous??'baseline';
    await atomic(join(this.root,'selection.json'),{...state,active:fallback,previous:state.active,booting:null,error:reason});
    return fallback;
    });
  }
  async activate(id) {
    return this.withLock(async()=>{
    const current=await this.status();
    if((current.dataSchema??1)!==this.dataSchema)throw Error("DATA_SCHEMA_INCOMPATIBLE: preserve data; restore a compatible application");
    if(id!=='baseline') {
      versionId(id);
      const receipt=await json(join(this.root,'versions',id,'version.json'));
      if(receipt.id!==id||receipt.state!=='prepared')throw Error('PLUGIN_VERSION_NOT_PREPARED');
      if(!compatibleReceipt(receipt,this.dataSchema))throw Error('DATA_SCHEMA_INCOMPATIBLE');
    }
    await mkdir(this.root,{recursive:true,mode:0o700});
    const state=await this.status();
    await atomic(join(this.root,'selection.json'),{...state,active:id,previous:state.active,verified:state.verified??state.active,booting:null});
    });
  }
}
