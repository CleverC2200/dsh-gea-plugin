import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir,mkdtemp,readFile,readdir,lstat,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
const {values}=parseArgs({options:{output:{type:'string'}}});
assert.equal(process.platform,'win32');
const root=await mkdtemp(join(process.env.RUNNER_TEMP,'manage-archive-'));
const url='https://synear-gea.oss-cn-hangzhou.aliyuncs.com/plugin-release/packages/1986d95171bd406f4d4830f3338f643fb3d2c26b9925deb7b0b7ac3dd510301e/dsh-agent-manage-0.6.3-company.23.tgz';
const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000)});assert.equal(response.status,200);
const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,800720);assert.equal(createHash('sha256').update(bytes).digest('hex'),'1986d95171bd406f4d4830f3338f643fb3d2c26b9925deb7b0b7ac3dd510301e');
const archive=join(root,'manage.tgz');await writeFile(archive,bytes);
const target=join(root,'extracted');await mkdir(target);
execFileSync('tar',['-xzf',archive,'-C',target],{timeout:60000,windowsHide:true});
const actual=[];
async function files(dir,prefix=''){for(const row of await readdir(dir,{withFileTypes:true})){const name=prefix+row.name;if(row.isDirectory())await files(join(dir,row.name),name+'/');else{assert(row.isFile());actual.push(name)}}}
await files(target);
const report={status:'actual-windows-manage-archive-probe',packageSha256:'1986d95171bd406f4d4830f3338f643fb3d2c26b9925deb7b0b7ac3dd510301e',actualFiles:actual.length,nonAsciiFiles:actual.filter(n=>/[^\x00-\x7F]/.test(n)).length,variants:[]};
for(const locale of [null,'C.UTF-8','en_US.UTF-8','.UTF-8']){
 const env={...process.env,...(locale?{LANG:locale,LC_ALL:locale}:{})};
 const output=execFileSync('tar',['-tzf',archive],{env,encoding:'utf8',timeout:30000,windowsHide:true});
 const listed=output.trim().split(/\r?\n/).filter(n=>!n.endsWith('/'));
 const missing=listed.filter(n=>!actual.includes(n));
 const unlisted=actual.filter(n=>!listed.includes(n));
 const sample=actual.find(n=>/[^\x00-\x7F]/.test(n));
 let directRead=false;
 if(sample){try{const streamed=execFileSync('tar',['-xOf',archive,sample],{env,timeout:30000,windowsHide:true});directRead=streamed.equals(await readFile(join(target,sample)));}catch{directRead=false;}}
 report.variants.push({locale:locale??'default',listedFiles:listed.length,missingCount:missing.length,unlistedCount:unlisted.length,listedMatchesActual:missing.length===0&&unlisted.length===0,directUnicodeReadMatches:directRead,missingExamples:missing.slice(0,6),unlistedExamples:unlisted.slice(0,6)});
 await writeFile(values.output,JSON.stringify(report,null,2)+'\n');
}
const index=execFileSync('tar',['-cf','-','--format=mtree','--options=mtree:!all,type','@'+archive],{encoding:'buffer',timeout:30000,windowsHide:true});
const indexed=[];
for(const line of index.toString('ascii').trim().split(/\r?\n/)){
 if(line==='#mtree')continue;
 const match=/^(\S+) type=(file|dir)$/.exec(line);assert(match,'MTREE_ENTRY_INVALID');
 const raw=Buffer.from(match[1].replace(/\\([0-7]{3})/g,(_,octal)=>String.fromCharCode(parseInt(octal,8))),'latin1');
 const name=new TextDecoder('utf-8',{fatal:true}).decode(raw);assert(name.startsWith('./package/'));
 if(match[2]==='file')indexed.push(name.slice(2));
}
assert.equal(indexed.length,new Set(indexed).size);
const missing=indexed.filter(n=>!actual.includes(n)),unlisted=actual.filter(n=>!indexed.includes(n));
report.candidate={format:'mtree',files:indexed.length,missingCount:missing.length,unlistedCount:unlisted.length,allFileBytesMatch:false};
await writeFile(values.output,JSON.stringify(report,null,2)+'\n');
assert.equal(missing.length,0);assert.equal(unlisted.length,0);
for(const name of indexed){const streamed=execFileSync('tar',['-xOf',archive,name],{timeout:30000,windowsHide:true});assert(streamed.equals(await readFile(join(target,name))),'ARCHIVE_FILE_BYTES_MISMATCH');}
report.candidate.allFileBytesMatch=true;
await writeFile(values.output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,baselineMismatch:!report.variants[0].listedMatchesActual,candidate:report.candidate}));
