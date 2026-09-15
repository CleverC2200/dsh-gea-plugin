import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {verifyOfficialVersions} from './installer.mjs';

test('SDK verification allows pruning obsolete transitive packages while protecting core versions',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'sdk-pruning-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'package.json'),'{}');
  const name='@deepseek-ai/test-sdk';
  const official={[name]:'0.1.5-rc.2'};

  await verifyOfficialVersions(directory,official,[]);
  await assert.rejects(()=>verifyOfficialVersions(directory,official,[name]),/Cannot find module/);

  const folder=join(directory,'node_modules',name);
  await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'package.json'),JSON.stringify({name,version:'0.1.5-rc.2'}));
  await verifyOfficialVersions(directory,official,[name]);

  await writeFile(join(folder,'package.json'),JSON.stringify({name,version:'0.1.5-rc.3'}));
  await assert.rejects(()=>verifyOfficialVersions(directory,official,[]),/RUNTIME_VERSION_CHANGED/);
});
