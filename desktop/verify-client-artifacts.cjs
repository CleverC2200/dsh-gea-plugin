/** Reject stale browser optimization receipts before signing or distributing a payload. */
const {readFileSync,realpathSync,existsSync}=require('node:fs');
const {resolve,sep}=require('node:path');
const {createHash}=require('node:crypto');
module.exports=function verifyClientArtifacts(payload){
  const root=realpathSync(payload),modules=realpathSync(resolve(root,'node_modules'));
  let archive;
  if(existsSync(resolve(root,'core-layout.json'))){
    const layout=JSON.parse(readFileSync(resolve(root,'core-layout.json'),'utf8'));
    if(layout.schema!==1||layout.runtimeVersion!==1||layout.archive!=='node_modules.asar')throw Error('CORE_LAYOUT_INVALID');
    archive=resolve(root,layout.archive);
    if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==layout.archiveSha256)throw Error('CORE_ARCHIVE_CHANGED');
  }
  const receipt=JSON.parse(readFileSync(resolve(root,'client-artifacts.json'),'utf8'));
  if(!Array.isArray(receipt.files)||!receipt.files.length)throw Error('CLIENT_ARTIFACT_RECEIPT_INVALID');
  const seen=new Set();
  for(const record of receipt.files){
    if(typeof record.file!=='string'||seen.has(record.file)||!/^[a-f0-9]{64}$/.test(record.afterSha256))throw Error('CLIENT_ARTIFACT_RECEIPT_INVALID');
    seen.add(record.file);
    const candidate=resolve(root,record.file);
    if(!candidate.startsWith(modules+sep))throw Error('CLIENT_ARTIFACT_PATH_INVALID');
    if(archive&&!existsSync(candidate)){
      const asar=require('@electron/asar');
      if(createHash('sha256').update(asar.extractFile(archive,record.file)).digest('hex')!==record.afterSha256)throw Error('CLIENT_ARTIFACT_DIGEST_MISMATCH: '+record.file);
      JSON.parse(asar.extractFile(archive,record.file+'.map').toString('utf8'));
      continue;
    }
    const file=realpathSync(candidate);
    if(!file.startsWith(modules+sep))throw Error('CLIENT_ARTIFACT_PATH_INVALID');
    const hash=createHash('sha256').update(readFileSync(file)).digest('hex');
    if(hash!==record.afterSha256)throw Error('CLIENT_ARTIFACT_DIGEST_MISMATCH: '+record.file);
    const map=realpathSync(file+'.map');
    if(!map.startsWith(modules+sep))throw Error('CLIENT_ARTIFACT_PATH_INVALID');
    JSON.parse(readFileSync(map,'utf8'));
  }
  return receipt.files.length;
};
