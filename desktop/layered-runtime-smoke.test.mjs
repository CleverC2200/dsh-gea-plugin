import test from 'node:test';
import assert from 'node:assert/strict';
import {profile} from '../tests/profile.mjs';
import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';

test('layered baseline boots the real GEA Host and reaches local health with isolated business HTTP',{
  skip:!process.env.GEA_LAYERED_TEST_PAYLOAD||!process.env.GEA_ELECTRON_EXECUTABLE,timeout:90000,
},async t=>{
  const payload=resolve(process.env.GEA_LAYERED_TEST_PAYLOAD);
  const app=await profile(t,{desktopGraph:payload,executablePath:process.env.GEA_ELECTRON_EXECUTABLE,execArgv:['--expose-internals'],env:{ELECTRON_RUN_AS_NODE:'1',GEA_LAYERED_CORE:join(payload,'node_modules.asar'),GEA_LAYERED_GRAPH:payload,DSH_DESKTOP_BASELINE:payload}});
  assert.equal((await app.rpc('status')).value.authenticated,false);
  assert.equal((await app.login()).ok,true);
  const manifest=JSON.parse(await readFile(join(app.runtime,'home/profiles/full/package.json'),'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('@cleverc2200/gea-dsh-prototype'));
});
