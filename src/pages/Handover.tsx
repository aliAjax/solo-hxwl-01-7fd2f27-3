import React, { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtTime, AuditEntry, HandoverData } from '../api';
import { Pill, Empty, Section, useToast, useApiError } from '../ui';
import { AlertList } from './Dashboard';

export function Handover({ onJump }: { onJump: (entityType: string, entityId: string) => void }) {
  const [data, setData] = useState<HandoverData | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [shift, setShift] = useState('白班');
  const [note, setNote] = useState('');
  const [auditFilter, setAuditFilter] = useState('');
  const toast = useToast();
  const onErr = useApiError(() => refresh());

  const refresh = async () => {
    const [h, a] = await Promise.all([
      api<HandoverData>('GET', '/api/handover'),
      api<{ audit: AuditEntry[] }>('GET', `/api/audit?limit=200${auditFilter ? `&entityType=${auditFilter}` : ''}`),
    ]);
    setData(h);
    setAudit(a.audit);
  };
  useEffect(() => { refresh().catch(() => {}); }, [auditFilter]);

  const confirm = async () => {
    try {
      const r = await api<{ handover: { id: string } }>('POST', '/api/handover', { shift, note });
      toast('ok', `交接班记录 ${r.handover.id} 已生成`);
      setNote('');
      await refresh();
    } catch (e) { onErr(e); }
  };

  if (!data) return <div className="page"><Empty text="加载中…" /></div>;

  return (
    <div className="page">
      <div className="handover-grid">
        <Section title="待交接事项">
          <div className="handover-list">
            <HandoverBlock title={`待放行批次（${data.pendingRelease.length}）`}
              rows={data.pendingRelease.map((b) => ({
                key: b.id,
                main: <><span className="mono strong">{b.batchNo}</span> <Pill text={b.releaseStatus} /></>,
                sub: `化学 ${b.chemMonitor} / 生物 ${b.bioMonitor}${b.bioMonitorDueAt ? ` · 判读时限 ${fmtDateTime(b.bioMonitorDueAt)}` : ''}`,
                onClick: () => onJump('batch', b.id),
              }))} />
            <HandoverBlock title={`锁定批次（${data.lockedBatches.length}）`}
              rows={data.lockedBatches.map((b) => ({
                key: b.id,
                main: <><span className="mono strong">{b.batchNo}</span> <Pill text={b.releaseStatus} /></>,
                sub: `🔒 ${b.lockReason}`,
                onClick: () => onJump('batch', b.id),
              }))} />
            <HandoverBlock title={`活跃暂停（${data.activePauses.length}）`}
              rows={data.activePauses.map((p) => ({
                key: p.id,
                main: <><span className="mono strong">{p.id}</span> <Pill text={p.status} /></>,
                sub: `${p.reason} · ${p.items.filter((i) => !i.restoredAt).length} 件未恢复`,
                onClick: () => onJump('instrument', p.rootInstrumentId),
              }))} />
            <HandoverBlock title={`未归还器械（${data.openUsage.length}）`}
              rows={data.openUsage.map((u) => ({
                key: u.id,
                main: <><span className="mono strong">{u.instrument?.code}</span> {u.instrument?.name} <Pill text={u.status} /></>,
                sub: `${u.room} · ${u.operator} · 自 ${fmtTime(u.startAt)}${u.alert ? ` · ⚠ ${u.alert}` : ''}`,
                onClick: () => onJump('instrument', u.instrumentId),
              }))} />
            <HandoverBlock title={`隔离中器械（${data.quarantined.length}）`}
              rows={data.quarantined.map((i) => ({
                key: i.id,
                main: <><span className="mono strong">{i.code}</span> {i.name}</>,
                sub: i.category,
                onClick: () => onJump('instrument', i.id),
              }))} />
          </div>
        </Section>

        <div>
          <Section title="交接确认">
            <div className="handover-form">
              <div className="chips">
                {['白班', '夜班'].map((s) => (
                  <button key={s} className={`chip ${shift === s ? 'on' : ''}`} onClick={() => setShift(s)}>{s}</button>
                ))}
              </div>
              <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="交接备注（如待复检批次、需跟进事项）" />
              <button className="btn primary" onClick={confirm}>生成交接班记录</button>
              <div className="field-hint">确认后写入审计日志，跨班、跨日状态不丢失</div>
            </div>
          </Section>
          <Section title={`当前提醒（${data.alerts.length}）`}>
            <AlertList alerts={data.alerts} onJump={(a) => onJump(a.entityType, a.entityId)} />
          </Section>
        </div>
      </div>

      <Section title="审计日志"
        extra={
          <select value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)}>
            <option value="">全部类型</option>
            <option value="batch">批次</option>
            <option value="instrument">器械</option>
            <option value="equipment">设备</option>
            <option value="pause">暂停</option>
            <option value="handover">交接班</option>
          </select>
        }>
        {audit.length === 0 ? <Empty text="暂无日志" /> : (
          <table className="table">
            <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td className="mono nowrap">{fmtDateTime(a.ts)}</td>
                  <td className="nowrap">{a.actor}</td>
                  <td className="nowrap">{a.action}</td>
                  <td className="mono nowrap dim">{a.entityType}/{a.entityId}</td>
                  <td>{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function HandoverBlock({ title, rows }: {
  title: string;
  rows: { key: string; main: React.ReactNode; sub: string; onClick: () => void }[];
}) {
  return (
    <div className="ho-block">
      <div className="ho-title">{title}</div>
      {rows.length === 0 ? <div className="dim small">无</div> : rows.map((r) => (
        <div key={r.key} className="ho-row" onClick={r.onClick} role="button">
          <div>{r.main}</div>
          <div className="dim small">{r.sub}</div>
        </div>
      ))}
    </div>
  );
}
