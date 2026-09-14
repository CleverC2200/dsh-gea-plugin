const {join}=require('node:path');
const target=process.env.GEA_DESKTOP_TARGET;
const payloadRoot=process.env.GEA_DESKTOP_PAYLOAD_ROOT||join(__dirname,'../.runtime/electron-build');
if(!['mac','win'].includes(target))throw new Error('Set GEA_DESKTOP_TARGET to mac or win');
module.exports={
  appId:'com.cleverc2200.gea.desktop',productName:'GEA Desktop',electronVersion:'44.0.0',
  directories:{output:join(__dirname,'../.runtime/electron-build/final',target)},
  artifactName:'GEA-Desktop-${version}-${os}-${arch}.${ext}',
  asar:true,npmRebuild:false,files:['permissions.cjs','updates.mjs','release-sources.json','control-server.mjs','plugin-store.mjs','installer.mjs','main.cjs','config.cjs','company.config.json','package.json'],
  extraResources:[{from:join(payloadRoot,target,'payload'),to:'payload',filter:['**/*','!node_modules/**/*']},{from:join(payloadRoot,target,'payload/node_modules'),to:'payload/node_modules',filter:['**/*']}],
  mac:{icon:join(__dirname,'build/icon.png'),target:['dmg'],category:'public.app-category.productivity',identity:null},
  dmg:{sign:false},
  win:{icon:join(__dirname,'build/icon.png'),target:['nsis'],signExecutable:false},
  nsis:{oneClick:false,allowToChangeInstallationDirectory:true,deleteAppDataOnUninstall:false},
  publish:null
};
