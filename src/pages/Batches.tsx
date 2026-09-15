import React, { useEffect, useMemo, useState } from 'react';
import { api, newIdemKey, fmtDateTime, fmtTime, remainText, Batch, Equipment, Instrument } from '../api';
import { Pill, Modal, Field, Empty, Section, useToast, useApiError } from '../ui';

interface Operator { id: string; name: string; role: string; shift: string }

export function Batches({ focusId, onFocusConsumed }: { focusId?: string | null; onFocusConsumed?: () => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [selected, setSelected] = useState<Batch | null>(null);
  const [filter, setFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [releaseFor, setReleaseFor] = useState<Batch | null>(null);
  const [lockFor, setLockFor] = useState<Batch | null>(null);
  const [recheckFor, setRecheckFor] = useState<Batch | null>(null);
  const toast = useToast();
  const onErr = useApiError(() => refresh());

  const refresh = async () => {
    const [b, e, o, i] = await Promise.all([
      api<{ batches: Batch[] }>('GET', '/api/batches'),
      api<{ equipment: Equipment[] }>('GET', '/api/equipment'),
      api<{ operators: Operator[] }>('GET', '/api/operators'),
      api<{ instruments: Instrument[] }>('GET', '/api/instruments'),
    ]);
    setBatches(b.batches); setEquipment(e.equipment); setOperators(o.operators); setInstruments(i.instruments);
    if (selected) {
      const cur = b.batches.find((x) => x.id === selected.id);
      setSelected(cur ? await api<{ batch: Batch }>('GET', `/api/batches/${cur.id}`).then((r) => r.batch) : null);
    }
  };
  useEffect(() => { refresh().catch(() => {}); const t = setInterval(() => refresh().catch(() => {}), 15000); return () => clearInterval(t); }, [selected?.id]);

  useEffect(() => {
    if (!focusId) return;
    api<{ batch: Batch }>('GET', `/api/batches/${focusId}`).then((r) => setSelected(r.batch)).catch(() => {});
    onFocusConsumed?.();
  }, [focusId]);

  const openDetail = async (b: Batch) => {
    const r = await api<{ batch: Batch }>('GET', `/api/batches/${b.id}`);
    setSelected(r.batch);
  };

  const act = async (fn: () => Promise<any>, okMsg: string) => {
    try { await fn(); toast('ok', okMsg); await refresh(); }
    catch (e) { onErr(e); }
  };

  const list = useMemo(() => filter ? batches.filter((b) => b.releaseStatus === filter) : batches, [batches, filter]);
  const FILTERS = ['', '处理中', '待放行', '已放行', '已锁定', '部分恢复', '已恢复'];

  return (
    <div className="page split">
      <div className="col-list">
        <div className="list-head">
          <div className="chips">
            {FILTERS.map((f) => (
              <button key={f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>{f || '全部'}</button>
            ))}
          </div>
          <button className="btn primary" onClick={() => setShowCreate(true)}>+ 新建批次</button>
        </div>
        {list.length === 0 ? <Empty text="暂无批次" /> : list.map((b) => (
          <div key={b.id} className={`list-item ${selected?.id === b.id ? 'on' : ''}`} onClick={() => openDetail(b)}>
            <div className="li-top">
              <span className="mono strong">{b.batchNo}</span>
              <Pill text={b.releaseStatus} />
            </div>
            <div className="li-sub">{b.sterilizerName} · {b.operatorName} · {b.items.length} 件</div>
            <div className="li-sub dim">
              化学 <Pill text={b.chemMonitor} /> 生物 <Pill text={b.bioMonitor} />
              {b.bioMonitor === '未做' && b.bioMonitorDueAt && <span className="warn-text"> · 判读{remainText(b.bioMonitorDueAt)}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="col-detail">
        {!selected ? <Empty text="选择左侧批次查看详情" /> : (
          <BatchDetail
            batch={selected}
            equipment={equipment}
            onComplete={() => act(() => api('POST', `/api/batches/${selected.id}/complete`, { expectedVersion: selected.version }), '灭菌周期已完成，进入待放行')}
            onRelease={() => setReleaseFor(selected)}
            onLock={() => setLockFor(selected)}
            onRecheck={() => setRecheckFor(selected)}
            onMonitor={(chem, bio) => act(() => api('POST', `/api/batches/${selected.id}/monitor`, { chemMonitor: chem, bioMonitor: bio, expectedVersion: selected.version }), '监测结果已登记')}
          />
        )}
      </div>

      {showCreate && (
        <CreateBatchModal
          equipment={equipment} operators={operators}
          candidates={instruments.filter((i) => i.status === '待处理')}
          onClose={() => setShowCreate(false)}
          onCreate={(payload) => act(async () => {
            const r = await api<{ batch: Batch }>('POST', '/api/batches', payload);
            setShowCreate(false);
            setSelected(r.batch);
          }, '批次已创建')}
        />
      )}
      {releaseFor && (
        <ReleaseModal
          batch={releaseFor} equipment={equipment}
          onClose={() => setReleaseFor(null)}
          onDone={async () => { setReleaseFor(null); await refresh(); }}
        />
      )}
      {lockFor && (
        <LockModal batch={lockFor} onClose={() => setLockFor(null)}
          onLock={(reason, idemKey) => act(async () => {
            await api('POST', `/api/batches/${lockFor.id}/lock`, { reason, expectedVersion: lockFor.version }, { idemKey });
            setLockFor(null);
          }, '批次已锁定，同批器械已隔离')} />
      )}
      {recheckFor && (
        <RecheckModal batch={recheckFor} instruments={instruments} onClose={() => setRecheckFor(null)}
          onRecheck={(payload, idemKey) => act(async () => {
            await api('POST', `/api/batches/${recheckFor.id}/rechecks`, { ...payload, expectedVersion: recheckFor.version }, { idemKey });
            setRecheckFor(null);
          }, '复检结果已登记')} />
      )}
    </div>
  );
}

function BatchDetail({ batch: b, equipment, onComplete, onRelease, onLock, onRecheck, onMonitor }: {
  batch: Batch; equipment: Equipment[];
  onComplete: () => void; onRelease: () => void; onLock: () => void;
  onRecheck: () => void; onMonitor: (chem?: string, bio?: string) => void;
}) {
  const [chem, setChem] = useState('');
  const [bio, setBio] = useState('');
  useEffect(() => { setChem(''); setBio(''); }, [b.id, b.version]);
  const eqOf = (id: string) => equipment.find((e) => e.id === id);
  const canEditMonitor = b.completedAt && !['已放行', '已恢复'].includes(b.releaseStatus);
  const quarantinedLeft = b.quarantine.filter((q) => !q.restoredAt);

  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <span className="mono strong xl">{b.batchNo}</span>{' '}
          <Pill text={b.releaseStatus} />
        </div>
        <div className="btn-row">
          {b.releaseStatus === '处理中' && <button className="btn primary" onClick={onComplete}>完成灭菌周期</button>}
          {b.releaseStatus === '待放行' && <button className="btn success" onClick={onRelease}>放行</button>}
          {(b.releaseStatus === '已锁定' || b.releaseStatus === '部分恢复') && quarantinedLeft.length > 0 &&
            <button className="btn primary" onClick={onRecheck}>登记复检</button>}
          {!['已放行', '已恢复', '已锁定'].includes(b.releaseStatus) && <button className="btn danger" onClick={onLock}>锁定</button>}
          {b.releaseStatus === '已放行' && <button className="btn danger" onClick={onLock}>异常锁定召回</button>}
        </div>
      </div>

      {b.lockReason && (
        <div className="banner danger">🔒 {b.lockReason}（{b.lockedBy} · {fmtDateTime(b.lockedAt)}）</div>
      )}
      {b.releaseStatus === '已放行' && (
        <div className="banner ok">✓ 已由 {b.releasedBy} 于 {fmtDateTime(b.releasedAt)} 放行</div>
      )}

      <div className="info-grid">
        <Info label="清洗设备" value={`${b.washerName}`} sub={eqOf(b.washerId) && <Pill text={eqOf(b.washerId)!.status} />} />
        <Info label="灭菌设备" value={`${b.sterilizerName}`} sub={eqOf(b.sterilizerId) && <Pill text={eqOf(b.sterilizerId)!.status} />} />
        <Info label="操作员" value={b.operatorName || b.operatorId} />
        <Info label="创建" value={`${b.createdBy} · ${fmtDateTime(b.createdAt)}`} />
        <Info label="周期完成" value={b.completedAt ? `${b.completedBy} · ${fmtDateTime(b.completedAt)}` : '未完成'} />
        <Info label="生物监测判读时限" value={b.bioMonitorDueAt ? fmtDateTime(b.bioMonitorDueAt) : '—'}
          sub={b.bioMonitor === '未做' && b.bioMonitorDueAt ? <span className="warn-text">{remainText(b.bioMonitorDueAt)}</span> : undefined} />
      </div>

      <Section title="监测结果">
        <div className="monitor-row">
          <span>化学监测 <Pill text={b.chemMonitor} /></span>
          <span>生物监测 <Pill text={b.bioMonitor} /></span>
          {b.monitorBy && <span className="dim">登记：{b.monitorBy} · {fmtDateTime(b.monitorUpdatedAt)}</span>}
        </div>
        {canEditMonitor && (
          <div className="monitor-form">
            <select value={chem} onChange={(e) => setChem(e.target.value)}>
              <option value="">化学监测…</option><option>合格</option><option>不合格</option>
            </select>
            <select value={bio} onChange={(e) => setBio(e.target.value)}>
              <option value="">生物监测…</option><option>合格</option><option>不合格</option>
            </select>
            <button className="btn" disabled={!chem && !bio}
              onClick={() => onMonitor(chem || undefined, bio || undefined)}>登记监测</button>
            <span className="field-hint">登记「不合格」将自动锁定批次并隔离同批器械</span>
          </div>
        )}
      </Section>

      <Section title={`批次器械（${b.items.length}）`}>
        <table className="table">
          <thead><tr><th>编号</th><th>名称</th><th>当前状态</th><th>隔离/恢复</th></tr></thead>
          <tbody>
            {b.itemDetails?.map((it) => {
              const q = b.quarantine.find((x) => x.instrumentId === it.id);
              return (
                <tr key={it.id}>
                  <td className="mono">{it.code}</td>
                  <td>{it.name}</td>
                  <td><Pill text={it.status} /></td>
                  <td className="dim">{q ? (q.restoredAt ? `已恢复 ${fmtTime(q.restoredAt)}` : `隔离中（原：${q.prevStatus}）`) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      {(b.recheckDetails?.length ?? 0) > 0 && (
        <Section title={`复检记录（${b.recheckDetails!.length}）`}>
          <table className="table">
            <thead><tr><th>时间</th><th>结果</th><th>恢复范围</th><th>操作人</th><th>备注</th></tr></thead>
            <tbody>
              {b.recheckDetails!.map((r) => (
                <tr key={r.id}>
                  <td className="mono nowrap">{fmtTime(r.createdAt)}</td>
                  <td><Pill text={r.result} /></td>
                  <td>{r.scopeInstrumentIds.join('、')}</td>
                  <td>{r.createdBy}</td>
                  <td>{r.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </div>
  );
}

function Info({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="info">
      <div className="info-label">{label}</div>
      <div className="info-value">{value} {sub}</div>
    </div>
  );
}

function CreateBatchModal({ equipment, operators, candidates, onClose, onCreate }: {
  equipment: Equipment[]; operators: Operator[];
  candidates: Instrument[]; onClose: () => void;
  onCreate: (p: { washerId: string; sterilizerId: string; operatorId: string; instrumentIds: string[] }) => void;
}) {
  const ready = equipment.filter((e) => e.status === '正常' && new Date(e.calibrationDue).getTime() > Date.now());
  const washers = ready.filter((e) => e.type === 'washer');
  const sters = ready.filter((e) => e.type === 'sterilizer');
  const [washerId, setWasherId] = useState(washers[0]?.id || '');
  const [sterilizerId, setSterilizerId] = useState(sters[0]?.id || '');
  const [operatorId, setOperatorId] = useState(operators[0]?.id || '');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Modal title="新建消毒批次" onClose={onClose} width={560}>
      <div className="form-grid">
        <Field label="清洗设备"><select value={washerId} onChange={(e) => setWasherId(e.target.value)}>
          {washers.map((e) => <option key={e.id} value={e.id}>{e.name}（校准至 {e.calibrationDue.slice(0, 10)}）</option>)}
        </select></Field>
        <Field label="灭菌设备"><select value={sterilizerId} onChange={(e) => setSterilizerId(e.target.value)}>
          {sters.map((e) => <option key={e.id} value={e.id}>{e.name}（校准至 {e.calibrationDue.slice(0, 10)}）</option>)}
        </select></Field>
        <Field label="操作员"><select value={operatorId} onChange={(e) => setOperatorId(e.target.value)}>
          {operators.map((o) => <option key={o.id} value={o.id}>{o.name}（{o.shift}）</option>)}
        </select></Field>
      </div>
      {ready.length < equipment.length && <div className="banner warn">部分设备因校准过期/停用不可选</div>}
      <Field label={`选择待处理器械（已选 ${picked.size}）`}>
        <div className="pick-list">
          {candidates.length === 0 && <Empty text="没有待处理器械" />}
          {candidates.map((i) => (
            <label key={i.id} className={`pick-item ${picked.has(i.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
              <span className="mono">{i.code}</span> {i.name}
            </label>
          ))}
        </div>
      </Field>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={!washerId || !sterilizerId || !operatorId || picked.size === 0}
          onClick={() => onCreate({ washerId, sterilizerId, operatorId, instrumentIds: [...picked] })}>创建批次</button>
      </div>
    </Modal>
  );
}

function ReleaseModal({ batch, equipment, onClose, onDone }: {
  batch: Batch; equipment: Equipment[]; onClose: () => void; onDone: () => void;
}) {
  // 幂等键在弹窗打开时生成一次：双击/重试/刷新重发都安全
  const [idemKey] = useState(newIdemKey);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const onErr = useApiError(onDone);
  const eqs = equipment.filter((e) => e.id === batch.washerId || e.id === batch.sterilizerId);
  const checks: [boolean, string][] = [
    [!!batch.completedAt, '灭菌周期已完成'],
    [batch.chemMonitor === '合格', `化学监测合格（当前：${batch.chemMonitor}）`],
    [batch.bioMonitor === '合格', `生物监测合格（当前：${batch.bioMonitor}）`],
    ...eqs.map((e): [boolean, string] => [e.status === '正常' && new Date(e.calibrationDue).getTime() > Date.now(),
      `${e.name} 校准有效（${e.calibrationDue.slice(0, 10)}）`]),
  ];
  const allOk = checks.every(([ok]) => ok);
  const doRelease = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api('POST', `/api/batches/${batch.id}/release`, { expectedVersion: batch.version }, { idemKey });
      toast('ok', `批次 ${batch.batchNo} 已放行`);
      onDone();
    } catch (e) { onErr(e); setBusy(false); }
  };
  return (
    <Modal title={`放行批次 ${batch.batchNo}`} onClose={onClose}>
      <div className="check-list">
        {checks.map(([ok, text], i) => (
          <div key={i} className={`check-item ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '✗'} {text}</div>
        ))}
      </div>
      {!allOk && <div className="banner danger">存在不满足的放行条件，服务器将拒绝放行</div>}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn success" disabled={!allOk || busy} onClick={doRelease}>
          {busy ? '放行中…' : '确认放行'}
        </button>
      </div>
    </Modal>
  );
}

function LockModal({ batch, onClose, onLock }: { batch: Batch; onClose: () => void; onLock: (reason: string, idemKey: string) => void }) {
  const [reason, setReason] = useState('');
  const [idemKey] = useState(newIdemKey);
  return (
    <Modal title={`锁定批次 ${batch.batchNo}`} onClose={onClose}>
      <div className="banner warn">锁定后同批 {batch.items.length} 件器械将自动隔离（含曾恢复的器械，将重新隔离），使用中的会被标记召回</div>
      <Field label="锁定原因" hint="例如：生物监测不合格 / 设备故障 / 疑似污染">
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="必填" />
      </Field>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn danger" disabled={!reason.trim()} onClick={() => onLock(reason.trim(), idemKey)}>确认锁定并隔离</button>
      </div>
    </Modal>
  );
}

function RecheckModal({ batch, instruments, onClose, onRecheck }: {
  batch: Batch; instruments: Instrument[]; onClose: () => void;
  onRecheck: (p: { result: string; scopeInstrumentIds: string[]; note: string }, idemKey: string) => void;
}) {
  const open = batch.quarantine.filter((q) => !q.restoredAt);
  const [result, setResult] = useState('合格');
  const [scope, setScope] = useState<Set<string>>(new Set(open.map((q) => q.instrumentId)));
  const [note, setNote] = useState('');
  const [idemKey] = useState(newIdemKey); // 弹窗期间固定：双击/重试不重复提交
  const nameOf = (id: string) => {
    const i = instruments.find((x) => x.id === id);
    return i ? `${i.code} ${i.name}` : id;
  };
  const toggle = (id: string) => setScope((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Modal title={`复检批次 ${batch.batchNo}`} onClose={onClose}>
      <Field label="复检结果">
        <div className="chips">
          {['合格', '不合格'].map((r) => <button key={r} className={`chip ${result === r ? 'on' : ''}`} onClick={() => setResult(r)}>{r}</button>)}
        </div>
      </Field>
      <Field label={`恢复范围（仅可勾选隔离中的器械，已选 ${scope.size}/${open.length}）`}
        hint="复检合格时，只有勾选范围内的器械会恢复；范围外保持隔离">
        <div className="pick-list">
          {open.map((q) => (
            <label key={q.instrumentId} className={`pick-item ${scope.has(q.instrumentId) ? 'on' : ''}`}>
              <input type="checkbox" checked={scope.has(q.instrumentId)} onChange={() => toggle(q.instrumentId)} />
              {nameOf(q.instrumentId)} <span className="dim">（原状态：{q.prevStatus}）</span>
            </label>
          ))}
        </div>
      </Field>
      <Field label="备注"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="复检说明（可选）" /></Field>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={scope.size === 0}
          onClick={() => onRecheck({ result, scopeInstrumentIds: [...scope], note }, idemKey)}>提交复检</button>
      </div>
    </Modal>
  );
}
