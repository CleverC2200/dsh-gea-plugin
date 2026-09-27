/** Bundled at build time; this module never initializes Electron's autoUpdater. */
import {GenericDifferentialDownloader} from 'electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js';
import {HttpExecutor,CancellationToken} from 'builder-util-runtime';
import http from 'node:http';
import https from 'node:https';

export async function reconstructInstaller({artifact,oldFile,newFile,oldMap,newMap,signal,idleTimeoutMs=60000,onProgress=()=>{},requestFactory}){
  const cancellationToken=new CancellationToken(),requests=new Set();
  let networkBytes=0;
  const cancel=()=>{cancellationToken.cancel();for(const r of requests){if(r.destroy)r.destroy(signal.reason);else r.abort();}};
  signal.addEventListener('abort',cancel,{once:true});signal.throwIfAborted();
  class Executor extends HttpExecutor{
    createRequest(options,callback){
      const url=new URL(`${options.protocol}//${options.hostname}${options.port?':'+options.port:''}${options.path}`);
      if(url.href!==artifact.url)throw Error('DESKTOP_DIFFERENTIAL_URL');
      const range=options.headers?.Range??options.headers?.range;
      const match=/^bytes=(\d+)-(\d+)$/.exec(range??'');
      if(!match||+match[1]>+match[2]||+match[2]>=artifact.bytes)throw Error('DESKTOP_DIFFERENTIAL_RANGE');
      const expected=+match[2]-+match[1]+1;
      let timer,request;
      const abort=error=>{if(request.destroy)request.destroy(error);else{request.abort();request.emit('error',error);}};
      const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>abort(Error('DESKTOP_DOWNLOAD_IDLE_TIMEOUT')),idleTimeoutMs);};
      request=(requestFactory??((o,cb)=>(o.protocol==='https:'?https:http).request(o,cb)))(options,response=>{
        touch();const header=response.headers['content-range'];
        if(response.statusCode!==206||header!==`bytes ${match[1]}-${match[2]}/${artifact.bytes}`){response.resume();abort(Error('DESKTOP_DIFFERENTIAL_RESPONSE'));return;}
        let received=0;
        response.on('data',chunk=>{touch();received+=chunk.length;networkBytes+=chunk.length;if(received>expected)abort(Error('DESKTOP_DIFFERENTIAL_LENGTH'));});
        response.on('end',()=>{clearTimeout(timer);if(received!==expected)abort(Error('DESKTOP_DIFFERENTIAL_LENGTH'));});
        callback(response);
      });
      requests.add(request);touch();request.once('close',()=>{clearTimeout(timer);requests.delete(request);});
      if(signal.aborted)cancel();return request;
    }
  }
  try{
    await new GenericDifferentialDownloader({size:artifact.bytes,sha512:artifact.differential.sha512},new Executor(),{
      oldFile,newFile,newUrl:new URL(artifact.url),logger:{info(){},warn(){},error(){}},requestHeaders:{},cancellationToken,isUseMultipleRangeRequest:false,
      onProgress:info=>onProgress({percent:info.percent,networkBytes}),
    }).download(oldMap,newMap);
    signal.throwIfAborted();return {networkBytes};
  }finally{signal.removeEventListener('abort',cancel);for(const r of requests){if(r.destroy)r.destroy();else r.abort();}}
}
