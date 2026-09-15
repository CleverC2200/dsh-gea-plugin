import {readFile,mkdir,writeFile,cp,lstat,symlink,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {configureWelcomeNotice} from './onboarding.mjs';
const root=dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const runtime=resolve(root,process.env.DSH_FULL_DATA_DIR||'data');
const configPath=resolve(root,process.env.GEA_CONFIG||'gea.config.json');
if(!existsSync(configPath)) {console.error('请先将 gea.config.example.json 复制为 gea.config.json 并填写 GEA 地址。');process.exit(1);}
const port=Number(process.env.DSH_FULL_PORT||'3198');
if(!Number.isInteger(port)||port<0||port>65535)throw Error('INVALID_PORT');
const gea=join(root,'node_modules/@cleverc2200/gea-dsh-prototype');
const {readDeployment,deploymentPatch}=await import(join(gea,'scripts/deployment.mjs'));
const config=await readDeployment(configPath);
await mkdir(runtime,{recursive:true});
await mkdir(join(runtime,'workspace'),{recursive:true});
const native=join(runtime,'native-presets/standard');
await cp(join(root,'node_modules/@deepseek-ai/dsh-agent-presets/presets/standard'),native,{recursive:true});
const patchPath=join(runtime,'deployment.patch.json');
await writeFile(patchPath,JSON.stringify(deploymentPatch(config,gea,runtime),null,2),{mode:0o600});
const home=join(runtime,'home');
await mkdir(home,{recursive:true});
await configureWelcomeNotice(join(home,'settings.yaml'));
const profileDir=join(home,'profiles/full');
await mkdir(profileDir,{recursive:true});
// The writable profile resolves the immutable bundled plugin graph explicitly.
const modules=join(profileDir,'node_modules');
const target=join(root,'node_modules');
try {
  const entry=await lstat(modules);
  if(!entry.isSymbolicLink())throw new Error('PROFILE_MODULES_NOT_OWNED_LINK');
  await unlink(modules);
} catch(error) {if(error.code!=='ENOENT')throw error;}
if(!existsSync(modules))await symlink(target,modules,process.platform==='win32'?'junction':'dir');
const manifestPath=join(profileDir,'package.json');
if(!existsSync(manifestPath)) await writeFile(manifestPath,JSON.stringify({name:'dsh-profile-full',private:true,dependencies:{},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-plugin','@dsh-external/dsh-visualize','dsh-agent-plugins-market'],patchReload:'live'}}},null,2));
const child=spawn(process.execPath,[join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','full','--patch',patchPath,'--host','127.0.0.1','--port',String(port),...(process.env.DSH_FULL_NO_OPEN?['--no-open']:[])],{cwd:root,env:{...process.env,DSH_HOME:home},stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
process.on('message',message=>{if(message?.type==='stop')child.kill('SIGTERM');});
process.on('disconnect',()=>child.kill('SIGTERM'));
child.on('exit',code=>{process.exitCode=code??1;if(process.connected)process.disconnect();});
