/** Build-time only: create a new payload, never rewrite an installed runtime. */
import {cp,mkdir,readFile,writeFile,readdir,rm,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createPackageWithOptions,listPackage,statFile,extractFile} from '@electron/asar';
import {corePackageInventory,readCoreLayout} from './core-layer.mjs';

export async function patchLayeredCli(payload){
  const dir=join(payload,'node_modules/@deepseek-ai/dsh');const manifest=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
  if(manifest.version!=='0.1.6-alpha.1-company.1')throw Error('CORE_CLI_VERSION_UNSUPPORTED');
  const entry=await readFile(join(dir,'lib/bin.js'),'utf8');
  const referenced=text=>[...new Set([...text.matchAll(/["']\.\/(profile-boot-[a-zA-Z0-9_-]+\.js)["']/g)].map(match=>match[1]))];
  let files=referenced(entry);
  if(files.length!==1)throw Error('CORE_CLI_LAYOUT_UNSUPPORTED');
  let file=join(dir,'lib',files[0]),source=await readFile(file,'utf8');
  if(!source.includes('async function composeProfile(')){
    files=referenced(source);if(files.length!==1)throw Error('CORE_CLI_LAYOUT_UNSUPPORTED');
    file=join(dir,'lib',files[0]);source=await readFile(file,'utf8');
  }
  if(source.includes('GEA_LAYERED_GRAPH'))return;
  const mode='const resolutionMode = process.pkg !== void 0 ? "runtime" : options.resolutionMode ?? "link";';
  if(source.split(mode).length!==2)throw Error('CORE_CLI_MODE_ANCHOR_CHANGED');
  source=source.replace(mode,'const resolutionMode = process.env.GEA_LAYERED_GRAPH ? "runtime" : process.pkg !== void 0 ? "runtime" : options.resolutionMode ?? "link";');
  const generation='const resolution = resolutionMode === "runtime" ? await createProfileResolutionGeneration(resolutionOptions) : await healProfilesModuleFallback(resolutionOptions);';
  if(source.split(generation).length!==2)throw Error('CORE_CLI_GENERATION_ANCHOR_CHANGED');
  source=source.replace(generation,generation.replace('const resolution','let resolution'));
  const anchor='const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? [];';
  if(source.split(anchor).length!==2)throw Error('CORE_CLI_SCOPE_ANCHOR_CHANGED');
  source=source.replace(anchor,`if (process.env.GEA_LAYERED_GRAPH) {
    const { readFile, realpath } = await import('node:fs/promises');
    const graph = await realpath(process.env.GEA_LAYERED_GRAPH);
    const layer = JSON.parse(await readFile(join(graph, 'layer.json'), 'utf8'));
    if (layer.schema !== 1 || !layer.packages) throw Error('GEA_LAYER_INVALID');
    const core = resolve(dirname(INSTALL_ANCHOR), '../../..');
    resolution = { ...resolution, profileDir: graph, entries: Object.entries(layer.packages).map(([name, meta]) => {
      if (!/^(?:@[a-zA-Z0-9._-]+\\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw Error('GEA_LAYER_PACKAGE_INVALID');
      return { name, packageDir: join(core, 'node_modules', name), declarer: join(core, 'package.json'), version: meta.version, scope: 'installation' };
    }) };
  }
  ${anchor}`);
  await writeFile(file,source);
}
export async function prepareCoreLayout(source,destination){
  source=resolve(source);destination=resolve(destination);
  if(!relative(source,destination).startsWith('..')||!relative(destination,source).startsWith('..'))throw Error('CORE_LAYOUT_REQUIRES_NEW_DIRECTORY');
  try{await lstat(destination);throw Error('CORE_LAYOUT_DESTINATION_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(await readCoreLayout(source))throw Error('CORE_LAYOUT_ALREADY_PREPARED');
  await cp(source,destination,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});
  for(const [input,output] of [['runtime-start.mjs','start.mjs'],['core-runtime.mjs','core-runtime.mjs'],['onboarding.mjs','onboarding.mjs']])await writeFile(join(destination,output),await readFile(new URL('./'+input,import.meta.url)));
  await patchLayeredCli(destination);
  const packages=await corePackageInventory(destination),stage=destination+'.core-build';await mkdir(stage);
  try{
    await mkdir(join(stage,'node_modules'));
    for(const name of Object.keys(packages))await cp(join(destination,'node_modules',name),join(stage,'node_modules',name),{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});
    try{await cp(join(destination,'packages'),join(stage,'packages'),{recursive:true,verbatimSymlinks:true,mode:constants.COPYFILE_FICLONE});}catch(error){if(error.code!=='ENOENT')throw error;}
    await writeFile(join(stage,'package.json'),JSON.stringify({private:true,dependencies:Object.fromEntries(Object.entries(packages).map(([name,meta])=>[name,meta.version]))}));
    const archive=join(destination,'node_modules.asar');
    // ASAR matches absolute input paths without dot:true. A basename pattern
    // also works when the build lives under .runtime or another hidden folder.
    await createPackageWithOptions(stage,archive,{unpack:'{*.node,*.dll,*.exe,*.so,*.so.*,*.dylib,spawn-helper,rg,esbuild}'});
    for(const file of listPackage(archive)){
      const name=file.replace(/^\//,'');const entry=statFile(archive,name);
      if(!entry.files&&/\.(?:node|dll|exe|so(?:\.[^/]*)?|dylib)$|\/(?:spawn-helper|rg|esbuild)$/.test(name)){
        if(entry.unpacked!==true)throw Error('CORE_NATIVE_ASSET_NOT_UNPACKED: '+name);
        if(!extractFile(archive,name).equals(await readFile(join(stage,name))))throw Error('CORE_NATIVE_ASSET_CHANGED: '+name);
      }
    }
    const archiveSha256=createHash('sha256').update(await readFile(archive)).digest('hex');
    const layout={schema:1,runtimeVersion:1,archive:'node_modules.asar',archiveSha256,packages};
    await writeFile(join(destination,'core-layout.json'),JSON.stringify(layout));
    await writeFile(join(destination,'layer.json'),JSON.stringify({schema:1,packages}));
    for(const name of Object.keys(packages))await rm(join(destination,'node_modules',name),{recursive:true});
    await rm(join(destination,'packages'),{recursive:true,force:true});
    return layout;
  }finally{await rm(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=await prepareCoreLayout(process.argv[2],process.argv[3]);console.log(JSON.stringify({corePackages:Object.keys(result.packages).length,archiveSha256:result.archiveSha256}));
}
