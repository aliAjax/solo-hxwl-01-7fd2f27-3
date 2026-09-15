import React, { useEffect, useState } from 'react';
import { api, fmtDateTime, remainText, Equipment } from '../api';
import { Pill, Modal, Field, useToast, useApiError } from '../ui';

export function EquipmentPage() {
  const [list, setList] = useState<Equipment[]>([]);
  const [edit, setEdit] = useState<Equipment | null>(null);
  const toast = useToast();
  const onErr = useApiError(() => refresh());

  const refresh = async () => setList((await api<{ equipment: Equipment[] }>('GET', '/api/equipment')).equipment);
  useEffect(() => { refresh().catch(() => {}); const t = setInterval(() => refresh().catch(() => {}), 20000); return () => clearInterval(t); }, []);

  const toggleDisable = async (eq: Equipment) => {
    try {
      await api('PATCH', `/api/equipment/${eq.id}`, {
        status: eq.status === '停用' ? '正常' : '停用',
        expectedVersion: eq.version,
      });
      toast('ok', eq.status === '停用' ? '设备已启用' : '设备已停用');
      await refresh();
    } catch (e) { onErr(e); }
  };

  return (
    <div className="page">
      <div className="equip-grid">
        {list.map((eq) => {
          const overdue = eq.status !== '停用' && new Date(eq.calibrationDue).getTime() <= Date.now();
          return (
            <div key={eq.id} className={`equip-card ${overdue ? 'bad' : ''}`}>
              <div className="li-top">
                <div>
                  <div className="strong">{eq.name}</div>
                  <div className="dim small">{eq.code} · {eq.type === 'washer' ? '清洗设备' : '灭菌设备'}</div>
                </div>
                <Pill text={eq.status} />
              </div>
              <div className="equip-cal">
                <span>校准有效期至</span>
                <span className="mono strong">{fmtDateTime(eq.calibrationDue).slice(0, 10)}</span>
                <span className={overdue ? 'bad-text' : 'warn-text'}>{remainText(eq.calibrationDue)}</span>
              </div>
              <div className="btn-row">
                <button className="btn small" onClick={() => setEdit(eq)}>登记校准</button>
                <button className="btn small" onClick={() => toggleDisable(eq)}>{eq.status === '停用' ? '启用' : '停用'}</button>
              </div>
            </div>
          );
        })}
      </div>
      {edit && (
        <CalibrateModal eq={edit} onClose={() => setEdit(null)}
          onDone={async () => { setEdit(null); await refresh(); }} />
      )}
    </div>
  );
}

function CalibrateModal({ eq, onClose, onDone }: { eq: Equipment; onClose: () => void; onDone: () => Promise<void> }) {
  const [date, setDate] = useState(eq.calibrationDue.slice(0, 10));
  const toast = useToast();
  const onErr = useApiError(onDone);
  const submit = async () => {
    try {
      await api('PATCH', `/api/equipment/${eq.id}`, {
        calibrationDue: new Date(`${date}T23:59:59`).toISOString(),
        expectedVersion: eq.version,
      });
      toast('ok', '校准有效期已更新');
      await onDone();
    } catch (e) { onErr(e); }
  };
  return (
    <Modal title={`登记校准 · ${eq.name}`} onClose={onClose}>
      <Field label="新校准有效期至" hint="更新后若原已过期，设备自动恢复正常">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit}>保存</button>
      </div>
    </Modal>
  );
}
