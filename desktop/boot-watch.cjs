const IDLE_MS = 180000;
const TOTAL_MS = 600000;

exports.watchBoot = ({ onTimeout, idleMs = IDLE_MS, totalMs = TOTAL_MS }) => {
  const idleMessage = `工作台启动超时：超过 ${Math.round(idleMs / 1000)} 秒没有收到后端输出，请查看启动日志`;
  const totalMessage = `工作台启动超时：等待超过 ${Math.round(totalMs / 60000)} 分钟，请查看启动日志`;
  let idle,
    total,
    done = false;
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
    touch() {
      if (done) return;
      clearTimeout(idle);
      idle = setTimeout(() => fail(idleMessage), idleMs);
    },

    stop,
  };
};
