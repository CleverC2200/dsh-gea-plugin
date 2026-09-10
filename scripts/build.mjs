import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
await mkdir('lib', { recursive: true });
await copyFile('src/host.js', 'lib/host.js');
await copyFile('src/gea-error.js', 'lib/gea-error.js');
const output = await build({ entryPoints: ['src/client.jsx'], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022', external: ['react'] });
const code = output.outputFiles[0].text;
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:'@cleverc2200/gea-dsh-prototype',factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;}});\n`);
