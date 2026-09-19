// Build-only interception of template includes. Keep electron-builder's normal
// two-pass installer/uninstaller generation; never mutate its shared cache.
const {join,resolve}=require('node:path');
const assert=require('node:assert/strict');
const [modules,project,prepackaged,templates,output]=process.argv.slice(2).map(p=>resolve(p));
assert.equal(require(join(modules,'app-builder-lib/package.json')).version,'26.15.3');
const builder=require(join(modules,'electron-builder'));
const {NsisTarget}=require(join(modules,'app-builder-lib/out/targets/nsis/NsisTarget.js'));
const original=NsisTarget.prototype.executeMakensis;
NsisTarget.prototype.executeMakensis=function(defines,commands,script){
  if(!Object.prototype.hasOwnProperty.call(defines,'BUILD_UNINSTALLER')){
    for(const name of ['installSection.nsh','include/installUtil.nsh']){
      const needle=`!include "${name.split('/').at(-1)}"`;
      assert.equal(script.split(needle).length-1,1,'Pinned installer include changed');
      script=script.replace(needle,`!include "${join(templates,name)}"`);
    }
  }
  return original.call(this,defines,commands,script);
};
builder.build({projectDir:project,prepackaged,publish:'never',targets:builder.Platform.WINDOWS.createTarget('nsis',builder.Arch.x64),config:{extends:join(project,'electron-builder.cjs'),directories:{output},artifactName:'GEA-Desktop-${version}-${os}-${arch}-full-diagnostic.exe'}}).catch(error=>{console.error(error);process.exitCode=1;});
