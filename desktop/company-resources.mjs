/** Release-owned suite source; archives work without Git or maintainer credentials. */
import {cp,lstat,mkdir,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const companySources=[{id:'company-agent-suites',kind:'archive',url:'https://api.github.com/repos/CleverC2200/company-agent-suites/zipball/main'}];

/** Seed the offline catalog once. Later user refreshes and edits remain untouched. */
export async function provisionCompanyResources(payload,home) {
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
