import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {dirname,join} from 'node:path';
import {readFile,writeFile,readdir} from 'node:fs/promises';
export async function buildDesktopTools(){
  const results=[];
  for(const name of ['download-differential','core-asar-reader'])results.push(await build({entryPoints:[fileURLToPath(new URL('../desktop/'+name+'.mjs',import.meta.url))],outfile:fileURLToPath(new URL('../desktop/'+name+'.cjs',import.meta.url)),bundle:true,platform:'node',format:'cjs',target:'node24',minify:true,legalComments:'eof',metafile:true,external:['original-fs']}));
  const seen=new Set(),notices=[];
  for(const input of results.flatMap(result=>Object.keys(result.metafile.inputs))){
    if(!input.includes('node_modules/'))continue;
    let dir=dirname(resolve(input));
    while(dirname(dir)!==dir){
      let manifest;try{manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));}catch{}
      if(manifest){
        if(!seen.has(dir)){
          seen.add(dir);const files=(await readdir(dir)).filter(name=>/^licen[cs]e(?:[.-].*)?$/i.test(name));
          if(!files.length)throw Error('DESKTOP_DEPENDENCY_LICENSE_MISSING: '+manifest.name);
          for(const file of files)notices.push(`${manifest.name}@${manifest.version}\n${await readFile(join(dir,file),'utf8')}`);
        }
        break;
      }
      dir=dirname(dir);
    }
  }
  await writeFile(new URL('../desktop/download-differential.LICENSE.txt',import.meta.url),notices.join('\n\n--------------------\n\n'));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildDesktopTools();
