const test=require('node:test');
const assert=require('node:assert/strict');
const {AUTH_COOKIE_PREFIX,clearRuntimeCookies}=require('./runtime-cookies.cjs');

test('clears stale Harness auth cookies for loopback hosts only',async()=>{
  const removed=[];
  const cookies={
    async get({url}) {
      if (url.includes('127.0.0.1')) return [{name:`${AUTH_COOKIE_PREFIX}old-port`},{name:'unrelated'}];
      return [{name:`${AUTH_COOKIE_PREFIX}old-localhost`}];
    },
    async remove(url,name) { removed.push([url,name]); },
  };
  await clearRuntimeCookies(cookies);
  assert.deepEqual(removed,[
    ['http://127.0.0.1/',`${AUTH_COOKIE_PREFIX}old-port`],
    ['http://localhost/',`${AUTH_COOKIE_PREFIX}old-localhost`],
  ]);
});
