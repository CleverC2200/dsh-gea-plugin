const test=require('node:test');const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');const {join}=require('node:path');
const {directoryInstallSection,cleanupExits}=require('./windows-directory-installer.cjs');
test('directory installer rejects template drift',()=>{assert.throws(()=>directoryInstallSection('different template'),/TEMPLATE_CHANGED/);});
test('directory replacement preserves migration uninstall and registers only after promotion',{skip:!process.env.GEA_BUILDER_LIB},()=>{
  const source=readFileSync(join(process.env.GEA_BUILDER_LIB,'templates/nsis/installSection.nsh'),'utf8');const result=directoryInstallSection(source);
  assert.ok(result.indexOf('!insertmacro geaStageApplication')<result.lastIndexOf('Call geaPromoteDirectories'));
  assert.ok(result.indexOf('Call geaPromoteDirectories')<result.indexOf('!insertmacro registryAddInstallInfo'));
  assert.ok(result.includes('Call uninstallOldVersion'));assert.ok(result.includes('!insertmacro handleUninstallResult HKEY_CURRENT_USER'));
  assert.ok(result.includes('!insertmacro addDesktopLink $keepShortcuts'));
  assert.equal((result.match(/!insertmacro CHECK_APP_RUNNING/g)||[]).length,0);
  assert.ok(result.includes('Call geaCheckAppRunning'));
});
test('every explicit helper exit invokes rollback, except an uninstaller build',()=>{
  const result=cleanupExits('  Quit\nQuit\n');assert.equal((result.match(/Call geaCleanupDirectories/g)||[]).length,2);assert.match(result,/!ifndef BUILD_UNINSTALLER/);
});
