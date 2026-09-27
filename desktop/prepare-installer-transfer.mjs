/** Change only the transfer path in the pinned, already-instrumented template. */
import assert from 'node:assert/strict';

export function optimizeInstallerTransfer(source){
  const replace=(needle,value,count=1)=>{
    assert.equal(source.split(needle).length-1,count,`transfer: upstream anchor changed: ${needle}`);
    source=source.split(needle).join(value);
  };
  replace('  CreateDirectory "$PLUGINSDIR\\7z-out"','  !insertmacro GEA_CREATE_INSTALL_STAGE');
  replace('"$PLUGINSDIR\\7z-out"','"$geaInstallStage"',2);
  replace('"$PLUGINSDIR\\7z-out\\*"','"$geaInstallStage\\*"');
  replace('  # Retry counter',[
    '!insertmacro GEA_INSTALL_TIMING_LOG "move-new-entries-begin"',
    '  !insertmacro GEA_MOVE_NEW_ENTRIES',
    '!insertmacro GEA_INSTALL_TIMING_LOG "move-new-entries-end"',
    '  ${If} $geaNeedsCopy == 0',
    '    Goto DoneExtract7za',
    '  ${EndIf}',
    '',
    '  # Retry counter',
  ].join('\n'));
  replace('  AbortExtract7za:', '  AbortExtract7za:\n  !insertmacro GEA_CLEAN_INSTALL_STAGE');
  replace('  DoneExtract7za:', '  DoneExtract7za:\n  !insertmacro GEA_CLEAN_INSTALL_STAGE');
  return source;
}
