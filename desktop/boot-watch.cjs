/**
 * 后端启动看门狗。
 *
 * 首次启动（或刚更新完）要解包、被杀软全量扫描、重建 native-presets 与 profile 链接，
 * 这些阶段不打印任何东西却要跑很久，固定 60 秒超时会把还在推进的启动误判成失败。
 * 改成按“还有没有输出”判活：只要子进程持续有输出就继续等，只在长时间完全静默
 * 或超过总时长上限时才判定失败。
 */
const IDLE_MS = 180000;
const TOTAL_MS = 600000;

/** @param {{onTimeout:(error:Error)=>void, idleMs?:number, totalMs?:number}} options */
exports.watchBoot = ({ onTimeout, idleMs = IDLE_MS, totalMs = TOTAL_MS }) => {
  const idleMessage = `工作台启动超时：超过 ${Math.round(idleMs / 1000)} 秒没有收到后端输出，请查看启动日志`;
  const totalMessage = `工作台启动超时：等待超过 ${Math.round(totalMs / 60000)} 分钟，请查看启动日志`;
  let idle, total, done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(idle);
    clearTimeout(total);
  };
  const fail = (message) => {
    if (done) return;
    stop();
    onTimeout(new Error(message));
  };
  idle = setTimeout(() => fail(idleMessage), idleMs);
  total = setTimeout(() => fail(totalMessage), totalMs);
  return {
    /** 子进程每来一块输出就调用一次：只要还在动就不算超时。 */
    touch() {
      if (done) return;
      clearTimeout(idle);
      idle = setTimeout(() => fail(idleMessage), idleMs);
    },
    /** 启动成功或已另行失败时取消看门狗。 */
    stop,
  };
};
