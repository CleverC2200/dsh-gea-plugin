import { mkdir, readdir, cp, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { ClassicLevel } from "classic-level";
export async function readDraft(directory, key, expected, output) {
  await mkdir(output, {recursive:true});
  async function search(path, depth) {
    if (depth < 0) return [];
    const entries = await readdir(path,{withFileTypes:true}).catch(()=>[]);
    if (entries.some(x=>x.name==="CURRENT") && path.endsWith("Local Storage/leveldb")) return [path];
    const result = [];
    for (const entry of entries) if (entry.isDirectory() && !["Cache","Code Cache","GPUCache","CacheStorage"].includes(entry.name))
      result.push(...await search(join(path,entry.name),depth-1));
    return result;
  }
  for(const path of await search(directory,5)){
    const target = await mkdtemp(join(output,"leveldb-"));
    try {
      await cp(path,target,{recursive:true});
      const database = new ClassicLevel(target,{createIfMissing:false,keyEncoding:"buffer",valueEncoding:"buffer"});
      await database.open();
      try {
        for await(const [raw,value] of database.iterator()){
          if(!raw.toString().endsWith(key)) continue;
          const parsed = JSON.parse(value.subarray(1).toString(value[0]===0?"utf16le":"latin1"));
          if(parsed.draft===expected)return true;
        }
      } finally {await database.close();}
    } catch {}
  }
  return false;
}
