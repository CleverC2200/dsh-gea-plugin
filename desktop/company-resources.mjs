/** Release-owned suite source; archives work without Git or maintainer credentials. */
import {cp,lstat,mkdir,rename,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const companySources=[{id:'company-agent-suites',kind:'archive',url:'https://api.github.com/repos/CleverC2200/company-agent-suites/zipball/main'}];

/** Move only the earlier company-managed main-branch source to credential-free archives. */
async function migrateCompanySource(home) {
  const path=join(home,'agent-plugins/state.json');let state;
  try {state=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(state.version!==1||!Array.isArray(state.sources))return;
  let changed=false;
  const sources=state.sources.map(source=>{
    if(source?.id!=='company-agent-suites'||source.local||source.adopted||source.kind==='local'||(source.branch&&source.branch!=='main')||!['https://github.com/CleverC2200/company-agent-suites','https://github.com/CleverC2200/company-agent-suites.git'].includes(source.url))return source;
    changed=true;return {...source,...companySources[0]};
  });
  if(!changed)return;
  const temporary=path+'.'+randomUUID()+'.tmp';
  try {await writeFile(temporary,JSON.stringify({...state,sources},null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,path);}
  finally {await rm(temporary,{force:true});}
}

/** Seed the offline catalog once. Later user refreshes and edits remain untouched. */
export async function provisionCompanyResources(payload,home) {
  await migrateCompanySource(home);
  const parent=join(home,'agent-plugins/.sources');
  const target=join(parent,'company-agent-suites');
  try {await lstat(target);return;}catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(parent,{recursive:true});
  const stage=join(parent,'.company-seed-'+randomUUID());
  try {
    await cp(join(payload,'resources/company-agent-suites'),stage,{recursive:true,errorOnExist:true});
    await rename(stage,target);
  } finally {await rm(stage,{recursive:true,force:true});}
}
