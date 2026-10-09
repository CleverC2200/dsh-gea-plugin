/** Trust is shipped with the desktop, never accepted from a downloaded channel. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate} from 'node:crypto';
import {win32} from 'node:path';

const run=promisify(execFile);
export function validateSignatureResult(result,file,trust){
  if(trust?.schema!==1||trust.mode!=='required'||!Array.isArray(trust.publishers)||!trust.publishers.length)throw Error('WINDOWS_PUBLISHER_NOT_CONFIGURED');
  if(result?.status!==0||typeof result.path!=='string'||win32.resolve(result.path).toLowerCase()!==win32.resolve(file).toLowerCase()||typeof result.certificate!=='string')throw Error('WINDOWS_SIGNATURE_INVALID');
  let subject;try{subject=new X509Certificate(Buffer.from(result.certificate,'base64')).subject;}catch{throw Error('WINDOWS_SIGNATURE_INVALID');}
  if(!trust.publishers.includes(subject))throw Error('WINDOWS_PUBLISHER_MISMATCH');
  return {verified:true,mode:'required'};
}
export async function verifyInstallerSignature(file,{platform=process.platform,trust={schema:1,mode:'legacy-unsigned',publishers:[]},runImpl=run,signal}={}){
  if(platform!=='win32')return {verified:false,mode:'not-windows'};
  if(trust?.schema===1&&trust.mode==='legacy-unsigned')return {verified:false,mode:'legacy-unsigned'};
  if(trust?.schema!==1||trust.mode!=='required'||!trust.publishers?.length)throw Error('WINDOWS_PUBLISHER_NOT_CONFIGURED');
  const command="$ErrorActionPreference='Stop'; $p=Get-Item -LiteralPath $env:GEA_VERIFY_INSTALLER; $s=Get-AuthenticodeSignature -LiteralPath $p.FullName; @{status=[int]$s.Status;path=$p.FullName;certificate=$(if($s.SignerCertificate){[Convert]::ToBase64String($s.SignerCertificate.RawData)}else{''})}|ConvertTo-Json -Compress";
  const executable=win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  let result;
  try{
    const {stdout}=await runImpl(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:30000,maxBuffer:131072,signal,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,TEMP:process.env.TEMP,PATH:win32.dirname(executable),GEA_VERIFY_INSTALLER:file}});
    result=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());
  }catch{throw Error('WINDOWS_SIGNATURE_UNAVAILABLE');}
  return validateSignatureResult(result,file,trust);
}
