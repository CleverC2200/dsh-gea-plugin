import test from 'node:test';import {_electron as electron,expect} from '@playwright/test';import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
test('a backend that has not started shows progress instead of a blank window, then exposes its exit error',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-startup-ui-'));const payload=join(root,'payload');await mkdir(join(payload,'node/bin'),{recursive:true});await symlink(process.execPath,join(payload,'node/bin/node'));await writeFile(join(payload,'package.json'),'{}');await writeFile(join(payload,'start.mjs'),'setTimeout(()=>process.exit(7),4000)');
 const app=await electron.launch({executablePath:resolve(process.env.GEA_ELECTRON_EXECUTABLE),args:[resolve('desktop')],env:{...process.env,DSH_GEA_DESKTOP_DATA:join(root,'data'),GEA_DESKTOP_PAYLOAD:payload}});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});await app.evaluate(({dialog})=>{dialog.showErrorBox=()=>{};});const page=await app.firstWindow();
 await expect(page.getByRole('heading',{name:'正在启动 GEA 工作台'})).toBeVisible({timeout:2500});
 await expect(page.getByRole('heading',{name:'工作台未能启动'})).toBeVisible({timeout:10000});await expect(page.getByText(/进程已退出 \(7\)/)).toBeVisible();
});
