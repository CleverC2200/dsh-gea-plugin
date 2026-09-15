const {test}=require('node:test');const assert=require('node:assert/strict');
const{ensureConfiguration,launchUrl}=require('./config.cjs');
test('first launch provisions company environments and model without business input; existing configuration survives',async t=>{
 const {mkdtemp,readFile,writeFile,rm}=require('node:fs/promises');const {join}=require('node:path');
 const dir=await mkdtemp(join(require('node:os').tmpdir(),'gea-defaults-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'gea.config.json');await ensureConfiguration(path);const c=JSON.parse(await readFile(path,'utf8'));
 assert.equal(c.environment,'production');assert.equal(c.geaEnvironments.production,'https://gea.synear.cn/gea-boot');assert.equal(c.geaEnvironments.test,'https://gea.synear.cn:4443/gea-boot');assert.equal(c.analysis.source,'gea');assert.equal(c.analysis.model,'2085162185715609601');
 await writeFile(path,'{"existing":true}');await ensureConfiguration(path);assert.equal(await readFile(path,'utf8'),'{"existing":true}');
});
test('backend readiness accepts only its loopback launch URL',()=>{
 assert.equal(launchUrl('unrelated output'),undefined);
 assert.equal(launchUrl('dsh web: http://127.0.0.1:1234/?token=local'),'http://127.0.0.1:1234/?token=local');
 for(const url of ['http://example.com:1234','https://127.0.0.1:1234','http://user@127.0.0.1:1234'])assert.throws(()=>launchUrl(`dsh web: ${url}`));
});
