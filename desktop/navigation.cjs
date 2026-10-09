/** 桌面只负责协议接收与有界内存交付，不解析业务目标或持有 GEA 登录令牌。 */
const {randomUUID}=require('node:crypto');

/** 严格接收现有 GEA ref/v 链接；错误不包含原始输入。 */
function parseNavigation(value){
  // 飞书/浏览器链路可能保留动作后的根斜杠，仅兼容空路径和根路径。
  if(typeof value!=='string'||value.length>2048||!/^aionui:\/\/open-conversation\/?\?[^#\s]+$/.test(value))throw Error('NAVIGATION_LINK_INVALID');
  const url=new URL(value);
  const params=url.searchParams;
  if(url.hostname!=='open-conversation'||url.username||url.password||url.port||!['','/'].includes(url.pathname)||url.hash||
      [...params.keys()].length!==2||params.getAll('ref').length!==1||params.getAll('v').length!==1||
      !/^[A-Za-z0-9._-]{1,512}$/.test(params.get('ref')||'')||!['1','2'].includes(params.get('v')))
    throw Error('NAVIGATION_LINK_INVALID');
  return {navigationReference:params.get('ref'),schemaVersion:Number(params.get('v'))};
}

/** 队列保留到显式确认或十五分钟超时；取出副本防止调用者改写条目。 */
function createNavigationQueue({now=Date.now}={}){
  const entries=[];
  const prune=()=>{while(entries.length&&entries[0].expiresAt<=now())entries.shift();};
  return {
    enqueue(url){
      const input=parseNavigation(url);prune();
      if(entries.some(item=>item.navigationReference===input.navigationReference&&item.schemaVersion===input.schemaVersion))return;
      if(entries.length>=16)throw Error('NAVIGATION_QUEUE_FULL');
      entries.push({...input,id:randomUUID(),expiresAt:now()+15*60*1000});
    },
    pending(){prune();const first=entries[0];return first?{id:first.id,navigationReference:first.navigationReference,schemaVersion:first.schemaVersion}:null;},
    complete(value){
      if(!value||Object.keys(value).length!==1||typeof value.id!=='string')throw Error('NAVIGATION_REQUEST_INVALID');
      prune();const index=entries.findIndex(item=>item.id===value.id);if(index>=0)entries.splice(index,1);
    }
  };
}

/** 主进程生命周期入口：尽早登记事件，开发环境不改系统关联。 */
function attachNavigation({app,queue,argv,getWindow,onError}){
  const focus=()=>{const window=getWindow();if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}};
  const receive=value=>{
    try{queue.enqueue(value);}catch(error){onError(['NAVIGATION_QUEUE_FULL','NAVIGATION_LINK_INVALID'].includes(error.message)?error.message:'NAVIGATION_LINK_INVALID');}
    focus();
  };
  const fromArgs=args=>{for(const arg of args)if(typeof arg==='string'&&/^aionui:/i.test(arg))receive(arg);};
  app.on('open-url',(event,url)=>{event.preventDefault();receive(url);});
  app.on('second-instance',(_event,args)=>{fromArgs(args);focus();});
  if(app.isPackaged&&!app.setAsDefaultProtocolClient('aionui'))onError('NAVIGATION_REGISTRATION_FAILED');
  fromArgs(argv);
}
module.exports={parseNavigation,createNavigationQueue,attachNavigation};
