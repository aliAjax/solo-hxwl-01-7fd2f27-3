// API 客户端：统一错误、操作员身份头、幂等键。
export type Tier = '严重' | '警告' | '提示';

export interface AlertItem {
  tier: Tier; kind: string; entityType: string; entityId: string;
  dueAt?: string | null; title: string; detail: string;
}
export interface Equipment {
  id: string; code: string; name: string; type: 'washer' | 'sterilizer';
  calibrationDue: string; status: string; version: number; updatedAt: string;
}
export interface Instrument {
  id: string; code: string; name: string; category: string; status: string;
  sterileUntil: string | null; location: string; version: number; updatedAt: string;
}
export interface Batch {
  id: string; batchNo: string; washerId: string; sterilizerId: string; operatorId: string;
  items: string[]; createdAt: string; createdBy: string;
  completedAt: string | null; completedBy: string | null;
  chemMonitor: string; bioMonitor: string; bioMonitorDueAt: string | null;
  monitorUpdatedAt: string | null; monitorBy: string | null;
  releaseStatus: string; releasedAt: string | null; releasedBy: string | null;
  lockReason: string | null; lockedAt: string | null; lockedBy: string | null;
  quarantine: { instrumentId: string; prevStatus: string; restoredAt: string | null }[];
  rechecks: string[]; version: number; updatedAt: string;
  washerName?: string; sterilizerName?: string; operatorName?: string;
  itemDetails?: { id: string; code: string; name: string; status: string }[];
  recheckDetails?: Recheck[];
}
export interface Recheck {
  id: string; batchId: string; result: string; scopeInstrumentIds: string[];
  note: string; createdAt: string; createdBy: string;
}
export interface Usage {
  id: string; instrumentId: string; room: string; operator: string;
  startAt: string; endAt: string | null; status: string; alert: string | null;
  instrument?: { id: string; code: string; name: string; status: string };
}
export interface Pause {
  id: string; rootInstrumentId: string; reason: string; createdAt: string; createdBy: string;
  status: 'active' | 'partial' | 'lifted';
  items: { instrumentId: string; prevStatus: string; restoredAt: string | null }[];
  relations: { instrumentId: string; reasons: string[] }[];
}
export interface AuditEntry {
  id: string; ts: string; actor: string; action: string;
  entityType: string; entityId: string; detail: string;
}
export interface DashboardData {
  now: string;
  counts: Record<string, number>;
  alerts: AlertItem[];
  recentAudit: AuditEntry[];
}
export interface TraceData {
  instrument: Instrument;
  batches: Batch[];
  usage: Usage[];
  pauses: Pause[];
  related: { instrumentId: string; code: string; name: string; status: string; reasons: string[] }[];
}
export interface HandoverData {
  generatedAt: string;
  pendingRelease: Batch[];
  lockedBatches: Batch[];
  activePauses: (Pause & { openCount?: number })[];
  openUsage: Usage[];
  quarantined: Instrument[];
  alerts: AlertItem[];
  recentEvents: AuditEntry[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

let actor = localStorage.getItem('actor') || '王芳';
export const getActor = () => actor;
export const setActor = (a: string) => { actor = a; localStorage.setItem('actor', a); };

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { idemKey?: string } = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Actor': encodeURIComponent(actor),
      ...(opts.idemKey ? { 'Idempotency-Key': opts.idemKey } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error || {};
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `请求失败（${res.status}）`);
  }
  return json as T;
}

export const newIdemKey = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const fmtTime = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fmtDateTime = (s?: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const remainText = (due?: string | null) => {
  if (!due) return '';
  const ms = new Date(due).getTime() - Date.now();
  const abs = Math.abs(ms);
  const txt = abs >= 864e5 ? `${Math.floor(abs / 864e5)}天${Math.floor((abs % 864e5) / 36e5)}时` : `${Math.floor(abs / 36e5)}时${Math.floor((abs % 36e5) / 6e4)}分`;
  return ms >= 0 ? `剩余 ${txt}` : `已超 ${txt}`;
};
