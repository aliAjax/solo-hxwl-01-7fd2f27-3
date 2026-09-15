import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime, fmtTime, remainText, newIdemKey, Instrument, TraceData, Pause } from '../api';
import { Pill, Modal, Field, Empty, Section, useToast, useApiError } from '../ui';

const STATUS_FILTERS = ['', '待处理', '处理中', '待放行', '无菌在库', '使用中', '已隔离', '已暂停'];

export function Instruments({ focusId, onFocusConsumed }: { focusId?: string | null; onFocusConsumed?: () => void }) {
  const [list, setList] = useState<Instrument[]>([]);
  const [filter, setFilter] = useState('');
  const [kw, setKw] = useState('');
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const toast = useToast();
  const onErr = useApiError(() => refresh());

  const refresh = async () => {
    const r = await api<{ instruments: Instrument[] }>('GET', `/api/instruments${filter ? `?status=${encodeURIComponent(filter)}` : ''}`);
    setList(r.instruments);
    if (trace) {
      const t = await api<TraceData>('GET', `/api/instruments/${trace.instrument.id}/trace`).catch(() => null);
      if (t) setTrace(t);
    }
  };
  useEffect(() => { refresh().catch(() => {}); const t = setInterval(() => refresh().catch(() => {}), 15000); return () => clearInterval(t); }, [filter, trace?.instrument.id]);

  useEffect(() => {
    if (!focusId) return;
    api<TraceData>('GET', `/api/instruments/${focusId}/trace`).then(setTrace).catch(() => {});
    onFocusConsumed?.();
  }, [focusId]);

  const shown = useMemo(() => {
    if (!kw.trim()) return list;
    const k = kw.trim().toLowerCase();
    return list.filter((i) => i.code.toLowerCase().includes(k) || i.name.toLowerCase().includes(k));
  }, [list, kw]);

  const openTrace = async (id: string) => setTrace(await api<TraceData>('GET', `/api/instruments/${id}/trace`));

  return (
    <div className="page">
      <div className="list-head">
        <div className="chips">
          {STATUS_FILTERS.map((f) => (
            <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f || '全部'}</button>
          ))}
        </div>
        <input className="search" placeholder="搜索编号/名称…" value={kw} onChange={(e) => setKw(e.target.value)} />
        <button className="btn primary" onClick={() => setShowCreate(true)}>+ 登记器械</button>
      </div>
      <table className="table">
        <thead><tr><th>编号</th><th>名称</th><th>类别</th><th>状态</th><th>无菌效期</th><th>位置</th><th></th></tr></thead>
        <tbody>
          {shown.map((i) => (
            <tr key={i.id} className="clickable" onClick={() => openTrace(i.id)}>
              <td className="mono strong">{i.code}</td>
              <td>{i.name}</td>
              <td className="dim">{i.category}</td>
              <td><Pill text={i.status} /></td>
              <td>{i.sterileUntil ? <span title={i.sterileUntil}>{remainText(i.sterileUntil)}</span> : '—'}</td>
              <td className="dim">{i.location}</td>
              <td className="dim">追溯 →</td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <Empty text="没有匹配的器械" />}

      {trace && <TraceDrawer trace={trace} onClose={() => setTrace(null)} onChanged={refresh} onOpenInstrument={openTrace} />}
      {showCreate && <CreateInstrumentModal onClose={() => setShowCreate(false)} onDone={async () => { setShowCreate(false); await refresh(); }} />}
    </div>
  );
}

function TraceDrawer({ trace, onClose, onChanged, onOpenInstrument }: {
  trace: TraceData; onClose: () => void; onChanged: () => Promise<void>; onOpenInstrument: (id: string) => void;
}) {
  const { instrument: inst, batches, usage, pauses, related } = trace;
  const [pauseFor, setPauseFor] = useState(false);
  const [liftPause, setLiftPause] = useState<Pause | null>(null);
  const [checkout, setCheckout] = useState(false);
  const toast = useToast();
  const onErr = useApiError(onChanged);

  const act = async (fn: () => Promise<any>, okMsg: string) => {
    try { await fn(); toast('ok', okMsg); await onChanged(); }
    catch (e) { onErr(e); }
  };

  return (
    <div className="drawer-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer">
        <div className="modal-head">
          <h3><span className="mono">{inst.code}</span> {inst.name} <Pill text={inst.status} /></h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="drawer-body">
          <div className="btn-row">
            {inst.status === '无菌在库' && <button className="btn primary" onClick={() => setCheckout(true)}>领取</button>}
            {inst.status === '使用中' && (
              <button className="btn" onClick={() => act(() => api('POST', `/api/instruments/${inst.id}/return`, { expectedVersion: inst.version }), '已归还，转入待处理')}>归还</button>
            )}
            {inst.status !== '已隔离' && <button className="btn danger" onClick={() => setPauseFor(true)}>异常：一键暂停关联器械</button>}
          </div>

          <Section title={`领用记录（${usage.length}）`}>
            {usage.length === 0 ? <Empty text="无领用记录" /> : (
              <table className="table">
                <thead><tr><th>诊室</th><th>开始</th><th>结束</th><th>操作人</th><th>状态</th></tr></thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={u.id} className={u.alert ? 'row-alert' : ''}>
                      <td>{u.room}</td>
                      <td className="mono nowrap">{fmtTime(u.startAt)}</td>
                      <td className="mono nowrap">{u.endAt ? fmtTime(u.endAt) : '—'}</td>
                      <td>{u.operator}</td>
                      <td>
                        <Pill text={u.status} />
                        {u.alert && <div className="warn-text small">⚠ {u.alert}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title={`消毒批次时间线（${batches.length}）`}>
            {batches.length === 0 ? <Empty text="未经过消毒批次" /> : (
              <div className="timeline">
                {batches.map((b) => (
                  <div key={b.id} className="tl-item">
                    <div className="tl-head">
                      <span className="mono strong">{b.batchNo}</span> <Pill text={b.releaseStatus} />
                    </div>
                    <div className="tl-sub">{b.sterilizerName} · 操作 {b.operatorName}</div>
                    <div className="tl-sub dim">
                      化学 <Pill text={b.chemMonitor} /> 生物 <Pill text={b.bioMonitor} />
                      {b.completedAt && <span> · 完成 {fmtTime(b.completedAt)}</span>}
                      {b.releasedAt && <span> · {b.releasedBy} 放行 {fmtTime(b.releasedAt)}</span>}
                    </div>
                    {b.lockReason && <div className="warn-text small">🔒 {b.lockReason}</div>}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title={`关联器械（${related.length}）`}>
            {related.length === 0 ? <Empty text="无关联器械" /> : (
              <table className="table">
                <tbody>
                  {related.map((r) => (
                    <tr key={r.instrumentId} className="clickable" onClick={() => onOpenInstrument(r.instrumentId)}>
                      <td className="mono">{r.code}</td>
                      <td>{r.name}</td>
                      <td><Pill text={r.status} /></td>
                      <td className="dim">{r.reasons.join('；')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          {pauses.length > 0 && (
            <Section title={`暂停记录（${pauses.length}）`}>
              {pauses.map((p) => (
                <div key={p.id} className="pause-card">
                  <div className="li-top">
                    <span className="mono strong">{p.id}</span>
                    <Pill text={p.status} />
                  </div>
                  <div className="li-sub">{p.reason} · {p.createdBy} · {fmtDateTime(p.createdAt)}</div>
                  <div className="li-sub dim">{p.items.filter((i) => !i.restoredAt).length} 件未恢复 / 共 {p.items.length} 件</div>
                  {p.status !== 'lifted' && <button className="btn small" onClick={() => setLiftPause(p)}>按范围恢复…</button>}
                </div>
              ))}
            </Section>
          )}
        </div>

        {pauseFor && (
          <PauseModal root={inst} related={related} onClose={() => setPauseFor(false)}
            onPause={(reason, idemKey) => act(async () => {
              const r = await api<{ pause: Pause }>('POST', `/api/instruments/${inst.id}/pause-related`, { reason }, { idemKey });
              setPauseFor(false);
              toast('warn', `已暂停 ${r.pause.items.length} 件关联器械`);
            }, '已暂停')} />
        )}
        {liftPause && (
          <LiftModal pause={liftPause} trace={trace} onClose={() => setLiftPause(null)}
            onLift={(ids, idemKey) => act(async () => {
              await api('POST', `/api/pauses/${liftPause.id}/lift`, { scopeInstrumentIds: ids }, { idemKey });
              setLiftPause(null);
            }, '已按范围恢复')} />
        )}
        {checkout && (
          <CheckoutModal instrumentId={inst.id} onClose={() => setCheckout(false)}
            onCheckout={(room, idemKey) => act(async () => {
              await api('POST', `/api/instruments/${inst.id}/checkout`, { room }, { idemKey });
              setCheckout(false);
            }, '已领取')} />
        )}
      </div>
    </div>
  );
}

function PauseModal({ root, related, onClose, onPause }: {
  root: Instrument; related: TraceData['related']; onClose: () => void; onPause: (reason: string, idemKey: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [idemKey] = useState(newIdemKey); // 弹窗期间固定：双击/重试返回同一结果
  return (
    <Modal title={`一键暂停关联器械（源头：${root.code}）`} onClose={onClose} width={560}>
      <div className="banner warn">将暂停源头器械及 {related.length} 件关联器械（同批次 / 同诊室时段重叠 / 同灭菌器后续批次），已隔离的除外</div>
      <div className="pick-list">
        <div className="pick-item on"><span className="mono">{root.code}</span> {root.name} <span className="dim">（源头）</span></div>
        {related.map((r) => (
          <div key={r.instrumentId} className="pick-item">
            <span className="mono">{r.code}</span> {r.name} <Pill text={r.status} />
            <span className="dim small">{r.reasons.join('；')}</span>
          </div>
        ))}
      </div>
      <Field label="暂停原因"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="必填，例如：疑似污染事件调查" /></Field>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn danger" disabled={!reason.trim()} onClick={() => onPause(reason.trim(), idemKey)}>确认暂停全部关联器械</button>
      </div>
    </Modal>
  );
}

function LiftModal({ pause, trace, onClose, onLift }: {
  pause: Pause; trace: TraceData; onClose: () => void; onLift: (ids: string[], idemKey: string) => void;
}) {
  const open = pause.items.filter((i) => !i.restoredAt);
  const [scope, setScope] = useState<Set<string>>(new Set());
  const [idemKey] = useState(newIdemKey); // 弹窗期间固定：双击/重试返回同一结果
  const nameOf = (id: string) => {
    if (id === trace.instrument.id) return `${trace.instrument.code} ${trace.instrument.name}`;
    const r = trace.related.find((x) => x.instrumentId === id);
    return r ? `${r.code} ${r.name}` : id;
  };
  const toggle = (id: string) => setScope((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Modal title={`按范围解除暂停 ${pause.id}`} onClose={onClose}>
      <Field label={`选择要恢复的器械（已选 ${scope.size}/${open.length}）`} hint="只有勾选的器械会恢复到暂停前状态">
        <div className="pick-list">
          {open.map((it) => (
            <label key={it.instrumentId} className={`pick-item ${scope.has(it.instrumentId) ? 'on' : ''}`}>
              <input type="checkbox" checked={scope.has(it.instrumentId)} onChange={() => toggle(it.instrumentId)} />
              {nameOf(it.instrumentId)} <span className="dim">（暂停前：{it.prevStatus}）</span>
            </label>
          ))}
        </div>
      </Field>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={scope.size === 0} onClick={() => onLift([...scope], idemKey)}>恢复选中器械</button>
      </div>
    </Modal>
  );
}

function CheckoutModal({ instrumentId, onClose, onCheckout }: {
  instrumentId: string; onClose: () => void; onCheckout: (room: string, idemKey: string) => void;
}) {
  const ROOMS = ['诊室1', '诊室2', '测听室1', '测听室2', '验配室', '处置室'];
  const [room, setRoom] = useState(ROOMS[0]);
  const [idemKey] = useState(newIdemKey); // 弹窗期间固定：双击/重试返回同一结果
  return (
    <Modal title="领取器械至诊室" onClose={onClose}>
      <Field label="领取诊室">
        <select value={room} onChange={(e) => setRoom(e.target.value)}>{ROOMS.map((r) => <option key={r}>{r}</option>)}</select>
      </Field>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={() => onCheckout(room, idemKey)}>确认领取</button>
      </div>
    </Modal>
  );
}

function CreateInstrumentModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('检查器械');
  const toast = useToast();
  const onErr = useApiError();
  const submit = async () => {
    try {
      await api('POST', '/api/instruments', { code: code.trim(), name: name.trim(), category });
      toast('ok', '器械已登记');
      await onDone();
    } catch (e) { onErr(e); }
  };
  return (
    <Modal title="登记新器械" onClose={onClose}>
      <Field label="编号"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="如 EX-100" /></Field>
      <Field label="名称"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 耳镜C" /></Field>
      <Field label="类别">
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {['检查器械', '处置器械', '听力检查', '验配器械', '门诊器械'].map((c) => <option key={c}>{c}</option>)}
        </select>
      </Field>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!code.trim() || !name.trim()} onClick={submit}>登记</button>
      </div>
    </Modal>
  );
}
