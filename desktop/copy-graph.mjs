/** Bound filesystem work while keeping every copied file independent of the running graph. */
import {mkdir,readdir,copyFile,cp,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {constants} from 'node:fs';

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
      await schedule(()=>entry.isFile()
        ? copyFile(source,target,constants.COPYFILE_FICLONE)
        : cp(source,target,{recursive:true,dereference:true,mode:constants.COPYFILE_FICLONE}));
    }
  };
  try {await copy(source,target,await lstat(source));await Promise.all(pending);check();}
  finally {await Promise.all(pending);}
}
