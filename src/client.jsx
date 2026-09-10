/** GEA proof page mounted through public sidebar and main-panel slots. */
import React, { useEffect, useState } from 'react';

export const inject = ['slots', 'layout', 'locale', 'connection', 'sessions', 'uiWorkspace'];
const zh = {
  title: 'GEA 销售计划', tag: '独立插件验证', intro: '只读查询一页销售计划，将选中记录发送到 dsh 会话。',
  login: '飞书扫码登录', refresh: '查询真实销售计划', fixture: '载入演示数据', send: '发送选中记录到会话',
  signedOut: '尚未登录 GEA', signedIn: '已登录', qr: '请使用飞书扫描二维码', pending: '等待扫码确认', expired: '二维码已过期，请重新登录',
  live: '真实 GEA 数据 · 只读', demo: '演示数据 · 非真实业务', none: '还没有查询结果', empty: '本次查询没有记录',
  dealer: '经销商', type: '计划类型', status: '状态码', qty: '当前数量', target: '目标数量', unknown: '未提供',
  coverage: '仅显示第一页，最多 10 条；会话接收其中一条。', receipt: '会话使用本地验证回执，不调用外部模型，也不执行审批。',
  failure: '操作未完成', busy: '处理中…', selected: '选择记录', time: '查询时间', total: '查询总数', help: '登录仅保留在本次服务进程中，重启后需重新登录。',
};
const en = {
  title: 'GEA sales plans', tag: 'Independent plugin proof', intro: 'Read one page of sales plans and send one selected record to a dsh session.',
  login: 'Sign in with Lark QR', refresh: 'Query live sales plans', fixture: 'Load demo data', send: 'Send selected record to session',
  signedOut: 'Not signed in to GEA', signedIn: 'Signed in', qr: 'Scan with Lark', pending: 'Waiting for confirmation', expired: 'QR expired. Sign in again.',
  live: 'Live GEA data · read only', demo: 'Demo data · not real business', none: 'No query yet', empty: 'No records returned',
  dealer: 'Dealer', type: 'Plan type', status: 'Status code', qty: 'Current quantity', target: 'Target quantity', unknown: 'Not provided',
  coverage: 'First page only, at most 10 records. The session receives one selected record.', receipt: 'The session uses a local receipt. No external model or approval is invoked.',
  failure: 'Operation failed', busy: 'Working…', selected: 'Select record', time: 'Fetched at', total: 'Total', help: 'Login remains in this server process only. Restart requires signing in again.',
};

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register('geaProof', { zh, en }));
  const t = ctx.locale.bind('geaProof');
  async function rpc(endpoint, payload = {}) {
    const response = await fetch('/api/gea-proof/' + endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error('HOST_HTTP_' + response.status);
    const result = await response.json();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  async function send(index) {
    const [prepared, status] = await Promise.all([rpc('prepare', { index }), rpc('status')]);
    const sessionId = await ctx.sessions.create({ cwd: status.workspace });
    const binding = ctx.sessions.binding(sessionId);
    const result = await binding.session.prompt([{ type: 'text', text: prepared.prompt }], 'queue');
    if (!result.ok) throw new Error(result.error.message);
    ctx.uiWorkspace.openSession(sessionId);
    ctx.layout.selectPanel(null);
  }
  function Page() {
    const [status, setStatus] = useState(null);
    const [qr, setQr] = useState(null);
    const [qrState, setQrState] = useState('pending');
    const [data, setData] = useState(null);
    const [selected, setSelected] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { rpc('status').then(setStatus).catch(e => setError(e.message)); }, []);
    useEffect(() => {
      if (!qr || qrState !== 'pending') return;
      let disposed = false;
      let timer;
      const poll = async () => {
        try {
          const result = await rpc('login/poll');
          if (disposed) return;
          setQrState(result.status);
          if (result.status === 'authenticated') { setStatus(result); setQr(null); }
          else if (result.status === 'pending') timer = setTimeout(poll, 2500);
        } catch (e) { if (!disposed) { setError(e.message); setQrState('failed'); } }
      };
      timer = setTimeout(poll, 2500);
      return () => { disposed = true; clearTimeout(timer); };
    }, [qr, qrState]);
    const act = fn => async () => {
      setBusy(true); setError('');
      try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
    };
    const buttonStyle = { border: '1px solid #a5b4c9', borderRadius: 7, padding: '9px 13px', cursor: 'pointer', fontSize: 14, background: '#fff', color: '#172b43' };
    return <div style={{ overflow: 'auto', height: '100%', padding: '36px 38px', color: '#172b43', background: '#f4f7fb', fontFamily: 'system-ui' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <div style={{ color: '#436594', fontSize: 12, marginBottom: 9 }}>{t('tag')}</div>
        <h1 style={{ fontSize: 28, fontWeight: 650, margin: '0 0 12px' }}>{t('title')}</h1>
        <p style={{ color: '#536377' }}>{t('intro')}</p>
        <section style={{ padding: 20, margin: '24px 0', background: '#fff', border: '1px solid #d8e1ee', borderRadius: 10 }}>
          <p>{status?.authenticated ? `${t('signedIn')}：${status.user.name}` : t('signedOut')}</p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '14px 0' }}>
            <button style={buttonStyle} disabled={busy} onClick={act(async () => { setQr(await rpc('login/start')); setQrState('pending'); })}>{t('login')}</button>
            <button style={{ ...buttonStyle, background: '#1b4f8c', color: '#fff' }} disabled={busy || !status?.authenticated} onClick={act(async () => { setData(null); setData(await rpc('plans')); setSelected(0); })}>{t('refresh')}</button>
            <button style={buttonStyle} disabled={busy} onClick={act(async () => { setData(await rpc('fixture')); setSelected(0); })}>{t('fixture')}</button>
          </div>
          <small style={{ color: '#65758a' }}>{t('help')}</small>
          {qr && <div style={{ marginTop: 18 }}><p>{t('qr')}</p><img width="256" height="256" src={qr.image} alt={t('qr')} /><p>{t(qrState === 'expired' ? 'expired' : 'pending')}</p></div>}
        </section>
        {busy && <p role="status">{t('busy')}</p>}
        {error && <p role="alert" style={{ color: '#a12727' }}>{t('failure')}：{error}</p>}
        {data ? <section style={{ padding: 20, background: '#fff', border: '1px solid #d8e1ee', borderRadius: 10 }}>
          <strong style={{ color: data.source === 'GEA_LIVE_READONLY' ? '#157451' : '#9b6200' }}>{t(data.source === 'GEA_LIVE_READONLY' ? 'live' : 'demo')}</strong>
          <p style={{ fontSize: 13, color: '#65758a' }}>{t('time')}：{data.fetchedAt} · {t('total')}：{data.total}</p>
          <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead><tr>{['selected', 'dealer', 'type', 'status', 'qty', 'target'].map(key => <th key={key} style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid #d8e1ee' }}>{t(key)}</th>)}</tr></thead>
            <tbody>{data.records.map((row, index) => <tr key={index} style={{ background: selected === index ? '#edf4ff' : undefined }}>
              <td style={{ padding: 12 }}><input type="radio" name="plan" aria-label={`${t('selected')} ${index + 1}`} checked={selected === index} onChange={() => setSelected(index)} /></td>
              {[row.dealerName, row.planTypeCode, row.status, row.currentQty, row.targetQty].map((value, cell) => <td key={cell} style={{ padding: 10 }}>{value ?? t('unknown')}</td>)}
            </tr>)}</tbody>
          </table></div>
          {!data.records.length && <p>{t('empty')}</p>}
          <p style={{ color: '#65758a', fontSize: 13 }}>{t('coverage')}</p>
          <button style={{ ...buttonStyle, background: '#1b4f8c', color: '#fff' }} disabled={busy || !data.records.length} onClick={act(() => send(selected))}>{t('send')}</button>
        </section> : <p style={{ color: '#65758a' }}>{t('none')}</p>}
        <p style={{ color: '#65758a', fontSize: 13, marginTop: 22 }}>{t('receipt')}</p>
      </div>
    </div>;
  }
  function Icon({ size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/></svg>; }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'gea-proof', locale: 'geaProof' }, Page));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'gea-proof', label: () => t('title'), order: 5, locale: 'geaProof' }, Icon));
}
