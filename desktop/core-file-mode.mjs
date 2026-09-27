import {createRequire} from 'node:module';
import {join} from 'node:path';
/** ASAR virtual Stats do not expose the physical mode of unpacked files. */
export async function executableBits(path,stat){
  if(!process.versions.electron||!/[\\/]node_modules\.asar[\\/]/.test(path))return stat.mode&0o111;
  const {archiveEntry}=await import('./core-asar-reader.cjs');const file=archiveEntry(path);
  if(!file)return stat.mode&0o111;
  if(file.entry.unpacked){
    const fs=createRequire(import.meta.url)('original-fs').promises;
    return (await fs.lstat(join(file.archive+'.unpacked',file.relative))).mode&0o111;
  }
  return file.entry.executable?0o111:0;
}
