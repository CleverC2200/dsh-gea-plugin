// Transport-only delta: reuse the unchanged contiguous embedded archive.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const [basePath,targetPath,output]=process.argv.slice(2);
const base=await readFile(basePath),target=await readFile(targetPath);
const hash=b=>createHash('sha256').update(b).digest('hex');
const pivot=Math.floor(base.length/2),anchor=base.subarray(pivot,pivot+4096);
const match=target.indexOf(anchor);
if(match<0)throw Error('No common payload; use full-file transfer');
let startOld=pivot,startNew=match,endOld=pivot+4096,endNew=match+4096;
while(startOld>0&&startNew>0&&base[startOld-1]===target[startNew-1]){startOld--;startNew--;}
while(endOld<base.length&&endNew<target.length&&base[endOld]===target[endNew]){endOld++;endNew++;}
const rebuilt=Buffer.concat([target.subarray(0,startNew),base.subarray(startOld,endOld),target.subarray(endNew)]);
if(!rebuilt.equals(target))throw Error('Delta reconstruction failed');
const patch={schema:1,baseSha256:hash(base),targetSha256:hash(target),offset:startOld,length:endOld-startOld,prefix:target.subarray(0,startNew).toString('base64'),suffix:target.subarray(endNew).toString('base64')};
const bytes=gzipSync(JSON.stringify(patch));
await writeFile(output,bytes,{flag:'wx'});
console.log(JSON.stringify({patchBytes:bytes.length,reusedBytes:patch.length,baseSha256:patch.baseSha256,targetSha256:patch.targetSha256}));
