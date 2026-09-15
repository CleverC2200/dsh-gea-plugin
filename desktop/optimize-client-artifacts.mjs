/** Build-only minification of shipped browser registrations; host code and package versions stay intact. */
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const [payload,compiler]=process.argv.slice(2);
if(!payload||!compiler)throw Error('Usage: node desktop/optimize-client-artifacts.mjs <new-payload> <esbuild-module>');
const {transform}=createRequire(import.meta.url)(resolve(compiler));
const root=resolve(payload),modules=join(root,'node_modules');
const files=new Set(),records=[];
for(const name of await readdir(modules)){
 if(name.startsWith('.'))continue;
 const names=name.startsWith('@')?(await readdir(join(modules,name))).map(n=>name+'/'+n):[name];
 for(const pkgName of names){
  const directory=join(modules,pkgName);let pkg;
  try{pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const client=pkg.dsh?.client&&pkg.exports?.['./client'];
  const path=typeof client==='string'?client:client?.default;
  if(path)files.add(join(directory,path));
 }
}
files.add(join(modules,'@cleverc2200/gea-dsh-prototype/lib/workbench.js'));
for(const path of files){
 const source=await readFile(path,'utf8');
 const output=await transform(source,{loader:'js',minify:true,keepNames:true,target:'esnext',legalComments:'inline',sourcemap:'external',sourcesContent:false,sourcefile:relative(root,path)});
 // DSH loads adjacent maps directly. Ship a compact precomputed map to avoid identity-map construction.
 await writeFile(path,output.code);await writeFile(path+'.map',output.map);
 records.push({file:relative(root,path),beforeBytes:Buffer.byteLength(source),afterBytes:Buffer.byteLength(output.code),beforeSha256:createHash('sha256').update(source).digest('hex'),afterSha256:createHash('sha256').update(output.code).digest('hex')});
}
await writeFile(join(root,'client-artifacts.json'),JSON.stringify({compiler:'esbuild',version:createRequire(import.meta.url)(resolve(compiler)).version,files:records},null,2)+'\n');
console.log(JSON.stringify({files:records.length,beforeBytes:records.reduce((s,r)=>s+r.beforeBytes,0),afterBytes:records.reduce((s,r)=>s+r.afterBytes,0)}));
