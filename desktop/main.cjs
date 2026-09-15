/** Desktop shell owns a bundled Node process and isolated per-user deployment data. */
const {app,BrowserWindow,Menu,ipcMain,shell,dialog} = require('electron');
const {spawn} = require('node:child_process');
const {mkdir,readFile,writeFile,appendFile} = require('node:fs/promises');
const {existsSync} = require('node:fs');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const {configuration,launchUrl} = require('./config.cjs');
if (process.env.DSH_GEA_DESKTOP_DATA) app.setPath('userData',process.env.DSH_GEA_DESKTOP_DATA);
const owned = app.requestSingleInstanceLock();
if (!owned) app.quit();
let window,backend,stopping=false,quitting=false,origin;
const payload=join(process.resourcesPath,'payload');
const data=app.getPath('userData');
const configPath=join(data,'gea.config.json');
const setupUrl=pathToFileURL(join(__dirname,'setup.html')).href;
const errorText=error=>String(error?.message??error).replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g,'$1?[redacted]');
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
async function start(){
  await stop();
  const node=join(payload,'node',process.platform==='win32'?'node.exe':'bin/node');
  const child=spawn(node,[join(payload,'start.mjs')],{cwd:payload,detached:process.platform!=='win32',windowsHide:true,
    env:{...process.env,GEA_CONFIG:configPath,DSH_FULL_DATA_DIR:join(data,'data'),DSH_FULL_PORT:'0',DSH_FULL_NO_OPEN:'1'},
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
  try{const url=await ready;origin=new URL(url).origin;await window.loadURL(url);}
  catch(error){await stop();throw error;}
}
function report(error){dialog.showErrorBox('GEA Desktop',errorText(error));}
function createWindow(){
  window=new BrowserWindow({width:1440,height:960,minWidth:760,minHeight:600,title:'GEA Desktop',
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,preload:join(__dirname,'preload.cjs')}});
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https?:\/\//.test(url))void shell.openExternal(url);return{action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(url!==setupUrl&&new URL(url).origin!==origin)event.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window.on('closed',()=>{window=undefined;});
}
if(owned){
  app.on('second-instance',()=>{if(window){window.show();window.focus();}});
  app.whenReady().then(async()=>{
    await mkdir(data,{recursive:true,mode:0o700});createWindow();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'GEA Desktop',submenu:[{label:'连接设置',click:()=>{void stop().then(()=>{origin=undefined;return window.loadURL(setupUrl);}).catch(report);}},{label:'打开数据目录',click:()=>void shell.openPath(data)},{label:'重新启动工作台',click:()=>void start().catch(report)},{type:'separator'},{role:'quit'}]},
      {label:'编辑',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
      {label:'视图',submenu:[{role:'reload'},{role:'toggleDevTools'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]}
    ]));
    ipcMain.handle('setup:save',async(event,fields)=>{
      if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==setupUrl)return{ok:false,error:'无效的设置请求'};
      try{
        const template=JSON.parse(await readFile(join(payload,'gea.config.example.json'),'utf8'));
        const config=configuration(fields,template);
        await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
        await start();return{ok:true};
      }catch(error){return{ok:false,error:errorText(error)};}
    });
    if(existsSync(configPath))await start();else await window.loadURL(setupUrl);
  }).catch(report);
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitting)return;
    event.preventDefault();quitting=true;
    void stop().finally(()=>app.quit());
  });
}
