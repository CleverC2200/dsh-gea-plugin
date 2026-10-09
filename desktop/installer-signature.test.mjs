import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyInstallerSignature,validateSignatureResult} from './installer-signature.mjs';
import {rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareDesktopTrust} from '../scripts/prepare-desktop-trust.mjs';
const trust={schema:1,mode:'required',publishers:['CN=Example\nO=Example\nC=CN']};
test('required verification fails closed when PowerShell or its result is unavailable',async()=>{
  for(const runImpl of [async()=>{throw Error('missing');},async()=>({stdout:'not json'}),async()=>({stdout:'{}'})]){
    await assert.rejects(verifyInstallerSignature('C:\\Downloads\\new.exe',{platform:'win32',trust,runImpl}),/WINDOWS_SIGNATURE_(UNAVAILABLE|INVALID)/);
  }
});
test('signature result rejects unsigned files, another path and malformed certificates',()=>{
  for(const value of [{status:1,path:'C:\\new.exe',certificate:''},{status:0,path:'C:\\other.exe',certificate:'AA=='},{status:0,path:'C:\\new.exe',certificate:'AA=='}])assert.throws(()=>validateSignatureResult(value,'C:\\new.exe',trust),/SIGNATURE_INVALID/);
});
test('legacy unsigned compatibility is explicit and is never reported as verified',async()=>{
  assert.deepEqual(await verifyInstallerSignature('C:\\new.exe',{platform:'win32'}),{verified:false,mode:'legacy-unsigned'});
  await assert.rejects(verifyInstallerSignature('C:\\new.exe',{platform:'win32',trust:{schema:1,mode:'required',publishers:[]}}),/NOT_CONFIGURED/);
});
test('a successful OS verdict still requires the locally configured publisher',()=>{
  const certificate=new X509Certificate(rootCertificates[0]);
  const result={status:0,path:'C:\\Downloads\\file.exe',certificate:certificate.raw.toString('base64')};
  assert.deepEqual(validateSignatureResult(result,result.path,{schema:1,mode:'required',publishers:[certificate.subject]}),{verified:true,mode:'required'});
  assert.throws(()=>validateSignatureResult(result,result.path,trust),/PUBLISHER_MISMATCH/);
});
test('signed builds require a public publisher certificate and embed no signing secrets',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'gea-build-trust-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 await assert.rejects(prepareDesktopTrust(directory,{target:'win',env:{WIN_CSC_LINK:'private.pfx'}}),/PUBLISHER_CERT_REQUIRED/);
 const pem=rootCertificates.find(pem=>['CN=','O=','C='].every(key=>new X509Certificate(pem).subject.split('\n').some(line=>line.startsWith(key))));assert.ok(pem);
 const file=join(directory,'publisher.pem');await writeFile(file,pem);
 await prepareDesktopTrust(directory,{target:'win',env:{WIN_CSC_LINK:'private.pfx',WIN_CSC_KEY_PASSWORD:'secret-value',GEA_WIN_PUBLISHER_CERT:file}});
 const raw=await readFile(join(directory,'windows-update-trust.json'),'utf8'),value=JSON.parse(raw);
 assert.equal(value.mode,'required');assert.deepEqual(value.publishers,[new X509Certificate(pem).subject]);
 assert.doesNotMatch(raw,/private\.pfx|secret-value|BEGIN CERTIFICATE/);
});
