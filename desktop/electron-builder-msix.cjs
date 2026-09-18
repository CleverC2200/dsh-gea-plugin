// MSIX pilot configuration. Never used by the normal NSIS build.
process.env.GEA_DESKTOP_TARGET='win';
const base=require('./electron-builder.cjs');
const publisher=process.env.GEA_MSIX_PUBLISHER;
if(!publisher)throw new Error('Set GEA_MSIX_PUBLISHER to the signed package publisher before building MSIX');
module.exports={
  ...base,
  artifactName:'GEA-Desktop-${version}-${os}-${arch}-pilot.${ext}',
  win:{...base.win,target:['appx']},
  appx:{
    applicationId:'com.cleverc2200.gea.desktop',
    identityName:'CleverC2200.GEA.Desktop',
    displayName:'GEA Desktop',
    publisher,
    publisherDisplayName:'CleverC2200',
    languages:['zh-CN','en-US']
  }
};
