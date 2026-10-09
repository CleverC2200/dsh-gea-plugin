import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepare} from './prepare-installer-diagnostics.mjs';
import {optimizeInstallerTransfer} from './prepare-installer-transfer.mjs';

const builder=process.env.GEA_BUILDER_LIB;
test('changed upstream transfer code is rejected rather than partially patched',()=>{
  assert.throws(()=>optimizeInstallerTransfer('changed upstream'),/upstream anchor changed/);
});
test('candidate avoids the second full copy while retaining upstream retry and fallback', {skip:!builder},async()=>{
  const root=await mkdtemp(join(tmpdir(),'gea-transfer-test-'));
  try{
    await prepare(builder,join(root,'templates'),{fastMove:true});
    const source=await readFile(join(root,'templates/include/extractAppPackage.nsh'),'utf8');
    assert.match(source,/!insertmacro GEA_CREATE_INSTALL_STAGE/);
    assert.match(source,/SetOutPath "\$geaInstallStage"/);
    assert.match(source,/!insertmacro GEA_MOVE_NEW_ENTRIES/);
    assert.match(source,/\$geaNeedsCopy == 0[\s\S]*?Goto DoneExtract7za/);
    assert.match(source,/CopyFiles \/SILENT "\$geaInstallStage\\\*" \$OUTDIR/);
    for(const operation of ['StrCpy $R1 0','IntOp $R1 $R1 + 1','IfErrors 0 DoneExtract7za','${if} $R1 < 5','Sleep 1000','Goto LoopExtract7za'])assert.ok(source.includes(operation),operation);
    assert.equal((source.match(/Nsis7z::Extract "\$\{FILE\}"/g)||[]).length,2,'original extraction fallback retained');
    assert.match(source,/AbortExtract7za:\n[^]*?!insertmacro GEA_CLEAN_INSTALL_STAGE[\s\S]*?Quit/);
    assert.match(source,/DoneExtract7za:\n\s*!insertmacro GEA_CLEAN_INSTALL_STAGE/);
    const helper=await readFile(join(root,'templates/include/installer-transfer.nsh'),'utf8');
    for(const phase of ['sevenzip-extract','move-new-entries','copy-files','install-stage-cleanup']){
      assert.ok((source+helper).includes(phase+'-begin'),phase);
      assert.ok((source+helper).includes(phase+'-end'),phase);
    }
    assert.match(helper,/Rename "\$geaInstallStage\\\$1" "\$OUTDIR\\\$1"/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('ordinary diagnostic build retains the released copy path', {skip:!builder},async()=>{
  const root=await mkdtemp(join(tmpdir(),'gea-transfer-baseline-'));
  try{
    await prepare(builder,join(root,'templates'));
    const source=await readFile(join(root,'templates/include/extractAppPackage.nsh'),'utf8');
    assert.match(source,/CopyFiles \/SILENT "\$PLUGINSDIR\\7z-out\\\*" \$OUTDIR/);
    assert.doesNotMatch(source,/GEA_MOVE_NEW_ENTRIES/);
  }finally{await rm(root,{recursive:true,force:true});}
});
