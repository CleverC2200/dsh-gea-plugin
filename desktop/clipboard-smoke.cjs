/** Electron smoke: verify navigator.clipboard uses the same permission handlers as the desktop. */
const {app,BrowserWindow,clipboard}=require('electron');
const {createServer}=require('node:http');
const {allowPermission}=require('./permissions.cjs');
app.whenReady().then(async()=>{
  const server=createServer((_req,res)=>res.end('<!doctype html><button>Copy</button>'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const window=new BrowserWindow({show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(allowPermission(contents,permission,details.requestingUrl,origin,window.webContents)));
  window.webContents.session.setPermissionCheckHandler((contents,permission,requestingOrigin)=>allowPermission(contents,permission,requestingOrigin,origin,window.webContents));
  try {
    await window.loadURL(origin);
    window.focus();
    await window.webContents.executeJavaScript('navigator.clipboard.writeText("GEA clipboard smoke")',true);
    await new Promise(resolve=>setTimeout(resolve,200));
    if(await clipboard.readText()!=='GEA clipboard smoke')throw Error('CLIPBOARD_CONTENT_MISMATCH');
    console.log('CLIPBOARD_SMOKE_PASS');
  } catch(error) { console.error(String(error));process.exitCode=1; }
  finally {window.destroy();server.close();app.exit(process.exitCode??0);}
});
