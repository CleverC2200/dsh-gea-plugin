import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const MAX_MAP=2*1024*1024;
export function differentialDescriptor(artifact){
  const d=artifact.differential;
  if(artifact.platform!=='win32'||d?.algorithm!=='electron-blockmap-v2'||typeof d.sha512!=='string'||Buffer.from(d.sha512,'base64').length!==64||Buffer.from(d.sha512,'base64').toString('base64')!==d.sha512)return null;
  if(d.blockmap?.url!==artifact.url+'.blockmap'||!Number.isSafeInteger(d.blockmap.bytes)||d.blockmap.bytes<1||d.blockmap.bytes>MAX_MAP||!/^[a-f0-9]{64}$/.test(d.blockmap.sha256??''))return null;
  return d;
}
export function decodeBlockmap(bytes,artifact){
  const d=differentialDescriptor(artifact);if(!d||bytes.length!==d.blockmap.bytes||createHash('sha256').update(bytes).digest('hex')!==d.blockmap.sha256)throw Error('DESKTOP_BLOCKMAP_CHECKSUM');
  const map=JSON.parse(gunzipSync(bytes,{maxOutputLength:16*1024*1024}).toString('utf8'));
  if(map.version!=='2'||!Array.isArray(map.files)||map.files.length!==1)throw Error('DESKTOP_BLOCKMAP_INVALID');
  const f=map.files[0];
  if(f.name!=='file'||f.offset!==0||!Array.isArray(f.sizes)||f.sizes.length<1||f.sizes.length>150000||!Array.isArray(f.checksums)||f.sizes.length!==f.checksums.length)throw Error('DESKTOP_BLOCKMAP_INVALID');
  let size=0;for(let i=0;i<f.sizes.length;i++){if(!Number.isSafeInteger(f.sizes[i])||f.sizes[i]<1||f.sizes[i]>artifact.bytes||!/^[A-Za-z0-9+/]{24}$/.test(f.checksums[i]))throw Error('DESKTOP_BLOCKMAP_INVALID');size+=f.sizes[i];}
  if(size!==artifact.bytes)throw Error('DESKTOP_BLOCKMAP_INVALID');return map;
}
