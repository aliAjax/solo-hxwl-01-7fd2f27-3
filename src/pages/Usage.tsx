import React, { useEffect, useState } from 'react';
import { api, fmtTime, Instrument, Usage } from '../api';
import { Pill, Empty, Section, useToast, useApiError } from '../ui';

const ROOMS = ['诊室1', '诊室2', '测听室1', '测听室2', '验配室', '处置室'];

export function UsagePage() {
  const [usage, setUsage] = useState<Usage[]>([]);
  const [sterile, setSterile] = useState<Instrument[]>([]);
  const [instrumentId, setInstrumentId] = useState('');
  const [room, setRoom] = useState(ROOMS[0]);
  const toast = useToast();
  const onErr = useApiError(() => refresh());

  const refresh = async () => {
    const [u, i] = await Promise.all([
      api<{ usage: Usage[] }>('GET', '/api/usage'),
      api<{ instruments: Instrument[] }>('GET', '/api/instruments?status=无菌在库'),
    ]);
    setUsage(u.usage);
    setSterile(i.instruments);
  };
  useEffect(() => { refresh().catch(() => {}); const t = setInterval(() => refresh().catch(() => {}), 15000); return () => clearInterval(t); }, []);

  const checkout = async () => {
    if (!instrumentId) return;
    try {
      await api('POST', `/api/instruments/${instrumentId}/checkout`, { room });
      toast('ok', '已领取');
      setInstrumentId('');
      await refresh();
    } catch (e) { onErr(e); }
  };
  const doReturn = async (u: Usage) => {
    try {
      await api('POST', `/api/instruments/${u.instrumentId}/return`, {});
      toast('ok', '已归还，转入待处理');
      await refresh();
    } catch (e) { onErr(e); }
  };

  const open = usage.filter((u) => u.endAt == null);
  const history = usage.filter((u) => u.endAt != null).slice(0, 30);

  return (
    <div className="page">
      <Section title="领取器械">
        <div className="checkout-bar">
          <select value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}>
            <option value="">选择无菌在库器械…</option>
            {sterile.map((i) => <option key={i.id} value={i.id}>{i.code} {i.name}（效期至 {i.sterileUntil?.slice(0, 10)}）</option>)}
          </select>
          <select value={room} onChange={(e) => setRoom(e.target.value)}>
            {ROOMS.map((r) => <option key={r}>{r}</option>)}
          </select>
          <button className="btn primary" disabled={!instrumentId} onClick={checkout}>领取</button>
          {sterile.length === 0 && <span className="dim">暂无可领取的无菌器械</span>}
        </div>
      </Section>

      <Section title={`使用中（${open.length}）`}>
        {open.length === 0 ? <Empty text="当前无使用中的器械" /> : (
          <table className="table">
            <thead><tr><th>器械</th><th>诊室</th><th>领取时间</th><th>操作人</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {open.map((u) => (
                <tr key={u.id} className={u.alert ? 'row-alert' : ''}>
                  <td className="mono strong">{u.instrument?.code} {u.instrument?.name}</td>
                  <td>{u.room}</td>
                  <td className="mono">{fmtTime(u.startAt)}</td>
                  <td>{u.operator}</td>
                  <td>
                    <Pill text={u.status} />
                    {u.alert && <div className="warn-text small">⚠ {u.alert}</div>}
                  </td>
                  <td>{u.status === '使用中' && <button className="btn small" onClick={() => doReturn(u)}>归还</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="最近领用记录">
        {history.length === 0 ? <Empty text="暂无记录" /> : (
          <table className="table">
            <thead><tr><th>器械</th><th>诊室</th><th>领取</th><th>归还</th><th>操作人</th></tr></thead>
            <tbody>
              {history.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.instrument?.code} {u.instrument?.name}</td>
                  <td>{u.room}</td>
                  <td className="mono">{fmtTime(u.startAt)}</td>
                  <td className="mono">{fmtTime(u.endAt)}</td>
                  <td>{u.operator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
