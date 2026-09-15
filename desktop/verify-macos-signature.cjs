/** Fail packaging if a renamed/repacked Electron app has an invalid resource seal. */
const {execFileSync}=require('node:child_process');
const {join}=require('node:path');
module.exports=async context=>{
  if(context.electronPlatformName!=='darwin')return;
  const app=join(context.appOutDir,context.packager.appInfo.productFilename+'.app');
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app],{stdio:'inherit'});
  if(process.env.GEA_MAC_NOTARIZE==='1') {
    execFileSync('/usr/sbin/spctl',['--assess','--type','execute','--verbose=4',app],{stdio:'inherit'});
  } else {
    console.log('INTERNAL TEST BUILD: signature integrity verified; Apple notarization and Gatekeeper distribution acceptance are NOT claimed.');
  }
};
