/** Temporary Windows diagnosis: instrument a private copy of the installer, not the installed app. */
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {PluginStore} from './plugin-store.mjs';
const temporary=await mkdtemp(join(tmpdir(),'gea-installer-probe-'));
let source=await readFile(new URL('./installer.mjs',import.meta.url),'utf8');
source=source.replace(";execFileSync(process.env.GEA_INSTALL_NODE", ";console.error('[DEBUG-win-install] wrapper entered');execFileSync(process.env.GEA_INSTALL_NODE");
source=source.replace("stdio:'inherit'});execFileSync", "stdio:'inherit'});console.error('[DEBUG-win-install] install returned');execFileSync");
source=source.replace("'--prefer-offline'],{stdio:'inherit'});`", "'--prefer-offline'],{stdio:'inherit'});console.error('[DEBUG-win-install] add returned');process.on('exit',code=>console.error('[DEBUG-win-install] wrapper exit',code));`");
source=source.replace("const registered=", "child.once('exit',(code,signal)=>console.log('[DEBUG-win-install] CLI exit',code,signal));const registered=");
const module=join(temporary,'installer.mjs');await writeFile(module,source);
const {installArtifact}=await import(pathToFileURL(module));
const baseline=process.env.GEA_DESKTOP_PAYLOAD;
const store=new PluginStore({data:join(temporary,'data'),baseline});
await store.prepare({id:'probe',install:async(directory,{registerProcess})=>{
 await installArtifact({directory,optimizedBaseline:baseline,artifact:process.env.GEA_PLUGIN_ARTIFACT,node:join(baseline,'node/node.exe'),pnpm:join(baseline,'tools/node_modules/pnpm/bin/pnpm.cjs'),onProcess:registerProcess,onProgress:line=>console.log(line)});
}});
console.log('WINDOWS_INSTALL_PASS');
