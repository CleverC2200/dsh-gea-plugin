import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {copyGraphEntry} from './copy-graph.mjs';

test('graph copies preserve bytes, executables and resolved links without sharing writable files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea copy '));t.after(()=>rm(root,{recursive:true,force:true}));
 const src=join(root,'src'),dst=join(root,'dst');await mkdir(join(src,'nested'),{recursive:true});
 await Promise.all(Array.from({length:96},(_,i)=>writeFile(join(src,'nested',String(i)),String(i))));
 await writeFile(join(src,'run'),'original',{mode:0o755});
 if(process.platform!=='win32')await symlink('run',join(src,'linked'));
 await copyGraphEntry(src,dst);
 assert.equal(await readFile(join(dst,'nested','95'),'utf8'),'95');
 if(process.platform!=='win32'){assert.equal((await stat(join(dst,'run'))).mode&0o777,0o755);assert.equal(await readFile(join(dst,'linked'),'utf8'),'original');}
 await writeFile(join(dst,'run'),'new');assert.equal(await readFile(join(src,'run'),'utf8'),'original');
 await rm(dst,{recursive:true});assert.equal(await readFile(join(src,'run'),'utf8'),'original');
});
test('cancelled copy drains work before returning and failed copies reject',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-cancel-copy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(copyGraphEntry(root,join(root,'unused'),{signal:AbortSignal.abort()}),{name:'AbortError'});
 await assert.rejects(copyGraphEntry(join(root,'missing'),join(root,'dst')),{code:'ENOENT'});
});


test('mid-copy cancellation settles all writes before staging can be removed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-copy-abort-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const src=join(root,'src'),dst=join(root,'dst');await mkdir(src);
 await Promise.all(Array.from({length:100},(_,i)=>writeFile(join(src,String(i)),Buffer.alloc(1024))));
 const controller=new AbortController();
 const copying=copyGraphEntry(src,dst,{signal:controller.signal});
 const timer=setTimeout(()=>controller.abort(),1);
 try {await assert.rejects(copying,{name:'AbortError'});}finally{clearTimeout(timer);}
 await rm(dst,{recursive:true,force:true});
 await new Promise(resolve=>setTimeout(resolve,10));
 await assert.rejects(stat(dst),{code:'ENOENT'});
 assert.equal((await stat(join(src,'99'))).size,1024);
});
