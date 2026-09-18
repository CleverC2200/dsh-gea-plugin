const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const desktop=__dirname;

function load(file,env){
  const script=`process.env.GEA_DESKTOP_TARGET='win';${env||''};const config=require(${JSON.stringify(path.join(desktop,file))});process.stdout.write(JSON.stringify({config,filter:process.env.ELECTRON_BUILDER_7Z_FILTER}));`;
  const result=spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

test('Windows NSIS uses BCJ and differential package without changing macOS',()=>{
  const config=load('electron-builder.cjs');
  assert.deepEqual(config.config.nsis.differentialPackage,true);
  assert.equal(config.filter,'BCJ');
  const mac=spawnSync(process.execPath,['-e',`process.env.GEA_DESKTOP_TARGET='mac';const config=require(${JSON.stringify(path.join(desktop,'electron-builder.cjs'))});process.stdout.write(JSON.stringify({config,filter:process.env.ELECTRON_BUILDER_7Z_FILTER}))`],{encoding:'utf8'});
  assert.equal(mac.status,0,mac.stderr);
  assert.equal(JSON.parse(mac.stdout).filter,undefined);
});

test('MSIX pilot is explicit and publisher-gated',()=>{
  const result=spawnSync(process.execPath,['-e',`process.env.GEA_MSIX_PUBLISHER='CN=GEA Pilot';process.env.GEA_DESKTOP_PAYLOAD_ROOT='/tmp/payload';process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(desktop,'electron-builder-msix.cjs'))})))`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(result.stdout);
  assert.deepEqual(config.win.target,['msix']);
  assert.equal(config.msix.publisher,'CN=GEA Pilot');
  assert.equal(config.msix.packageName,'GEADesktop');
});
