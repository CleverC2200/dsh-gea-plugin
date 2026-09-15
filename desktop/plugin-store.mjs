/** Immutable prepared plugin graphs and an atomic per-user selection. Never stores login data. */
import {mkdir,readFile,writeFile,rename,cp,rm,open,lstat,link,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {constants} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';

function versionId(id) {
  if(typeof id!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(id)||id==='baseline')throw Error('INVALID_VERSION_ID');
  return id;
}
async function json(path) {return JSON.parse(await readFile(path,'utf8'));}
async function atomic(path,value) {
  const temporary=path+'.'+randomUUID()+'.tmp';
  const file=await open(temporary,'wx',0o600);
  try {await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  await rename(temporary,path);
}
export class PluginStore {
  constructor({data,baseline}) {
    this.root=join(resolve(data),'plugins');this.baseline=resolve(baseline);
  }
  async status() {
    try{return await json(join(this.root,'selection.json'));}
    catch(error){if(error.code!=='ENOENT')throw Error('PLUGIN_SELECTION_INVALID');return {active:'baseline',previous:null};}
  }
  async selected() {
    const {active}=await this.status();
    if(active==='baseline')return {id:active,path:this.baseline};
    versionId(active);
    const path=join(this.root,'versions',active);
    const receipt=await json(join(path,'version.json'));
    if(receipt.id!==active||receipt.state!=='prepared')throw Error('PLUGIN_VERSION_NOT_PREPARED');
    return {id:active,path,receipt};
  }
  async prepare({id,install}) {
    versionId(id);
    await mkdir(join(this.root,'versions'),{recursive:true,mode:0o700});
    const lockPath=join(this.root,'prepare.lock');
    const owner={pid:process.pid,token:randomUUID()};
    const claim=join(this.root,'claim-'+owner.token);
    await writeFile(claim,JSON.stringify(owner),{flag:'wx',mode:0o600});
    try {await link(claim,lockPath);}catch(error){if(error.code==='EEXIST')throw Error('PLUGIN_UPDATE_BUSY');throw error;}
    finally {await rm(claim,{force:true});}
    const stage=join(this.root,'staging-'+randomUUID());
    try {
      const current=await this.selected();
      await mkdir(stage,{recursive:true,mode:0o700});
      // Copy only distributable code and locks, never node binaries, connection files or user state.
      for (const name of ['node_modules','package.json','packages','pnpm-lock.yaml','pnpm-workspace.yaml']) {
        await cp(join(current.path,name),join(stage,name),{recursive:true,dereference:true,mode:constants.COPYFILE_FICLONE}).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }
      await install(stage,{registerProcess:async workerPid=>atomic(lockPath,{...owner,workerPid})});
      const manifest=await json(join(stage,'package.json'));
      if(manifest.desktopDataSchema!==undefined&&manifest.desktopDataSchema!==1)throw Error('DATA_SCHEMA_UNSUPPORTED');
      const versions={};
      const dependency=createRequire(join(stage,'package.json'));
      for(const name of Object.keys(manifest.dependencies??{})) {
        const pkg=await json(dependency.resolve(name+'/package.json'));
        if(pkg.desktopDataSchema!==undefined&&pkg.desktopDataSchema!==1)throw Error('DATA_SCHEMA_UNSUPPORTED');
        versions[name]=pkg.version;
      }
      const lockBytes=await readFile(join(stage,'pnpm-lock.yaml')).catch(error=>{if(error.code==='ENOENT')return Buffer.alloc(0);throw error;});
      const receipt={id,state:'prepared',dataSchema:1,createdAt:new Date().toISOString(),dependencies:manifest.dependencies??{},versions,lockSha256:createHash('sha256').update(lockBytes).digest('hex')};
      await atomic(join(stage,'version.json'),receipt);
      // The store-wide lock serializes claims; never replace an existing version id.
      const destination=join(this.root,'versions',id);
      try {await lstat(destination);throw Error('PLUGIN_VERSION_EXISTS');}
      catch(error){if(error.code!=='ENOENT')throw error;}
      await rename(stage,destination);
      return receipt;
    } finally {
      await rm(stage,{recursive:true,force:true});
      if((await json(lockPath)).token===owner.token)await rm(lockPath,{force:true});
    }
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
    await mkdir(this.root,{recursive:true,mode:0o700});
    const state=await this.status();
    if((state.dataSchema??1)!==1)throw Error("DATA_SCHEMA_INCOMPATIBLE");
    // A previous unconfirmed boot was interrupted. Recover before touching shared user data.
    if(state.booting) {
      await this.failBoot('PREVIOUS_BOOT_INTERRUPTED');
      return this.beginBoot();
    }
    await atomic(join(this.root,'selection.json'),{...state,booting:state.active});
    return this.selected();
  }
  async confirmBoot() {
    const state=await this.status();
    await atomic(join(this.root,'selection.json'),{...state,booting:null,verified:state.active,error:null,dataSchema:1});
  }
  async failBoot(reason) {
    const state=await this.status();
    const fallback=state.verified??state.previous??'baseline';
    await atomic(join(this.root,'selection.json'),{...state,active:fallback,previous:state.active,booting:null,error:reason});
    return fallback;
  }
  async activate(id) {
    const current=await this.status();
    if((current.dataSchema??1)!==1)throw Error("DATA_SCHEMA_INCOMPATIBLE: preserve data; restore a compatible application");
    if(id!=='baseline') {
      versionId(id);
      const receipt=await json(join(this.root,'versions',id,'version.json'));
      if(receipt.id!==id||receipt.state!=='prepared')throw Error('PLUGIN_VERSION_NOT_PREPARED');
    }
    await mkdir(this.root,{recursive:true,mode:0o700});
    const state=await this.status();
    await atomic(join(this.root,'selection.json'),{...state,active:id,previous:state.active,verified:state.verified??state.active,booting:null});
  }
}
