const test = require('node:test');
const assert = require('node:assert/strict');
const {startupUrl} = require('./startup-state.cjs');
const render = (error, reason) => decodeURIComponent(startupUrl(error, reason).split(',').slice(1).join(','));
test('applying a plugin update explains returning to the workspace without first-login instructions', () => {
  const html = render(undefined, 'update');
  assert.match(html, /正在应用插件更新/);
  assert.match(html, /完成后会自动返回/);
  assert.doesNotMatch(html, /首次启动|进入登录页面|显示扫码页面/);
});
test('recovery and manual restart describe the operation that is actually running', () => {
  assert.match(render(undefined, 'recovery'), /正在恢复可用版本/);
  assert.match(render(undefined, 'restart'), /正在重新打开工作台/);
  assert.match(render(), /需要登录时会显示扫码页面/);
});
test('failed updates expose escaped error details and stop the waiting indicator', () => {
  const html = render('<script>alert("error")</script>', 'update');
  assert.match(html, /更新后暂时无法打开工作台/);
  assert.match(html, /<details open>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|class="activity"/);
});
