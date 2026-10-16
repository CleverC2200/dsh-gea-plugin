import { writeFile, open } from "node:fs/promises";
import { join } from "node:path";
/** Written outside the installed package so a broken GEA can still expose its recovery evidence. */
export async function writePluginRecoveryNotes(directory: string, profileDirectory: string) {
  const script = `import{readFile}from'node:fs/promises';\nconst operation=JSON.parse(await readFile(new URL('./receipt.json',import.meta.url),'utf8'));\nconst saved=JSON.parse(await readFile(new URL('./recovery/snapshot.json',import.meta.url),'utf8'));\nconst processes=operation.processes.map(row=>{let status='unconfirmed';if(row.grouped&&row.sawAlive&&process.platform!=='win32'){try{process.kill(-row.pid,0);status='alive';}catch(error){if(error.code==='ESRCH')status='group-not-found';}}return {...row,status};});\nconsole.log(JSON.stringify({stage:operation.stage,diagnostic:operation.diagnostic,packageName:operation.packageName,targetVersion:operation.targetVersion,profileDirectory:saved.profileDirectory,recoveryDirectory:operation.recoveryDirectory,archivePath:operation.archivePath,baselineSha256:saved.sha256,processes,logs:operation.logs},null,2));\n`;
  await writeFile(join(directory, "recovery-status.mjs"), script, {
    mode: 0o600,
    flag: "wx",
  });
  const notes = `# 插件更新恢复材料\n\n本目录独立于 GEA 包，可在 GEA 无法启动时读取。运行 node recovery-status.mjs 只读状态、恢复材料位置及记录的进程组，不依赖 GEA 模块或服务。状态输出不是恢复授权或完整进程树停止证明。\n\n目标 profile 为 ${profileDirectory}。receipt.json 记录目标归档、操作阶段与进程观察；recovery/snapshot.json 记录完整旧 node_modules、原 manifest/锁、观察过的用户补丁及外部链接摘要。归档和旧图保留，不自动清理。\n\n恢复前完全退出客户端、CLI 与本次 package-manager 进程树。unknown、未观察到进程、无组进程或权限不足时，保留材料并先确认写者已停止，不能盲目 reinstall 或重试更新。外部链接目标由原所有者保全；其内容变化时不能声称旧图已恢复。\n\n恢复只覆盖安装事务的 node_modules、package.json 与 pnpm-lock.yaml，操作仍须使用当前官方 Core 的 withFileLock(profile/package.json)。用户 cordis.patch.yml、设置、Session、草稿、选择和凭据保持现值。若 package.json 的非依赖图字段已经变化，先核变化归属，不按备份覆盖。图恢复后核完整内容摘要和实际依赖，再由正常新进程验证 Host/client 编译版本。不要通过 HMR 或自动重启代替。\n\n脚本只提供包外观察。人工恢复的实际写入、旧图验证与新启动结果需要独立回执，本目录没有自动恢复命令。\n`;
  await writeFile(join(directory, "RECOVERY.md"), notes, {
    mode: 0o600,
    flag: "wx",
  });
  for (const name of ["recovery-status.mjs", "RECOVERY.md"]) {
    const file = await open(join(directory, name), process.platform === "win32" ? "r+" : "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
}
