const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');

test('desktop native menu labels are explicitly localized to Chinese', () => {
  const source = readFileSync(join(__dirname, 'main.cjs'), 'utf8');
  assert.match(source, /app\.commandLine\.appendSwitch\('lang','zh-CN'\)/);
  for (const [label, role] of [
    ['退出 GEA Desktop', 'quit'],
    ['撤销', 'undo'], ['重做', 'redo'], ['剪切', 'cut'], ['复制', 'copy'], ['粘贴', 'paste'], ['全选', 'selectAll'],
    ['重新加载', 'reload'], ['切换开发者工具', 'toggleDevTools'], ['实际大小', 'resetZoom'], ['放大', 'zoomIn'], ['缩小', 'zoomOut'],
  ]) assert.match(source, new RegExp(`label:'${label}',role:'${role}'`));
});
