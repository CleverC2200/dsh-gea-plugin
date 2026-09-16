const {test}=require('node:test');const assert=require('node:assert/strict');
const{configuration,launchUrl}=require('./config.cjs');
test('setup accepts HTTPS environments and preserves deployment defaults',()=>{
 const c=configuration({production:'https://gea.example.com/gea/',test:'',model:'model-1'},{analysis:{source:'gea'},pageSize:10});
 assert.equal(c.geaEnvironments.test,'https://gea.example.com/gea');assert.equal(c.analysis.source,'gea');assert.equal(c.analysis.model,'model-1');assert.equal(c.pageSize,10);
});
test('setup rejects credentials, insecure endpoints, and missing model',()=>{
 for(const production of ['http://example.com','https://user:secret@example.com','https://example.com?token=x','https://example.com#x'])assert.throws(()=>configuration({production,model:'m'},{}));
 assert.throws(()=>configuration({production:'https://example.com',model:''},{}));
});
test('backend readiness accepts only its loopback launch URL',()=>{
 assert.equal(launchUrl('unrelated output'),undefined);
 assert.equal(launchUrl('dsh web: http://127.0.0.1:1234/?token=local'),'http://127.0.0.1:1234/?token=local');
 for(const url of ['http://example.com:1234','https://127.0.0.1:1234','http://user@127.0.0.1:1234'])assert.throws(()=>launchUrl(`dsh web: ${url}`));
});
