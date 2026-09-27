import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('ASAR native helpers execute pty, ripgrep and FFI from their real unpacked paths',{
  skip:!process.versions.electron||!process.env.GEA_LAYERED_TEST_PAYLOAD,timeout:20000,
},async t=>{
  const core=join(resolve(process.env.GEA_LAYERED_TEST_PAYLOAD),'node_modules.asar'),require=createRequire(join(core,'package.json'));
  const root=await mkdtemp(join(tmpdir(),'gea-native-layer-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const pty=require('node-pty');
  const child=process.platform==='win32'?pty.spawn('cmd.exe',['/d','/c','echo layered-pty-ok'],{cwd:root}):pty.spawn('/bin/sh',['-c','printf layered-pty-ok'],{cwd:root});
  let output='';child.onData(text=>{output+=text;});
  await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('PTY_TIMEOUT'));},5000);child.onExit(({exitCode})=>{clearTimeout(timer);exitCode===0?done():reject(Error('PTY_EXIT_'+exitCode));});});
  assert.match(output,/layered-pty-ok/);
  const {rgPath}=await import(pathToFileURL(require.resolve('@vscode/ripgrep')).href);
  const rg=rgPath.replace(/\.asar(?=[\\/])/u,'.asar.unpacked');
  const file=join(root,'needle.txt');await writeFile(file,'layered-search-ok\n');
  const found=await promisify(execFile)(rg,['--fixed-strings','layered-search-ok',file]);assert.match(found.stdout,/layered-search-ok/);
  const koffi=require('koffi');const pid=process.platform==='win32'?koffi.load('kernel32.dll').func('unsigned long GetCurrentProcessId()')():koffi.load('/usr/lib/libSystem.B.dylib').func('int getpid()')();
  assert.equal(pid,process.pid);
});
