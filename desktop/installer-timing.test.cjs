const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {spawnSync}=require('node:child_process');

const project=__dirname;
const configPath=join(project,'electron-builder.cjs');
const includePath=join(project,'build','installer-timing.nsh');

function loadConfig(diagnostic){
  const script=`process.env.GEA_DESKTOP_TARGET='win';${diagnostic?"process.env.GEA_INSTALL_TIMING_LOG='1';":''}process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)}).nsis));`;
  const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

test('installer timing include is opt-in and records supported NSIS boundaries',()=>{
  assert.equal(loadConfig(false).include,undefined);
  assert.equal(loadConfig(true).include,includePath);

  const source=readFileSync(includePath,'utf8');
  assert.match(source,/\[GEA-INSTALL-DIAG\]/);
  assert.match(source,/!macro customInit/);
  assert.match(source,/!macro customFiles_x64/);
  assert.match(source,/!macro customInstall/);
  assert.doesNotMatch(source,/\$INSTDIR|APPDATA|LOCALAPPDATA/);
});
