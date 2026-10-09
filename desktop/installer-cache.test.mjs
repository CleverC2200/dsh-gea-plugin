import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readdir,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createInstallerCache,installerFileName} from './installer-cache.mjs';
test('cache retains current, previous, shown and in-use installers and ignores unrelated files',async t=>{
  const data=await mkdtemp(join(tmpdir(),'gea-cache-'));t.after(()=>rm(data,{recursive:true,force:true}));
  const cache=createInstallerCache(data,{isInUse:async path=>path.endsWith('1.0.0-win-x64.exe')});await cache.ensure();
  const names=[];
  for(let i=1;i<=5;i++){const bytes=Buffer.from('installer-'+i);const a={platform:'win32',arch:'x64',url:`https://company.test/GEA-Desktop-${i}.0.0-win-x64.exe`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};const name=installerFileName(a);names.push(name);await writeFile(join(cache.directory,name),bytes);await cache.save(a);}
  await writeFile(join(cache.directory,'notes.txt'),'keep');await symlink(join(cache.directory,'notes.txt'),join(cache.directory,'x.part'));
  const result=await cache.collect([names[1]]);assert.deepEqual(result.removed,[names[2]]);
  assert.equal(await readFile(join(cache.directory,'notes.txt'),'utf8'),'keep');assert.ok((await readdir(cache.directory)).includes('x.part'));
});
test('blockmap replacement never follows a pre-existing sidecar symlink',async t=>{
  const data=await mkdtemp(join(tmpdir(),'gea-cache-link-'));t.after(()=>rm(data,{recursive:true,force:true}));
  const cache=createInstallerCache(data);await cache.ensure();
  const outside=join(data,'unrelated.txt');await writeFile(outside,'ORIGINAL');
  const artifact={sha256:'a'.repeat(64),url:'https://company.test/GEA-Desktop-1.0.0-win-x64.exe'};
  await symlink(outside,join(cache.directory,installerFileName(artifact)+'.blockmap'));
  await cache.save(artifact,Buffer.from('map'));assert.equal(await readFile(outside,'utf8'),'ORIGINAL');
});
