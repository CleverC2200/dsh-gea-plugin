/** Desktop shell owns a bundled Node process and isolated per-user deployment data. */
const {app,BrowserWindow,Menu,shell,dialog,safeStorage} = require('electron');
const {spawn} = require('node:child_process');
const {mkdir,readFile,writeFile,appendFile} = require('node:fs/promises');
const {join} = require('node:path');
const {ensureConfiguration,launchUrl} = require('./config.cjs');
const {startupUrl}=require('./startup-state.cjs');
async function showStartup(error){if(window&&!window.isDestroyed())await window.loadURL(startupUrl(error));}
if (process.env.DSH_GEA_DESKTOP_DATA) app.setPath('userData',process.env.DSH_GEA_DESKTOP_DATA);
const owned = app.requestSingleInstanceLock();
if (!owned) app.quit();
let window,backend,stopping=false,quitting=false,origin,pluginStore,control,updates;
let lifecycle=Promise.resolve();
function runLifecycle(action){const next=lifecycle.then(()=>action());lifecycle=next.catch(()=>{});return next;}
const payload=!app.isPackaged&&process.env.GEA_DESKTOP_PAYLOAD?process.env.GEA_DESKTOP_PAYLOAD:join(process.resourcesPath,'payload');
const data=app.getPath('userData');
const configPath=join(data,'gea.config.json');
const loginPath=join(data,'login.encrypted');
let loginSnapshot=null;
async function readDesktopLogin(){
  let bytes;try{bytes=await readFile(loginPath);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!safeStorage.isEncryptionAvailable())throw Error('SECURE_STORAGE_UNAVAILABLE');
  return JSON.parse(safeStorage.decryptString(bytes));
}
const errorText=error=>String(error?.message??error).replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g,'$1?[redacted]');
async function bounded(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(code)),ms);})]);}finally{clearTimeout(timer);}}
async function stop(){
  const child=backend;
  if(!child)return;
  stopping=true;
  await new Promise(resolve=>{
    let timer;
    const done=()=>{clearTimeout(timer);resolve();};
    child.once('close',done);
    if(child.exitCode!==null||child.signalCode!==null)return done();
    if(child.connected)child.send({type:'stop'},()=>{});
    else child.kill('SIGTERM');
    timer=setTimeout(()=>{
      if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
      else {try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')console.error(errorText(error));}}
    },8000);
  });
  if(backend===child)backend=undefined;
  stopping=false;
}
async function start(recovered=false){
  if(quitting)return;
  await showStartup();
  await appendFile(join(data,'desktop.log'),new Date().toISOString()+' START '+process.platform+' '+process.arch+'\n',{mode:0o600});
  await stop();
  if(quitting)return;
  // OS credential prompts must finish before the backend's private request timeout starts.
  loginSnapshot=await readDesktopLogin();
  if(quitting)return;
  let selected;
  try{selected=await pluginStore.beginBoot();}
  catch(error){
    if(recovered)throw error;
    await pluginStore.failBoot('PLUGIN_SELECTION_INVALID');return start(true);
  }
  const node=join(payload,'node',process.platform==='win32'?'node.exe':'bin/node');
  const runtimeEnv={...process.env};delete runtimeEnv.GEA_RELEASE_TOKEN;
  const child=spawn(node,[join(payload,'start.mjs')],{cwd:payload,detached:process.platform!=='win32',windowsHide:true,
    env:{...runtimeEnv,GEA_CONFIG:configPath,DSH_FULL_DATA_DIR:join(data,'data'),DSH_FULL_PORT:'0',DSH_FULL_NO_OPEN:'1',DSH_PLUGIN_GRAPH:selected.path,DSH_DESKTOP_BASELINE:payload,GEA_DESKTOP_CONTROL_URL:control.url,GEA_DESKTOP_CONTROL_TOKEN:control.token},
    stdio:['ignore','pipe','pipe','ipc']});
  backend=child;
  let pending='';
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('工作台启动超时，请查看应用日志')),60000);
    const fail=error=>{clearTimeout(timer);reject(error);};
    child.once('error',fail);
    child.once('close',code=>fail(new Error(`工作台启动进程已退出 (${code})`)));
    child.stdout.on('data',chunk=>{
      pending+=chunk.toString();
      for(let i;(i=pending.indexOf('\n'))!==-1;){
        const line=pending.slice(0,i).trim();pending=pending.slice(i+1);
        try{const url=launchUrl(line);if(url){clearTimeout(timer);resolve(url);}}
        catch(error){fail(error);}
      }
      if(pending.length>65536)fail(new Error('工作台启动输出过长'));
    });
  });
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
    void appendFile(join(data,'desktop.log'),errorText(chunk.toString()),{mode:0o600}).catch(error=>console.error(errorText(error)));
  });
  child.on('close',code=>{if(!stopping&&!quitting&&origin){origin=undefined;dialog.showErrorBox('工作台已停止',`后端进程退出 (${code})，可通过应用菜单重新启动。`);}});
  try{
    const url=await ready;origin=new URL(url).origin;
    await bounded(window.loadURL(url),15000,'LOCAL_PAGE_TIMEOUT');
    // This local status call does not contact GEA and accepts authenticated=false.
    const healthy=await bounded(window.webContents.executeJavaScript(`fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json','X-GEA-Desktop-Health':'1'},body:'{}',signal:AbortSignal.timeout(10000)}).then(r=>r.json()).then(r=>r.ok===true)`),15000,'LOCAL_HEALTH_TIMEOUT');
    if(!healthy)throw Error('LOCAL_PLUGIN_START_FAILED');
    await pluginStore.confirmBoot();
  } catch(error){
    window.webContents.stop();
    await stop();
    const fallback=await pluginStore.failBoot('BACKEND_START_FAILED');
    if(!recovered&&fallback!==selected.id){
      await appendFile(join(data,'desktop.log'),'新插件未能启动，自动恢复上一版本；用户数据保留。\n',{mode:0o600});
      return start(true);
    }
    throw error;
  }
}
async function preparePlugin(){
  const choice=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'插件发行包',extensions:['tgz']}]});
  if(choice.canceled)return;
  const {installArtifact}=await import('./installer.mjs');
  const id='local-'+Date.now();
  await pluginStore.prepare({id,install:(directory,{registerProcess})=>installArtifact({directory,optimizedBaseline:payload,onProcess:registerProcess,artifact:choice.filePaths[0],
    node:join(payload,'node',process.platform==='win32'?'node.exe':'bin/node'),pnpm:join(payload,'tools/node_modules/pnpm/bin/pnpm.cjs')})});
  await dialog.showMessageBox(window,{message:'插件已准备，当前工作台继续运行',detail:'组合 '+id+'。完成当前任务后，在插件版本菜单中切换并重启。'});
}
async function selectPlugin(){
  const {readdir}=require('node:fs/promises');
  const ids=await readdir(join(data,'plugins/versions')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  const choices=['取消','baseline',...ids];
  const choice=await dialog.showMessageBox(window,{message:'选择插件组合并重启工作台',detail:'重启将停止当前后端，请先结束正在运行的任务。用户配置、会话和工作区保留。',buttons:choices,cancelId:0,defaultId:0});
  if(choice.response===0)return;
  await runLifecycle(async()=>{await stop();await pluginStore.activate(choices[choice.response]);await start();});
}
function report(error){const text=errorText(error);void appendFile(join(data,'desktop.log'),new Date().toISOString()+' STARTUP_ERROR '+text+'\n',{mode:0o600}).catch(()=>{});if(window&&!window.isDestroyed())void showStartup(text).catch(()=>dialog.showErrorBox('GEA Desktop',text));else dialog.showErrorBox('GEA Desktop',text);}
function createWindow(){
  window=new BrowserWindow({width:1440,height:960,minWidth:760,minHeight:600,title:'GEA Desktop',
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//.test(url))void shell.openExternal(url);return{action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin)event.preventDefault();});
  const {allowPermission}=require('./permissions.cjs');
  window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(allowPermission(contents,permission,details.requestingUrl,origin,window?.webContents)));
  window.webContents.session.setPermissionCheckHandler((contents,permission,requestingOrigin)=>allowPermission(contents,permission,requestingOrigin,origin,window?.webContents));
  window.webContents.on('render-process-gone',(_event,details)=>{void appendFile(join(data,'desktop.log'),new Date().toISOString()+' RENDERER_EXIT '+details.reason+' '+details.exitCode+'\n',{mode:0o600});dialog.showErrorBox('工作台页面已停止','请通过应用菜单重新启动，并将启动日志交给维护者。');});
  window.on('closed',()=>{window=undefined;});
}
if(owned){
  app.on('second-instance',()=>{if(window){window.show();window.focus();}});
  app.whenReady().then(async()=>{
    await mkdir(data,{recursive:true,mode:0o700});
    createWindow();await showStartup();
    const {PluginStore}=await import('./plugin-store.mjs');
    pluginStore=new PluginStore({data,baseline:payload});
    await pluginStore.recoverPreparation();
    const {createControlServer}=await import('./control-server.mjs');
    control=await createControlServer({
      ...Object.fromEntries(['status','check','settings','prepare','cancel','restart'].map(action=>[(action==='status'?'GET':'POST')+' /updates/'+action,async value=>{if(!updates)throw Error('UPDATES_UNAVAILABLE');return updates[action](value);}])) ,
      'GET /login':async()=>loginSnapshot,
      'POST /login':async value=>{
        const {rm,rename}=require('node:fs/promises');
        if(value===null){await rm(loginPath,{force:true});loginSnapshot=null;return null;}
        if(!safeStorage.isEncryptionAvailable())throw Error('SECURE_STORAGE_UNAVAILABLE');
        await writeFile(loginPath+'.tmp',safeStorage.encryptString(JSON.stringify(value)),{mode:0o600});
        await rename(loginPath+'.tmp',loginPath);loginSnapshot=value;return null;
      }
    });
    try {
      const {createRequire}=require('node:module');const {pathToFileURL}=require('node:url');
      const dependency=createRequire(join(payload,'package.json'));
      const releases=await import(pathToFileURL(dependency.resolve('dsh-plugin/release-channel')).href);
      const {createUpdates}=await import('./updates.mjs');const {installArtifact}=await import('./installer.mjs');
      updates=await createUpdates({data,store:pluginStore,desktopVersion:require('./package.json').version,releases,
        sources:require('./release-sources.json'),token:process.env.GEA_RELEASE_TOKEN,
        install:(directory,artifact,signal,onProcess)=>installArtifact({directory,optimizedBaseline:payload,artifact,signal,onProcess,onProgress:line=>void appendFile(join(data,'desktop.log'),line,{mode:0o600}).catch(()=>{}),node:join(payload,'node',process.platform==='win32'?'node.exe':'bin/node'),pnpm:join(payload,'tools/node_modules/pnpm/bin/pnpm.cjs')}),
        restart:id=>runLifecycle(async()=>{if(quitting)throw Error('DESKTOP_CLOSING');await stop();if(quitting)throw Error('DESKTOP_CLOSING');await pluginStore.activate(id);await start();})});
    }catch(error){await appendFile(join(data,'desktop.log'),'公司更新服务不可用：'+errorText(error)+'\n',{mode:0o600});}
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'GEA Desktop',submenu:[{label:'打开数据目录',click:()=>void shell.openPath(data)},{label:'打开启动日志',click:()=>void shell.openPath(join(data,'desktop.log'))},{label:'重新启动工作台',click:()=>void runLifecycle(start).catch(report)},{type:'separator'},{role:'quit'}]},
      {label:'插件版本',submenu:[
        {label:'准备本地插件包',click:()=>void preparePlugin().catch(report)},
        {label:'切换已准备版本并重启',click:()=>void selectPlugin().catch(report)},
        {label:'查看当前版本',click:()=>void pluginStore.selected().then(selected=>dialog.showMessageBox(window,{message:'当前插件组合：'+selected.id,detail:JSON.stringify(selected.receipt?.versions??{},null,2)})).catch(report)}
      ]},
      {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'视图',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}
    ]));
    await ensureConfiguration(configPath);
    await runLifecycle(start);
    await updates?.start();
  }).catch(report);
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitting)return;
    event.preventDefault();quitting=true;
    const updatesClosing=updates?.close();
    void runLifecycle(stop).finally(async()=>{await updatesClosing;await control?.close();app.quit();});
  });
}
