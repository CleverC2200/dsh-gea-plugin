/** Private desktop state transport; never mounted as a browser or model endpoint. */
import type { Business } from './business.ts';
export async function attachDesktopLogin(business: Business): Promise<{flush(): Promise<void>; dispose(): Promise<void>}> {
  const address=process.env.GEA_DESKTOP_CONTROL_URL;
  const token=process.env.GEA_DESKTOP_CONTROL_TOKEN;
  if(!address||!token)return {flush:async()=>{},dispose:async()=>{}};
  const url=new URL(address);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port)throw Error('INVALID_DESKTOP_CONTROL');
  const request=async(method:string,body?:unknown)=>{
    const response=await fetch(new URL('/login',url),{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('DESKTOP_LOGIN_STORAGE_UNAVAILABLE');
    return response.json();
  };
  const saved=await request('GET');
  if(saved!==null)business.restoreDesktopLogin(saved);
  let pending=Promise.resolve();
  const stop=business.watchIdentity(()=>{
    const snapshot=business.desktopLoginSnapshot();
    pending=pending.catch(()=>{}).then(()=>request('POST',snapshot)).then(()=>{});
    void pending.catch(()=>{});
  });
  return {flush:()=>pending,dispose:async()=>{stop();await pending;}};
}
