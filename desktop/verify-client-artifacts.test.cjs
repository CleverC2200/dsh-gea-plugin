const {test}=require('node:test');const assert=require('node:assert/strict');
const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=require('node:fs');const {tmpdir}=require('node:os');const {join}=require('node:path');const {createHash}=require('node:crypto');
const verify=require('./verify-client-artifacts.cjs');
test('final payload rejects browser files replaced after optimization',t=>{
 const root=mkdtempSync(join(tmpdir(),'gea-artifacts-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'node_modules/pkg'),{recursive:true});
 const file='node_modules/pkg/client.js',source='export const value=1;';
 writeFileSync(join(root,file),source);writeFileSync(join(root,file+'.map'),'{}');
 writeFileSync(join(root,'client-artifacts.json'),JSON.stringify({files:[{file,afterSha256:createHash('sha256').update(source).digest('hex')}]}));
 assert.equal(verify(root),1);writeFileSync(join(root,file),'export const value=2;');
 assert.throws(()=>verify(root),/CLIENT_ARTIFACT_DIGEST_MISMATCH/);
});
