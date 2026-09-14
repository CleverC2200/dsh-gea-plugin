/** First launch uses release-owned company defaults; existing user data is preserved. */
exports.ensureConfiguration = async path => {
  const {writeFile} = require('node:fs/promises');
  const config = require('./company.config.json');
  try { await writeFile(path,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600}); }
  catch(error) { if(error.code!=='EEXIST')throw error; }
};
/** Accept only the loopback launch URL emitted by this owned DSH process. */
exports.launchUrl = (line) => {
  const match = line.match(/^dsh web: (http[^\s]+)$/);
  if (!match) return undefined;
  const url = new URL(match[1]);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password)
    throw new Error('DSH 返回了无效的本地启动地址');
  return url.href;
};
