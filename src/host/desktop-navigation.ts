/** 桌面导航交付器：Reference 保留在 Host，浏览器只能消费绑定当前身份的一次性回执。 */
import {randomUUID} from 'node:crypto';
import type {Business} from './business.ts';
import {validateNavigationInput, type NavigationInput, type NavigationTarget} from './navigation-target.ts';

type BusinessPort = Pick<Business, 'status' | 'identitySignal' | 'watchIdentity' | 'resolveClientNavigation' | 'acknowledgeClientNavigation'>;
type ControlRequest = (path: string, body?: unknown) => Promise<unknown>;
type Delivery = NavigationInput & {id: string};
type Active = {id: string; receipt: string; signal: AbortSignal; target?: NavigationTarget; error?: string; visible: boolean; acked: boolean};
export type NavigationView = ({state: 'idle' | 'unavailable' | 'login'} |
  {state: 'error'; receipt?: string; code: string} |
  {state: 'ready'; receipt: string; panel: string; notificationId?: string; interactionRequestId?: string}) & {identityRevision?: number};

/** 原始异常可能包含网络地址，只有受控机器码可离开此模块。 */
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(NAVIGATION|NOTIFICATION)_[A-Z_]{1,64}$/.test(message) ? message : 'NAVIGATION_REQUEST_FAILED';
}

/** 私有端点 404 表示旧客户端壳，不阻断普通插件业务。 */
async function desktopRequest(path: string, body?: unknown): Promise<unknown> {
  const address = process.env.GEA_DESKTOP_CONTROL_URL;
  const token = process.env.GEA_DESKTOP_CONTROL_TOKEN;
  if (!address || !token) return undefined;
  let url: URL;
  try {url = new URL(address);} catch {throw Error('NAVIGATION_CONTROL_INVALID');}
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw Error('NAVIGATION_CONTROL_INVALID');
  let response: Response;
  try {
    response = await fetch(new URL(path, url), {method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type':'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)});
  } catch {throw Error('NAVIGATION_CONTROL_UNAVAILABLE');}
  if (response.status === 404) return undefined;
  if (!response.ok) throw Error('NAVIGATION_CONTROL_UNAVAILABLE');
  try {return await response.json();} catch {throw Error('NAVIGATION_CONTROL_INVALID');}
}

/** 串行交付与回执，重复读取合并；身份变化立即废弃已解析目标。 */
export function createDesktopNavigation(business: BusinessPort, request: ControlRequest = desktopRequest) {
  let active: Active | undefined;
  let disposed = false;
  let identityRevision = 0;
  let tail: Promise<unknown> = Promise.resolve();
  let polling: Promise<NavigationView> | undefined;
  const stop = business.watchIdentity(() => {identityRevision++;active = undefined;});
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = tail.then(action);tail = next.catch(() => {});return next;
  };
  const view = (): NavigationView => {
    if (!business.status().authenticated) return {state:'login'};
    if (!active) return {state:'idle'};
    if (active.target && active.target.expiresAt <= Date.now()) active.error = 'NAVIGATION_REFERENCE_EXPIRED';
    if (active.error) return {state:'error',receipt:active.receipt,code:active.error};
    if (!active.target) return {state:'idle'};
    return {state:'ready',receipt:active.receipt,panel:active.target.panel,
      ...(active.target.notificationId ? {notificationId:active.target.notificationId,interactionRequestId:active.target.interactionRequestId} : {})};
  };
  const current = (item: Active) => !disposed && active === item && !item.signal.aborted;
  const record = (stage: string, result: string) => console.info(JSON.stringify({event:'GEA_CLIENT_NAVIGATION',stage,result}));
  async function read(): Promise<NavigationView> {
    if (disposed) return {state:'unavailable'};
    let raw: unknown;
    try {raw = await request('/navigation/pending');} catch (error) {return {state:'error',code:errorCode(error)};}
    if (raw === undefined) {active = undefined;return {state:'unavailable'};}
    if (raw === null) {active = undefined;return {state:'idle'};}
    const item = raw as Delivery;
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(item.id)) return {state:'error',code:'NAVIGATION_CONTROL_INVALID'};
    if (active?.id !== item.id) active = undefined;
    if (!business.status().authenticated) return {state:'login'};
    if (!active) {
      const task: Active = {id:item.id,receipt:randomUUID(),signal:business.identitySignal(),visible:false,acked:false};
      active = task;
      try {
        const input = {navigationReference:item.navigationReference,schemaVersion:item.schemaVersion};
        validateNavigationInput(input);
        const target = await business.resolveClientNavigation(input, task.signal);
        if (current(task)) {task.target = target;record('resolve','success');}
      } catch (error) {
        if (current(task)) {task.error = errorCode(error);record('resolve',task.error);}
      }
    }
    return view();
  }
  async function complete(task: Active, visible: boolean): Promise<NavigationView> {
    if (!current(task)) throw Error('NAVIGATION_RECEIPT_STALE');
    if (visible) {
      if (!task.target) throw Error('NAVIGATION_RECEIPT_STALE');
      if (task.target.expiresAt <= Date.now()) {task.error = 'NAVIGATION_REFERENCE_EXPIRED';return view();}
      task.visible = true;
    }
    try {
      if (visible && !task.acked) {
        await business.acknowledgeClientNavigation(task.target!.intentId,task.receipt,task.signal);
        if (!current(task)) throw Error('NAVIGATION_RECEIPT_STALE');
        task.acked = true;record('target-visible','success');
      }
      await request('/navigation/complete',{id:task.id});
      if (current(task)) active = undefined;
      return {state:'idle'};
    } catch (error) {
      if (!current(task)) throw Error('NAVIGATION_RECEIPT_STALE');
      task.error = errorCode(error);record('complete',task.error);return view();
    }
  }
  return {
    poll(): Promise<NavigationView> {
      if (!polling) polling = serial(read).then(value => ({...value,identityRevision})).finally(() => {polling = undefined;});
      return polling;
    },
    finish(value: Record<string, unknown>): Promise<NavigationView> {
      return serial(async () => {
        if (Object.keys(value).some(key => !['receipt','outcome'].includes(key)) || typeof value.receipt !== 'string' || !['visible','dismissed'].includes(String(value.outcome))) throw Error('NAVIGATION_REQUEST_INVALID');
        if (!active || active.receipt !== value.receipt) throw Error('NAVIGATION_RECEIPT_STALE');
        return complete(active,value.outcome === 'visible');
      });
    },
    retry(): Promise<NavigationView> {
      return serial(async () => {
        if (active?.visible) return complete(active,true);
        active = undefined;return read();
      });
    },
    dispose(){disposed = true;active = undefined;stop();}
  };
}
