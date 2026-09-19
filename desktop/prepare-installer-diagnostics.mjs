// Diagnostic-only copies: inserted probes must leave upstream operations intact.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const marker=stage=>`!insertmacro GEA_INSTALL_TIMING_LOG "${stage}"`;
export function instrument(name,source){
  const original=source;
  function replace(needle,value,count=1){
    assert.equal(source.split(needle).length-1,count,`${name}: upstream anchor changed: ${needle}`);
    source=source.split(needle).join(value);
  }
  function around(line,stage,count=1){
    let found=0;
    source=source.split('\n').map(value=>{
      if(value.trim()!==line)return value;
      found++;
      return `${marker(stage+'-begin')}\n${value}\n${marker(stage+'-end')}`;
    }).join('\n');
    assert.equal(found,count,`${name}: upstream line changed: ${line}`);
  }
  if(name==='installSection.nsh'){
    around('!insertmacro CHECK_APP_RUNNING','check-running',2);
    for(const root of ['SHELL_CONTEXT','HKEY_CURRENT_USER']){
      around(`!insertmacro uninstallOldVersion ${root}`,`uninstall-${root}`);
      around(`!insertmacro handleUninstallResult ${root}`,`uninstall-result-${root}`);
    }
    around('!insertmacro installApplicationFiles','application-files');
    around('!insertmacro registryAddInstallInfo','registry');
    around('!insertmacro addStartMenuLink $keepShortcuts','start-menu');
    around('!insertmacro addDesktopLink $keepShortcuts','desktop-shortcut');
    replace('InitPluginsDir',`${marker('install-section-begin')}\nInitPluginsDir`);
  } else if(name==='include/extractAppPackage.nsh'){
    around('!insertmacro compute_files_for_current_arch','embedded-archive');
    around('Nsis7z::Extract "${FILE}"','sevenzip-extract',2);
    around('CopyFiles /SILENT "$PLUGINSDIR\\7z-out\\*" $OUTDIR','copy-files');
    replace('    DetailPrint `Can\'t modify',`    ${marker('copy-failed attempt=$R1')}\n    DetailPrint \`Can't modify`);
    around('MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za','copy-retry-dialog');
    around('RMDir /r "$PLUGINSDIR\\7z-out"','fallback-temp-cleanup');
    replace('  RetryExtract7za:',`  RetryExtract7za:\n${marker('copy-retry attempt=$R1')}`);
    replace('  AbortExtract7za:',`  AbortExtract7za:\n${marker('copy-abort')}`);
  } else if(name==='include/installer.nsh'){
    around('!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"','cache-installer');
    around('File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"','write-uninstaller');
  } else if(name==='include/installUtil.nsh'){
    around('!insertmacro copyFile "$uninstallerFileName" "$uninstallerFileNameTemp"','old-uninstaller-copy');
    around(`ExecWait '"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir' $R0`,'old-uninstaller-temp-exec');
    around(`ExecWait '"$uninstallerFileName" /S /KEEP_APP_DATA $0 _?=$installationDir' $R0`,'old-uninstaller-inplace-exec');
    replace('  UninstallLoop:',`  UninstallLoop:\n${marker('uninstall-attempt previous=$R5')}`);
  }
  // Exact operation-preservation proof, including upstream retry branches.
  const stripped=source.replace(/^.*!insertmacro GEA_INSTALL_TIMING_LOG[^\n]*\n/gm,'');
  assert.equal(stripped,original,`${name}: instrumentation changed upstream operations`);
  return source;
}
export async function prepare(builderRoot,output){
  assert.equal(JSON.parse(await readFile(join(builderRoot,'package.json'),'utf8')).version,'26.15.3');
  const templates=join(builderRoot,'templates/nsis');
  await mkdir(output,{recursive:false});
  await mkdir(join(output,'include'));
  const names=['installer.nsi','installSection.nsh','include/extractAppPackage.nsh','include/installer.nsh','include/installUtil.nsh'];
  for(const name of names){
    let source=instrument(name,await readFile(join(templates,name),'utf8'));
    for(const target of names){
      const basename=target.split('/').at(-1);
      source=source.replaceAll(`!include "${basename}"`,`!include "${join(output,target)}"`)
        .replaceAll(`!include ${basename}\n`,`!include "${join(output,target)}"\n`);
    }
    await writeFile(join(output,name),source);
  }
  return join(output,'installer.nsi');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  console.log(await prepare(resolve(process.argv[2]),resolve(process.argv[3])));
}
