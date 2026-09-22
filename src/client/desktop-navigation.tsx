/** 桌面消息消费界面；只接收安全投影，不接触原始链接或凭证。 */
import React, {useEffect, useRef, useState} from 'react';
import type {CopyKey} from './locales.ts';
import type {NavigationView} from '../host/desktop-navigation.ts';

export type ReadyNavigation = Extract<NavigationView, {state:'ready'}>;
export type PageNavigation = ReadyNavigation & {visible():void; failed(error: Error):void};

/** 业务页面订阅当前导航；以实际渲染回执完成等待。 */
export function createNavigationSelection() {
  let value: PageNavigation | null = null;
  const listeners = new Set<() => void>();
  return {getSnapshot: () => value,
    subscribe(listener: () => void) {listeners.add(listener);return () => {listeners.delete(listener);};},
    set(next: PageNavigation | null) {value = next;listeners.forEach(listener => listener());}};
}

async function request(action: string, body: object = {}, signal?: AbortSignal): Promise<NavigationView> {
  const response = await fetch('/api/gea-proof/navigation/' + action, {method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  if (!response.ok) throw Error('NAVIGATION_REQUEST_FAILED');
  const result = await response.json();
  if (result.ok !== true) throw Error('NAVIGATION_REQUEST_FAILED');
  return result.value;
}

/** 独立提示条不阻断正常业务；轮询持续观察身份变化，已处理 receipt 不重复打开。 */
export function DesktopNavigation({t,open,login}: {t:(key:CopyKey)=>string;open:(target:ReadyNavigation,signal:AbortSignal)=>Promise<void>;login:()=>void}) {
  const [view,setView] = useState<NavigationView>({state:'idle'});
  const active = useRef<{receipt:string;controller:AbortController;done:boolean;failed:boolean}>();
  const [revision,setRevision] = useState(0);
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let identityRevision: number | undefined;
    const consume = (next: NavigationView) => {
      if (controller.signal.aborted) return;
      if (identityRevision !== undefined && next.identityRevision !== undefined && identityRevision !== next.identityRevision) {
        active.current?.controller.abort();active.current=undefined;
      }
      if (next.identityRevision !== undefined) identityRevision = next.identityRevision;
      if (next.state !== 'ready') {
        if (next.state !== 'error' && active.current && (next.state !== 'idle' || !active.current.done)) {
          active.current.controller.abort();active.current = undefined;
        }
        setView(next);return;
      }
      if (active.current?.receipt === next.receipt) return;
      active.current?.controller.abort();
      const task = {receipt:next.receipt,controller:new AbortController(),done:false,failed:false};
      active.current = task;setView(next);
      void open(next,task.controller.signal).then(async () => {
        if (controller.signal.aborted || task.controller.signal.aborted || active.current !== task) return;
        task.done = true;
        const completed = await request('finish',{receipt:next.receipt,outcome:'visible'},controller.signal);
        if (!controller.signal.aborted && active.current === task) setView(completed);
      }).catch(() => {
        if (controller.signal.aborted || task.controller.signal.aborted || active.current !== task) return;
        task.failed = true;setView({state:'error',receipt:next.receipt,code:'NAVIGATION_TARGET_UNAVAILABLE'});
      });
    };
    const poll = async () => {
      try {consume(await request('poll',{},controller.signal));}
      catch {if(!controller.signal.aborted)setView({state:'error',code:'NAVIGATION_REQUEST_FAILED'});}
      finally {if(!controller.signal.aborted)timer=setTimeout(poll,1500);}
    };
    void poll();
    return () => {controller.abort();clearTimeout(timer);active.current?.controller.abort();active.current=undefined;};
  },[open,revision]);
  const action = async (dismiss: boolean) => {
    if (busy) return;setBusy(true);
    try {
      const next = dismiss && view.state === 'error' && view.receipt
        ? await request('finish',{receipt:view.receipt,outcome:'dismissed'}) : await request('retry');
      active.current?.controller.abort();active.current=undefined;setView(next);setRevision(value=>value+1);
    } catch {setView({state:'error',code:'NAVIGATION_REQUEST_FAILED'});}
    finally {setBusy(false);}
  };
  if (view.state === 'idle' || view.state === 'unavailable') return null;
  const code = view.state === 'error' ? view.code : '';
  const message = view.state === 'login' ? 'navigationLogin' : view.state === 'ready' ? 'navigationOpening' :
    /EXPIRED|REVOKED/.test(code) ? 'navigationExpired' : /FORBIDDEN/.test(code) ? 'navigationForbidden' :
    /UNSUPPORTED|UNAVAILABLE|INCOMPLETE/.test(code) ? 'navigationUnavailable' : 'navigationFailed';
  return <div role={view.state === 'error' ? 'alert':'status'} style={{position:'fixed',bottom:24,left:'50%',transform:'translateX(-50%)',zIndex:10000,padding:'12px 18px',border:'1px solid #cbd5e1',borderRadius:8,background:'var(--background,#fff)',color:'var(--foreground,#182230)',boxShadow:'0 4px 16px #0002',maxWidth:'80vw'}}>
    <span>{t(message)}</span>{' '}
    {view.state === 'login' && <button onClick={login}>{t('navigationLoginAction')}</button>}
    {view.state === 'error' && <><button disabled={busy} onClick={()=>void action(false)}>{t('retry')}</button>{' '}{view.receipt && <button disabled={busy} onClick={()=>void action(true)}>{t('close')}</button>}</>}
  </div>;
}
