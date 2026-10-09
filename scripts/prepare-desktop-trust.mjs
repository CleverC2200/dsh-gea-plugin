import {readFile,writeFile} from 'node:fs/promises';
import {X509Certificate} from 'node:crypto';
import {join} from 'node:path';

/** Public certificate only. Private keys and passwords never enter application files. */
export async function prepareDesktopTrust(staging,{target,env=process.env}={}){
  let trust={schema:1,mode:'legacy-unsigned',publishers:[]};
  if(target==='win'&&(env.WIN_CSC_LINK||env.CSC_LINK||env.GEA_WIN_REQUIRE_SIGNING==='1')){
    if(!env.GEA_WIN_PUBLISHER_CERT)throw Error('WINDOWS_PUBLISHER_CERT_REQUIRED');
    const cert=new X509Certificate(await readFile(env.GEA_WIN_PUBLISHER_CERT));
    if(!['CN=','O=','C='].every(key=>cert.subject.split('\n').some(line=>line.startsWith(key)&&line.length>key.length)))throw Error('WINDOWS_PUBLISHER_SUBJECT_INVALID');
    trust={schema:1,mode:'required',publishers:[cert.subject]};
  }
  await writeFile(join(staging,'windows-update-trust.json'),JSON.stringify(trust,null,2)+'\n');
  return trust;
}
