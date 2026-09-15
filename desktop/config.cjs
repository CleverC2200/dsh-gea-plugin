/** Validate the desktop setup form before persisting deployment configuration. */
exports.configuration = (input, template) => {
  if (!input || typeof input !== 'object') throw new Error('请填写连接信息');
  const endpoint = (value) => {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('GEA 地址必须为不带账号、查询参数或片段的 HTTPS 地址');
    return url.href.replace(/\/$/, '');
  };
  const production = endpoint(input.production);
  const test = input.test?.trim() ? endpoint(input.test) : production;
  const model = String(input.model ?? '').trim();
  if (!model || model.length > 200) throw new Error('请填写模型 ID');
  return {...template, geaBaseUrl: production, environment:'production',
    geaEnvironments:{production,test}, analysis:{...template.analysis,model}};
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
