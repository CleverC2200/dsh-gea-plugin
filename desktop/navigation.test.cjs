const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
// 缺少协议实现时先以真实导出缺失暴露失败，不用测试替身替代解析和队列。
let api;try{api=require('./navigation.cjs');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;api={};}
test('协议只接受 ref/v，拒绝重复参数、额外身份、错误动作和超长输入',()=>{
  assert.equal(typeof api.parseNavigation,'function');
  assert.deepEqual(api.parseNavigation('aionui://open-conversation?ref=v1.k1.abc&v=1'),{navigationReference:'v1.k1.abc',schemaVersion:1});
  for(const url of ['aionui://other?ref=abc&v=1','aionui://open-conversation?ref=abc&v=3','aionui://open-conversation?ref=abc&v=1&ref=xyz','aionui://open-conversation?ref=abc&v=1&tenantId=1','aionui://open-conversation?ref=abc&v=1#x','aionui://open-conversation?ref='+ 'a'.repeat(513)+'&v=1','aionui://open-conversation?ref=%ZZ&v=1'])assert.throws(()=>api.parseNavigation(url),/^Error: NAVIGATION_LINK_INVALID$/);
});
test('队列读取不消费，重复合并，过期释放容量，完成后允许重新定位',()=>{
  assert.equal(typeof api.createNavigationQueue,'function');
  let now=0;const queue=api.createNavigationQueue({now:()=>now});
  queue.enqueue('aionui://open-conversation?ref=abc&v=2');const first=queue.pending();
  queue.enqueue('aionui://open-conversation?ref=abc&v=2');assert.deepEqual(queue.pending(),first);
  queue.complete({id:first.id});assert.equal(queue.pending(),null);
  queue.enqueue('aionui://open-conversation?ref=abc&v=2');assert.notEqual(queue.pending().id,first.id);
  for(let i=0;i<15;i++)queue.enqueue(`aionui://open-conversation?ref=item${i}&v=1`);
  assert.throws(()=>queue.enqueue('aionui://open-conversation?ref=overflow&v=1'),/NAVIGATION_QUEUE_FULL/);
  now=900001;assert.equal(queue.pending(),null);
  queue.enqueue('aionui://open-conversation?ref=next&v=1');assert.ok(queue.pending());
});
test('冷启动、第二实例与 macOS 事件接收；正式壳注册，窗口先恢复后聚焦',()=>{
  assert.equal(typeof api.attachNavigation,'function');
  const app=new EventEmitter();app.isPackaged=true;let registered;
  app.setAsDefaultProtocolClient=scheme=>(registered=scheme,true);
  const calls=[];const window={isDestroyed:()=>false,isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')};
  const queue=api.createNavigationQueue();const issues=[];
  api.attachNavigation({app,queue,argv:['exe','aionui://open-conversation?ref=cold&v=1'],getWindow:()=>window,onError:code=>issues.push(code)});
  assert.equal(registered,'aionui');assert.equal(queue.pending().navigationReference,'cold');queue.complete({id:queue.pending().id});
  app.emit('second-instance',{},['exe','aionui://open-conversation?ref=hot&v=2']);assert.equal(queue.pending().navigationReference,'hot');assert.deepEqual(calls.slice(-3),['restore','show','focus']);queue.complete({id:queue.pending().id});
  let prevented=false;app.emit('open-url',{preventDefault:()=>prevented=true},'aionui://open-conversation?ref=mac&v=1');assert.equal(prevented,true);assert.equal(queue.pending().navigationReference,'mac');
  app.emit('open-url',{preventDefault(){}},'aionui://bad?secret=PRIVATE');assert.deepEqual(issues,['NAVIGATION_LINK_INVALID']);
});
test('开发实例不抢占系统协议',()=>{
  assert.equal(typeof api.attachNavigation,'function');const app=new EventEmitter();app.isPackaged=false;app.setAsDefaultProtocolClient=()=>assert.fail('开发不应注册');
  api.attachNavigation({app,queue:api.createNavigationQueue(),argv:[],getWindow:()=>undefined,onError:()=>{}});
});
