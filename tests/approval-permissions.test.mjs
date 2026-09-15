import test from 'node:test';
import assert from 'node:assert/strict';
import { profile } from './profile.mjs';
test('permission codes come from the authenticated grant list, survive status reads, and clear on logout', {timeout:60000}, async t => {
  const app = await profile(t);
  let reads = 0;
  app.route((req, res, reply) => {
    if (!req.url.pathname.endsWith('/sys/permission/getPermCode')) return false;
    reads++;
    assert.equal(req.headers['x-access-token'], 'fixture-gea-token');
    assert.equal(req.headers['x-tenant-id'], '0');
    reply({success:true,result:{codeList:['sales-plan:plan:region-approve'],allAuth:[{action:'sales-plan:plan:category-approve'}]}});
    return true;
  });
  await app.login();
  assert.deepEqual((await app.rpc('status')).value.permissionCodes, ['sales-plan:plan:region-approve']);
  assert.equal(reads, 1);
  await app.rpc('logout');
  assert.equal((await app.rpc('status')).value.permissionCodes, undefined);
});

test('restored login reloads current grants instead of trusting persisted permissions', async t => {
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const { outputFiles } = await build({stdin:{contents:"export {Business} from './src/business.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs'});
  const module = {exports:{}};
  new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const business = new module.exports.Business({geaBaseUrl:'https://gea.example.test',requestTimeoutMs:1000});
  business.restoreDesktopLogin({schema:1,environment:'production',base:'https://gea.example.test',auth:{token:'saved-secret',tenantId:'0',name:'Test',id:'1',username:'test',permissionCodes:['sales-plan:plan:category-approve']}});
  assert.equal(business.status().permissionCodes, undefined);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://gea.example.test/sys/permission/getPermCode');
    assert.equal(init.headers['X-Access-Token'], 'saved-secret');
    return Response.json({success:true,result:{codeList:['sales-plan:plan:region-approve']}});
  });
  await business.refreshPermissions(new AbortController().signal);
  assert.deepEqual(business.status().permissionCodes, ['sales-plan:plan:region-approve']);
  assert.ok(!JSON.stringify(business.status()).includes('saved-secret'));
  business.dispose();
});
