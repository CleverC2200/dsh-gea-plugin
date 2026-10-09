/** Local waiting screens distinguish opening the workspace from applying an update. */
const states = {
  startup: {
    title: '正在打开 GEA 工作台',
    description: '正在为你准备工作空间，请稍候。',
    tip: '准备好后会自动进入工作台，需要登录时会显示扫码页面。',
  },
  update: {
    title: '正在应用插件更新',
    description: '工作台正在重新加载，完成后会自动返回。',
    tip: '这一步会短暂中断当前页面，已有会话与工作区会保留。',
  },
  restart: {
    title: '正在重新打开工作台',
    description: '正在恢复工作空间，稍后就可以继续。',
    tip: '无需重复点击，请稍等片刻。',
  },
  recovery: {
    title: '正在恢复可用版本',
    description: '当前版本暂时无法打开，正在切回上一个可用版本。',
    tip: '已有会话与工作区会保留，恢复后即可继续使用。',
  },
};
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/**
 * Render a script-free waiting or failure page.
 * @param {string | undefined} error Displayable startup failure, if any.
 * @param {'startup' | 'update' | 'restart' | 'recovery'} reason Operation being performed.
 * @returns {string} Encoded local document URL.
 */
exports.startupUrl = (error, reason = 'startup') => {
  const state = error ? {
    title: reason === 'update' ? '更新后暂时无法打开工作台' : '工作台暂时未能打开',
    description: '暂时没能完成这一步。可以从应用菜单选择“重新启动工作台”再试一次。',
    tip: '如果仍未恢复，请将下方问题详情和启动日志交给维护者。',
  } : states[reason];
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>GEA 工作台</title>
<style>
html{background:#f7f8fa;color:#242936;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center}
main{box-sizing:border-box;width:min(560px,calc(100vw - 48px));padding:40px 0}
h1{font-size:28px;line-height:1.4;margin:24px 0 12px;text-wrap:balance;font-weight:600}
p{margin:0;color:#596173;font-size:15px}
.activity{display:flex;gap:7px;align-items:center;height:32px}
.activity span{width:7px;height:28px;background:#7264cf;border-radius:4px;animation:waiting 1200ms ease-in-out infinite}
.activity span:nth-child(2){animation-delay:150ms}.activity span:nth-child(3){animation-delay:300ms}
@keyframes waiting{0%,100%{transform:scaleY(.4);opacity:.5}50%{transform:scaleY(1);opacity:1}}
.tip{margin-top:28px;padding-top:20px;border-top:1px solid #e4e6ed}
.tip strong{display:block;color:#414b5e;font-size:13px;margin-bottom:4px;font-weight:600}
.tip p{font-size:13px;max-width:48ch}
details{margin-top:24px;font-size:13px;color:#596173}
summary{cursor:pointer;width:fit-content;text-underline-offset:3px}
summary:hover{color:#5446a5}summary:focus-visible{outline:2px solid #7264cf;outline-offset:4px;border-radius:3px}
details p{margin-top:12px;font-size:13px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 monospace;padding:16px;background:#edeff3;border-radius:8px;color:#414b5e}
.failure-mark{color:#b42318;width:32px;height:32px}
::selection{background:#e8e4f8}
@media(max-width:480px){h1{font-size:24px}main{padding:28px 0}}
@media(prefers-reduced-motion:reduce){.activity span{animation:none}}
</style>
<main>
<div role="${error ? 'alert' : 'status'}" aria-live="polite">
${error ? '<svg class="failure-mark" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="16" cy="16" r="13"/><path d="M16 8v10m0 4v2"/></svg>' : '<div class="activity" aria-hidden="true"><span></span><span></span><span></span></div>'}
<h1>${state.title}</h1><p>${state.description}</p>
</div>
<div class="tip"><strong>小提示</strong><p>${state.tip}</p></div>
<details${error ? ' open' : ''}><summary>${error ? '查看问题详情' : '等待较久？'}</summary>
${error ? `<pre>${escape(error)}</pre>` : '<p>如果长时间没有进入工作台，可通过应用菜单重新启动。</p>'}
<p>应用菜单 → GEA Desktop → 打开启动日志</p></details>
</main></html>`);
};
