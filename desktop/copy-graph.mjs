/** Bound filesystem work while keeping every copied file independent of the running graph. */
import {mkdir,readdir,copyFile,cp,lstat,readFile,writeFile,chmod} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {constants} from 'node:fs';
import {executableBits} from './core-file-mode.mjs';

export async function copyGraphEntry(source,target,{signal}={}) {
  const pending=new Set();
  let failure;
  const check=()=>{signal?.throwIfAborted();if(failure)throw failure;};
  const schedule=async operation=>{
    check();
    const task=operation().catch(error=>{failure??=error;}).finally(()=>pending.delete(task));
    pending.add(task);
    if(pending.size>=32)await Promise.race(pending);
    check();
  };
  const copy=async(source,target,entry)=>{
    check();
    if(entry.isDirectory()) {
      await mkdir(target,{recursive:true});
      for(const child of await readdir(source,{withFileTypes:true})) {
        await copy(join(source,child.name),join(target,child.name),child);
      }
    } else {
      await schedule(async()=>{
        if(entry.isFile()){
          await copyFile(source,target,constants.COPYFILE_FICLONE);
          // Electron's ASAR copyFile materializes bytes but may drop executable
          // bits. Preserve shims/helpers without creating writable hard links.
          const bits=await executableBits(source,entry);if(bits)await chmod(target,0o644|bits);
        }else await cp(source,target,{recursive:true,dereference:true,mode:constants.COPYFILE_FICLONE});
      });
    }
  };
  try {await copy(source,target,await lstat(source));await Promise.all(pending);check();}
  finally {await Promise.all(pending);}
}

/** pnpm 11 writes absolute virtual-store paths on Windows; our hoisted graphs move twice.
 * Change only a known internal location, never the real store or layout compatibility fields.
 * Unknown/older metadata is left to pnpm's existing relocation fallback.
 */
export async function relocateVirtualStore(directory,{sourceDirectory=directory,storeRoot}={}) {
  const modules=join(directory,'node_modules'),file=join(modules,'.modules.yaml');
  let metadata;
  try {metadata=JSON.parse(await readFile(file,'utf8'));}
  catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}
  if(metadata?.nodeLinker!=='hoisted'||metadata.layoutVersion!==5||typeof metadata.virtualStoreDir!=='string')return false;
  const old=metadata.virtualStoreDir;
  if(old==='.pnpm')return false;
  const location=resolve(modules,old);
  const owned=[join(directory,'node_modules/.pnpm'),join(sourceDirectory,'node_modules/.pnpm')].some(path=>relative(resolve(path),location)==='');
  // Legacy releases retained the previous staging UUID even after it became versions/<id>.
  const legacy=storeRoot&&/^staging-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/node_modules\/\.pnpm$/i.test(relative(resolve(storeRoot),location).replaceAll('\\','/'));
  if(!owned&&!legacy)return false;
  let entry;
  try {entry=await lstat(join(modules,'.pnpm'));}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!entry.isDirectory()||entry.isSymbolicLink())return false;
  metadata.virtualStoreDir='.pnpm';
  await writeFile(file,JSON.stringify(metadata,null,2)+'\n');
  return true;
}
