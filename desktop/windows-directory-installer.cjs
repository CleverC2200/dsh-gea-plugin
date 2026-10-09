// Adapted from DeepSeek 477b4f4 (MIT). See THIRD_PARTY_DESKTOP_NOTICES.txt.
const {mkdir,readFile,writeFile,copyFile}=require('node:fs/promises');
const {join,dirname,resolve}=require('node:path');
const assert=require('node:assert/strict');
const patched=Symbol.for('gea.directory-installer');
const replaceOnce=(source,before,after)=>{assert.equal(source.split(before).length-1,1,'GEA_NSIS_TEMPLATE_CHANGED: '+before);return source.replace(before,after);};

function directoryInstallSection(source){
  let result=source.replaceAll('\r\n','\n');
  result=result.replaceAll('!insertmacro CHECK_APP_RUNNING','Call geaCheckAppRunning');
  result=replaceOnce(result,'!include installer.nsh',`!include installer.nsh
!macroundef extractUsing7za
!macro extractUsing7za FILE
  !insertmacro geaExtractPayload "\${FILE}"
!macroend
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  !insertmacro readReg $R4 "\${ROOT_KEY}" "\${INSTALL_REGISTRY_KEY}" InstallLocation
  \${If} $R4 == $INSTDIR
    StrCpy $R0 0
    ClearErrors
  \${Else}
    Push "\${ROOT_KEY}"
    Call uninstallOldVersion
  \${EndIf}
!macroend`);
  // Stop/check the existing application before creating a candidate, then check
  // again before promotion. The old directory remains until extraction succeeds.
  result=replaceOnce(result,'!insertmacro uninstallOldVersion SHELL_CONTEXT','!insertmacro geaStageApplication\nCall geaCheckAppRunning\n!insertmacro uninstallOldVersion SHELL_CONTEXT');
  result=replaceOnce(result,'!insertmacro installApplicationFiles','Call geaPromoteDirectories\nIfErrors 0 +4\n  SetErrorLevel 2\n  MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDOK\n  Quit');
  return replaceOnce(result,'!ifdef UNINSTALLER_ICON\n  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"\n!endif\n','');
}
function cleanupExits(source){return source.replaceAll(/^(\s*)Quit\s*$/gm,'$1!ifndef BUILD_UNINSTALLER\n$1Call geaCleanupDirectories\n$1!endif\n$1Quit');}
async function installWindowsDirectoryInstaller(explicitRoot){
  const target=explicitRoot?join(explicitRoot,'out/targets/nsis/NsisTarget.js'):Object.keys(require.cache).find(path=>/[/\\]app-builder-lib[/\\]out[/\\]targets[/\\]nsis[/\\]NsisTarget\.js$/.test(path));
  if(!target)throw Error('GEA_NSIS_BUILDER_UNAVAILABLE');
  const root=explicitRoot||resolve(dirname(target),'../../..');
  assert.equal(require(join(root,'package.json')).version,'26.15.3','GEA_NSIS_BUILDER_VERSION');
  require(root);const {NsisTarget}=require(target),prototype=NsisTarget.prototype;
  if(prototype[patched])return;prototype[patched]=true;
  const compute=prototype.computeFinalScript,templates=join(root,'templates/nsis');
  prototype.computeFinalScript=async function(source,...args){
    const dir=join(this.outDir,'.gea-directory-installer');await mkdir(dir,{recursive:true});
    const {downloadBuilderToolset}=require(join(root,'out/util/electronGet.js'));
    // Explicit target: the host's Mach-O 7za must never be embedded in Windows.
    const tools=await downloadBuilderToolset({releaseName:'7zip@1.0.0',filenameWithExt:'7zip-win-x64.tar.gz',checksums:{'7zip-win-x64.tar.gz':'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3'},githubOrgRepo:'electron-userland/electron-builder-binaries'});
    const tool=join(dir,'7za.exe');await copyFile(join(tools,'bin/7za.exe'),tool);await this.packager.signIf(tool);
    const section=join(dir,'installSection.nsh');await writeFile(section,directoryInstallSection(await readFile(join(templates,'installSection.nsh'),'utf8')));
    let adapted=replaceOnce(source,'!include "installSection.nsh"',`!include "${section}"`);
    for(const name of ['allowOnlyOneInstallerInstance.nsh','installUtil.nsh']){
      const file=join(dir,name);await writeFile(file,cleanupExits(await readFile(join(templates,'include',name),'utf8')));
      adapted=replaceOnce(adapted,`!include "${name}"`,`!include "${file}"`);
    }
    return `!define GEA_UPDATER_CACHE_NAME "${this.packager.appInfo.updaterCacheDirName}"\n!define GEA_SEVENZIP_PATH "${tool}"\n!define GEA_SEVENZIP_LICENSE_DIR "${tools}"\n${await compute.call(this,cleanupExits(adapted),...args)}`;
  };
}
module.exports={directoryInstallSection,cleanupExits,installWindowsDirectoryInstaller};
