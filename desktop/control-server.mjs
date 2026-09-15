/** Private loopback control plane between the Electron owner and its backend. */
import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
export async function createControlServer(handlers) {
  const token=randomBytes(32).toString('hex');
  const expected=Buffer.from('Bearer '+token);
  const server=createServer(async(req,res)=>{
    const supplied=Buffer.from(req.headers.authorization??'');
    if(req.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(403).end();return;}
    const handler=handlers[req.method+' '+req.url];
    if(!handler){res.writeHead(404).end();return;}
    try {
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>65536)throw Error('BODY_TOO_LARGE');chunks.push(chunk);}
      const body=size?JSON.parse(Buffer.concat(chunks).toString()):undefined;
      const value=await handler(body);
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(value??null));
    }catch(error){const code=/^[A-Z][A-Z_0-9]+$/.test(error?.message)?error.message:'CONTROL_ACTION_FAILED';res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:code}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port,token,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
