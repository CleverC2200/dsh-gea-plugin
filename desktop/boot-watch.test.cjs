const test = require('node:test');
const assert = require('node:assert/strict');
const { watchBoot } = require('./boot-watch.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('首启准备期间持续有输出就不判超时', async () => {
  let failed = null;
  const watch = watchBoot({ onTimeout: error => { failed = error; }, idleMs: 80, totalMs: 600 });
  for (let i = 0; i < 6; i += 1) { await sleep(30); watch.touch(); }
  assert.equal(failed, null);
  watch.stop();
});

test('彻底静默超过静默窗口就判超时', async () => {
  let failed = null;
  const watch = watchBoot({ onTimeout: error => { failed = error; }, idleMs: 40, totalMs: 600 });
  await sleep(160);
  assert.match(failed.message, /没有收到后端输出/);
  watch.stop();
});

test('一直有输出也会在总时长上限处停住', async () => {
  let failed = null;
  const watch = watchBoot({ onTimeout: error => { failed = error; }, idleMs: 400, totalMs: 60 });
  await sleep(60);
  assert.match(failed.message, /等待超过 0 分钟/);
  watch.stop();
});

test('启动成功后不再触发超时', async () => {
  let failed = null;
  const watch = watchBoot({ onTimeout: error => { failed = error; }, idleMs: 30, totalMs: 60 });
  watch.stop();
  await sleep(120);
  assert.equal(failed, null);
});
