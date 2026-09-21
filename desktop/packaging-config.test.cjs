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
  assert.deepEqual(config.config.electronLanguages,['en-US','zh-CN','zh_CN','zh-TW','zh_TW']);
  assert.deepEqual(config.config.win.target,[{target:'nsis',arch:['x64']}]);
  assert.equal(config.filter,'BCJ');
  const mac=spawnSync(process.execPath,['-e',`process.env.GEA_DESKTOP_TARGET='mac';const config=require(${JSON.stringify(path.join(desktop,'electron-builder.cjs'))});process.stdout.write(JSON.stringify({config,filter:process.env.ELECTRON_BUILDER_7Z_FILTER}))`],{encoding:'utf8'});
  assert.equal(mac.status,0,mac.stderr);
  const macResult=JSON.parse(mac.stdout);
  assert.equal(macResult.filter,undefined);
  assert.deepEqual(macResult.config.mac.target,[{target:'dmg',arch:['arm64']}]);
});

test('Windows signing is certificate-gated and can be made mandatory',()=>{
  const configPath=path.join(desktop,'electron-builder.cjs');
  const signed=spawnSync(process.execPath,['-e',`process.env.GEA_DESKTOP_TARGET='win';process.env.WIN_CSC_LINK='C:/certs/gea.pfx';process.env.GEA_WIN_REQUIRE_SIGNING='1';process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)})))`],{encoding:'utf8'});
  assert.equal(signed.status,0,signed.stderr);
  const signedConfig=JSON.parse(signed.stdout);
  assert.equal(signedConfig.win.signExecutable,true);
  assert.equal(signedConfig.win.forceCodeSigning,true);
  const missing=spawnSync(process.execPath,['-e',`process.env.GEA_DESKTOP_TARGET='win';process.env.GEA_WIN_REQUIRE_SIGNING='1';require(${JSON.stringify(configPath)})`],{encoding:'utf8'});
  assert.notEqual(missing.status,0);
  assert.match(missing.stderr,/requires WIN_CSC_LINK or CSC_LINK/);
});

test('MSIX pilot is explicit and publisher-gated',()=>{
  const result=spawnSync(process.execPath,['-e',`process.env.GEA_MSIX_PUBLISHER='CN=GEA Pilot';process.env.GEA_DESKTOP_PAYLOAD_ROOT='/tmp/payload';process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(desktop,'electron-builder-msix.cjs'))})))`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const config=JSON.parse(result.stdout);
  assert.deepEqual(config.win.target,['appx']);
  assert.equal(config.appx.publisher,'CN=GEA Pilot');
  assert.equal(config.appx.identityName,'CleverC2200.GEA.Desktop');
  assert.equal(config.appx.displayName,'GEA Desktop');
});
