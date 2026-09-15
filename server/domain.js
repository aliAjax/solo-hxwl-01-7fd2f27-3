// 领域逻辑：所有函数都在 Store.transact 内同步执行（读函数除外）。
// 并发安全三件套：
//   1) transact 串行化 —— 两人同时提交不会交错执行；
//   2) 状态机守卫 —— 如放行仅允许从「待放行」迁移，第二个请求得到 409；
//   3) expectedVersion 乐观锁 + Idempotency-Key —— 不覆盖他人记录、不重放放行。

export class DomainError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const STERILE_DAYS = 7;        // 灭菌后无菌效期
export const BIO_MONITOR_HOURS = 48;  // 生物监测判读时限
export const CAL_WARN_DAYS = 3;       // 校准 ≤3 天 → 警告
export const CAL_NOTICE_DAYS = 7;     // 校准 ≤7 天 → 提示
export const STERILE_WARN_DAYS = 2;   // 无菌效期 ≤2 天 → 警告
export const STERILE_NOTICE_DAYS = 4; // 无菌效期 ≤4 天 → 提示

const H = 3600 * 1000;
const D = 24 * H;
export const iso = (d) => new Date(d).toISOString();
export const addHours = (d, h) => new Date(new Date(d).getTime() + h * H).toISOString();
export const addDays = (d, n) => addHours(d, n * 24);
const ymd = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
};

function mustFind(list, id, label = '记录') {
  const x = list.find((i) => i.id === id);
  if (!x) throw new DomainError(404, 'NOT_FOUND', `${label}不存在：${id}`);
  return x;
}

function expectVersion(entity, expectedVersion) {
  if (expectedVersion == null) return;
  if (entity.version !== expectedVersion) {
    throw new DomainError(409, 'VERSION_CONFLICT',
      `数据已被他人修改（你看到的是版本 ${expectedVersion}，当前版本 ${entity.version}），请刷新后重试`);
  }
}

function nextId(state, key, prefix, pad = 3) {
  state.seq[key] = (state.seq[key] || 0) + 1;
  return `${prefix}-${String(state.seq[key]).padStart(pad, '0')}`;
}

export function audit(state, now, actor, action, entityType, entityId, detail) {
  state.audit.push({
    id: nextId(state, 'audit', 'A', 5),
    ts: iso(now), actor, action, entityType, entityId, detail,
  });
  if (state.audit.length > 5000) state.audit.splice(0, state.audit.length - 5000);
}

// ---------- 设备 ----------

export function updateEquipment(state, now, { equipmentId, actor, calibrationDue, status, expectedVersion }) {
  const eq = mustFind(state.equipment, equipmentId, '设备');
  expectVersion(eq, expectedVersion);
  const changes = [];
  if (calibrationDue != null) {
    if (Number.isNaN(new Date(calibrationDue).getTime())) throw new DomainError(400, 'BAD_DATE', '校准有效期格式不正确');
    changes.push(`校准有效期 ${eq.calibrationDue} → ${calibrationDue}`);
    eq.calibrationDue = calibrationDue;
    if (new Date(calibrationDue).getTime() > now.getTime() && eq.status === '校准过期') {
      eq.status = '正常';
      changes.push('状态恢复为正常');
    }
  }
  if (status != null) {
    if (!['正常', '停用'].includes(status)) throw new DomainError(400, 'BAD_STATUS', '设备状态仅支持 正常/停用（校准过期由系统自动标记）');
    if (status === '正常' && new Date(eq.calibrationDue).getTime() <= now.getTime()) {
      throw new DomainError(409, 'CALIBRATION_EXPIRED', '校准已过期，须先更新校准有效期才能启用');
    }
    changes.push(`状态 ${eq.status} → ${status}`);
    eq.status = status;
  }
  if (!changes.length) throw new DomainError(400, 'NO_CHANGE', '没有需要修改的内容');
  eq.version += 1;
  eq.updatedAt = iso(now);
  audit(state, now, actor, '更新设备', 'equipment', eq.id, `${eq.name}：${changes.join('；')}`);
  return { equipment: eq };
}

// ---------- 批次生命周期 ----------

export function createBatch(state, now, { actor, washerId, sterilizerId, operatorId, instrumentIds }) {
  const washer = mustFind(state.equipment, washerId, '清洗设备');
  const sterilizer = mustFind(state.equipment, sterilizerId, '灭菌设备');
  mustFind(state.operators, operatorId, '操作员');
  if (!Array.isArray(instrumentIds) || instrumentIds.length === 0) {
    throw new DomainError(400, 'EMPTY_ITEMS', '批次至少需要一件器械');
  }
  for (const eq of [washer, sterilizer]) {
    if (eq.status !== '正常') throw new DomainError(409, 'EQUIPMENT_NOT_READY', `${eq.name} 当前状态为「${eq.status}」，不能用于新批次`);
    if (new Date(eq.calibrationDue).getTime() <= now.getTime()) {
      throw new DomainError(409, 'CALIBRATION_EXPIRED', `${eq.name} 校准已过期（${eq.calibrationDue}），不能用于新批次`);
    }
  }
  const items = instrumentIds.map((id) => mustFind(state.instruments, id, '器械'));
  for (const inst of items) {
    if (inst.status !== '待处理') {
      throw new DomainError(409, 'INSTRUMENT_BUSY', `器械 ${inst.code} ${inst.name} 当前状态为「${inst.status}」，仅「待处理」可入批次`);
    }
  }
  state.seq.batch = (state.seq.batch || 0) + 1;
  const batchNo = `B${ymd(now)}-${String(state.seq.batch).padStart(2, '0')}`;
  const batch = {
    id: batchNo, batchNo,
    washerId, sterilizerId, operatorId,
    items: items.map((i) => i.id),
    createdAt: iso(now), createdBy: actor,
    completedAt: null, completedBy: null,
    chemMonitor: '未做', bioMonitor: '未做',
    bioMonitorDueAt: null, monitorUpdatedAt: null, monitorBy: null,
    releaseStatus: '处理中',
    releasedAt: null, releasedBy: null, releaseIdemKey: null,
    lockReason: null, lockedAt: null, lockedBy: null,
    quarantine: [], rechecks: [],
    version: 1, updatedAt: iso(now),
  };
  state.batches.push(batch);
  for (const inst of items) {
    inst.status = '处理中';
    inst.version += 1;
    inst.updatedAt = iso(now);
  }
  audit(state, now, actor, '创建批次', 'batch', batch.id,
    `批次 ${batchNo}：${washer.name} + ${sterilizer.name}，${items.length} 件器械（${items.map((i) => i.code).join('、')}）`);
  return { batch };
}

export function completeBatch(state, now, { batchId, actor, expectedVersion }) {
  const b = mustFind(state.batches, batchId, '批次');
  expectVersion(b, expectedVersion);
  if (b.releaseStatus !== '处理中') throw new DomainError(409, 'BAD_STATE', `仅「处理中」批次可完成灭菌周期（当前：${b.releaseStatus}）`);
  for (const eqId of [b.washerId, b.sterilizerId]) {
    const eq = mustFind(state.equipment, eqId, '设备');
    if (eq.status !== '正常' || new Date(eq.calibrationDue).getTime() <= now.getTime()) {
      throw new DomainError(409, 'CALIBRATION_EXPIRED', `${eq.name} 校准已过期或停用，本次灭菌周期无效，请锁定该批次并安排重新处理`);
    }
  }
  b.completedAt = iso(now);
  b.completedBy = actor;
  b.bioMonitorDueAt = addHours(now, BIO_MONITOR_HOURS);
  b.releaseStatus = '待放行';
  b.version += 1;
  b.updatedAt = iso(now);
  for (const id of b.items) {
    const inst = mustFind(state.instruments, id);
    inst.status = '待放行';
    inst.version += 1;
    inst.updatedAt = iso(now);
  }
  audit(state, now, actor, '完成灭菌周期', 'batch', b.id,
    `批次 ${b.batchNo} 灭菌周期完成，生物监测判读时限 ${b.bioMonitorDueAt}`);
  return { batch: b };
}

export function recordMonitor(state, now, { batchId, actor, chemMonitor, bioMonitor, expectedVersion }) {
  const b = mustFind(state.batches, batchId, '批次');
  expectVersion(b, expectedVersion);
  if (b.releaseStatus === '已放行' || b.releaseStatus === '已恢复') {
    throw new DomainError(409, 'ALREADY_RELEASED', '批次已放行，监测记录不可更改（不得覆盖记录）');
  }
  if (!b.completedAt) throw new DomainError(400, 'NOT_COMPLETED', '灭菌周期未完成，不能登记监测结果');
  for (const [k, v] of [['化学监测', chemMonitor], ['生物监测', bioMonitor]]) {
    if (v != null && !['合格', '不合格'].includes(v)) throw new DomainError(400, 'BAD_VALUE', `${k}结果仅支持 合格/不合格`);
  }
  if (chemMonitor) b.chemMonitor = chemMonitor;
  if (bioMonitor) b.bioMonitor = bioMonitor;
  b.monitorUpdatedAt = iso(now);
  b.monitorBy = actor;
  b.version += 1;
  b.updatedAt = iso(now);
  audit(state, now, actor, '登记监测结果', 'batch', b.id,
    `批次 ${b.batchNo}：化学监测=${b.chemMonitor}，生物监测=${b.bioMonitor}`);
  if (b.chemMonitor === '不合格' || b.bioMonitor === '不合格') {
    lockBatchInternal(state, now, b, actor, `监测不合格（化学:${b.chemMonitor}，生物:${b.bioMonitor}）`);
  }
  return { batch: b };
}

export function releaseBatch(state, now, { batchId, actor, idemKey, expectedVersion }) {
  // 幂等：同一 Idempotency-Key 重试/双击/刷新重发，直接返回首次结果，绝不重复放行
  if (idemKey && state.idempotency[idemKey]) {
    const hit = state.idempotency[idemKey];
    return { ...hit.body, _replay: true };
  }
  const b = mustFind(state.batches, batchId, '批次');
  if (b.releaseStatus !== '待放行') {
    const why = b.releaseStatus === '已放行'
      ? `已由 ${b.releasedBy} 于 ${b.releasedAt} 放行`
      : b.releaseStatus === '已锁定' || b.releaseStatus === '部分恢复'
        ? `已锁定（${b.lockReason}）`
        : `当前状态为「${b.releaseStatus}」`;
    throw new DomainError(409, 'ALREADY_PROCESSED', `该批次不可重复放行：${why}`);
  }
  expectVersion(b, expectedVersion);
  if (!b.completedAt) throw new DomainError(400, 'NOT_COMPLETED', '灭菌周期未完成，不能放行');
  if (b.chemMonitor !== '合格' || b.bioMonitor !== '合格') {
    throw new DomainError(400, 'MONITOR_NOT_PASSED',
      `监测未全部合格（化学:${b.chemMonitor}，生物:${b.bioMonitor}），禁止放行`);
  }
  for (const eqId of [b.washerId, b.sterilizerId]) {
    const eq = mustFind(state.equipment, eqId, '设备');
    if (eq.status !== '正常' || new Date(eq.calibrationDue).getTime() <= now.getTime()) {
      throw new DomainError(409, 'CALIBRATION_EXPIRED', `${eq.name} 校准已过期或停用，放行已锁死，请先完成校准`);
    }
  }
  const sterileUntil = addDays(b.completedAt, STERILE_DAYS);
  b.releaseStatus = '已放行';
  b.releasedAt = iso(now);
  b.releasedBy = actor;
  b.releaseIdemKey = idemKey || null;
  b.version += 1;
  b.updatedAt = iso(now);
  for (const id of b.items) {
    const inst = mustFind(state.instruments, id);
    inst.status = '无菌在库';
    inst.sterileUntil = sterileUntil;
    inst.version += 1;
    inst.updatedAt = iso(now);
  }
  audit(state, now, actor, '放行批次', 'batch', b.id,
    `批次 ${b.batchNo} 放行，${b.items.length} 件器械转入无菌在库，无菌效期至 ${sterileUntil}`);
  const body = { batch: b, sterileUntil };
  if (idemKey) {
    state.idempotency[idemKey] = { body, createdAt: iso(now) };
    gcIdempotency(state, now);
  }
  return body;
}

function lockBatchInternal(state, now, b, actor, reason) {
  if (b.releaseStatus === '已锁定') return;
  const from = b.releaseStatus;
  b.releaseStatus = '已锁定';
  b.lockReason = reason;
  b.lockedAt = iso(now);
  b.lockedBy = actor;
  b.version += 1;
  b.updatedAt = iso(now);
  const quarantinedIds = new Set(b.quarantine.map((q) => q.instrumentId));
  for (const id of b.items) {
    const inst = mustFind(state.instruments, id);
    if (quarantinedIds.has(id) || inst.status === '已隔离') continue;
    b.quarantine.push({ instrumentId: id, prevStatus: inst.status, restoredAt: null });
    inst.status = '已隔离';
    inst.sterileUntil = null;
    inst.version += 1;
    inst.updatedAt = iso(now);
    for (const u of state.usage) {
      if (u.instrumentId === id && u.status === '使用中') {
        u.alert = `关联批次 ${b.batchNo} 已锁定：${reason}，请立即召回`;
      }
    }
  }
  audit(state, now, actor, '锁定批次', 'batch', b.id,
    `批次 ${b.batchNo} 由「${from}」锁定：${reason}；同批 ${b.items.length} 件器械已自动隔离`);
}

export function lockBatch(state, now, { batchId, actor, reason, expectedVersion }) {
  const b = mustFind(state.batches, batchId, '批次');
  expectVersion(b, expectedVersion);
  if (!reason) throw new DomainError(400, 'NO_REASON', '必须填写锁定原因');
  if (['已放行', '已恢复'].includes(b.releaseStatus)) {
    // 已放行批次发现异常同样允许锁定召回（器械可能已在使用中，usage 会被标记召回）
    lockBatchInternal(state, now, b, actor, reason);
    return { batch: b };
  }
  if (b.releaseStatus === '已锁定') throw new DomainError(409, 'ALREADY_LOCKED', `批次已锁定（${b.lockReason}）`);
  lockBatchInternal(state, now, b, actor, reason);
  return { batch: b };
}

export function recheckBatch(state, now, { batchId, actor, result, scopeInstrumentIds, note, expectedVersion }) {
  const b = mustFind(state.batches, batchId, '批次');
  expectVersion(b, expectedVersion);
  if (!['已锁定', '部分恢复'].includes(b.releaseStatus)) {
    throw new DomainError(409, 'NOT_LOCKED', `仅锁定批次可复检（当前：${b.releaseStatus}）`);
  }
  if (!['合格', '不合格'].includes(result)) throw new DomainError(400, 'BAD_VALUE', '复检结果仅支持 合格/不合格');
  if (!Array.isArray(scopeInstrumentIds) || scopeInstrumentIds.length === 0) {
    throw new DomainError(400, 'EMPTY_SCOPE', '必须指定恢复范围（至少一件隔离器械）');
  }
  const open = b.quarantine.filter((q) => !q.restoredAt);
  const openIds = new Set(open.map((q) => q.instrumentId));
  for (const id of scopeInstrumentIds) {
    if (!openIds.has(id)) {
      throw new DomainError(400, 'OUT_OF_SCOPE', `器械 ${id} 不在本批次待恢复隔离范围内，复检恢复不得越界`);
    }
  }
  const recheck = {
    id: nextId(state, 'recheck', 'RC'),
    batchId, result, scopeInstrumentIds, note: note || '',
    createdAt: iso(now), createdBy: actor,
  };
  state.rechecks.push(recheck);
  b.rechecks.push(recheck.id);
  if (result === '合格') {
    const sterileUntil = b.completedAt ? addDays(b.completedAt, STERILE_DAYS) : null;
    for (const id of scopeInstrumentIds) {
      const q = open.find((x) => x.instrumentId === id);
      q.restoredAt = iso(now);
      const inst = mustFind(state.instruments, id);
      if (sterileUntil && new Date(sterileUntil).getTime() > now.getTime()) {
        inst.status = '无菌在库';
        inst.sterileUntil = sterileUntil;
      } else {
        inst.status = '待处理'; // 无菌效期已过，需重新处理
        inst.sterileUntil = null;
      }
      inst.version += 1;
      inst.updatedAt = iso(now);
    }
    const remaining = b.quarantine.some((q) => !q.restoredAt);
    b.releaseStatus = remaining ? '部分恢复' : '已恢复';
    audit(state, now, actor, '复检恢复', 'batch', b.id,
      `批次 ${b.batchNo} 复检合格，按指定范围恢复 ${scopeInstrumentIds.length} 件（${scopeInstrumentIds.join('、')}）${remaining ? '，其余继续隔离' : '，全部恢复'}${note ? `；备注：${note}` : ''}`);
  } else {
    audit(state, now, actor, '复检不合格', 'batch', b.id,
      `批次 ${b.batchNo} 复检不合格，维持锁定，器械继续隔离${note ? `；备注：${note}` : ''}`);
  }
  b.version += 1;
  b.updatedAt = iso(now);
  return { batch: b, recheck };
}

// ---------- 器械领用 ----------

export function createInstrument(state, now, { actor, code, name, category }) {
  if (!code || !name) throw new DomainError(400, 'BAD_INPUT', '器械编号与名称必填');
  if (state.instruments.some((i) => i.code === code)) {
    throw new DomainError(409, 'DUP_CODE', `器械编号已存在：${code}`);
  }
  const inst = {
    id: nextId(state, 'instrument', 'INS'),
    code, name, category: category || '门诊器械',
    status: '待处理', sterileUntil: null, location: '消毒供应室',
    version: 1, updatedAt: iso(now),
  };
  state.instruments.push(inst);
  audit(state, now, actor, '登记器械', 'instrument', inst.id, `${code} ${name} 登记入库，待处理`);
  return { instrument: inst };
}

export function checkoutInstrument(state, now, { instrumentId, room, operator, actor }) {
  const inst = mustFind(state.instruments, instrumentId, '器械');
  if (!room) throw new DomainError(400, 'NO_ROOM', '必须选择领取诊室');
  if (inst.status !== '无菌在库') {
    throw new DomainError(409, 'NOT_STERILE', `仅「无菌在库」器械可领取（当前：${inst.status}）`);
  }
  if (inst.sterileUntil && new Date(inst.sterileUntil).getTime() <= now.getTime()) {
    throw new DomainError(409, 'STERILE_EXPIRED', '无菌效期已过，需重新处理后才能领取');
  }
  inst.status = '使用中';
  inst.location = room;
  inst.version += 1;
  inst.updatedAt = iso(now);
  const usage = {
    id: nextId(state, 'usage', 'U'),
    instrumentId, room, operator: operator || actor,
    startAt: iso(now), endAt: null, status: '使用中', alert: null,
  };
  state.usage.push(usage);
  audit(state, now, actor, '领取器械', 'instrument', inst.id,
    `${inst.code} ${inst.name} 由 ${usage.operator} 领取至 ${room}`);
  return { instrument: inst, usage };
}

export function returnInstrument(state, now, { instrumentId, actor, expectedVersion }) {
  const inst = mustFind(state.instruments, instrumentId, '器械');
  expectVersion(inst, expectedVersion);
  const open = state.usage.find((u) => u.instrumentId === instrumentId && u.endAt == null);
  if (!open) throw new DomainError(409, 'NOT_IN_USE', '该器械没有未归还的领用记录');
  open.endAt = iso(now);
  open.status = '已归还';
  inst.status = '待处理';
  inst.sterileUntil = null;
  inst.location = '消毒供应室';
  inst.version += 1;
  inst.updatedAt = iso(now);
  audit(state, now, actor, '归还器械', 'instrument', inst.id,
    `${inst.code} ${inst.name} 自 ${open.room} 归还，转入待处理`);
  return { instrument: inst, usage: open };
}

// ---------- 关联追溯与一键暂停 ----------

const overlap = (aStart, aEnd, bStart, bEnd) => {
  const a0 = new Date(aStart).getTime();
  const a1 = aEnd ? new Date(aEnd).getTime() : Number.MAX_SAFE_INTEGER;
  const b0 = new Date(bStart).getTime();
  const b1 = bEnd ? new Date(bEnd).getTime() : Number.MAX_SAFE_INTEGER;
  return a0 <= b1 && b0 <= a1;
};

export function computeRelated(state, rootId) {
  const related = new Map(); // id -> Set(原因)
  const add = (id, reason) => {
    if (id === rootId) return;
    if (!related.has(id)) related.set(id, new Set());
    related.get(id).add(reason);
  };
  // 1) 同批次器械
  const rootBatches = state.batches.filter((b) => b.items.includes(rootId));
  for (const b of rootBatches) {
    for (const item of b.items) add(item, `同批次 ${b.batchNo}`);
  }
  // 2) 同诊室且使用时段重叠
  for (const ru of state.usage.filter((u) => u.instrumentId === rootId)) {
    for (const u of state.usage) {
      if (u.instrumentId === rootId || u.room !== ru.room) continue;
      if (overlap(ru.startAt, ru.endAt, u.startAt, u.endAt)) {
        add(u.instrumentId, `同诊室 ${u.room} 时段重叠`);
      }
    }
  }
  // 3) 同灭菌器 24h 内的后续批次
  for (const rb of rootBatches) {
    if (!rb.completedAt) continue;
    const t0 = new Date(rb.completedAt).getTime();
    for (const b of state.batches) {
      if (b.id === rb.id || b.sterilizerId !== rb.sterilizerId || !b.completedAt) continue;
      const dt = new Date(b.completedAt).getTime() - t0;
      if (dt > 0 && dt <= 24 * H) {
        for (const item of b.items) add(item, `同灭菌器后续批次 ${b.batchNo}`);
      }
    }
  }
  return [...related.entries()].map(([instrumentId, reasons]) => ({
    instrumentId,
    reasons: [...reasons],
  }));
}

export function traceInstrument(state, instrumentId) {
  const inst = mustFind(state.instruments, instrumentId, '器械');
  const eqName = (id) => (state.equipment.find((e) => e.id === id) || {}).name || id;
  const opName = (id) => (state.operators.find((o) => o.id === id) || {}).name || id;
  const batches = state.batches
    .filter((b) => b.items.includes(instrumentId))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map((b) => ({
      ...b,
      washerName: eqName(b.washerId),
      sterilizerName: eqName(b.sterilizerId),
      operatorName: opName(b.operatorId),
    }));
  const usage = state.usage
    .filter((u) => u.instrumentId === instrumentId)
    .sort((a, b) => (a.startAt < b.startAt ? 1 : -1));
  const pauses = state.pauses.filter((p) => p.items.some((i) => i.instrumentId === instrumentId));
  const related = computeRelated(state, instrumentId).map((r) => {
    const target = state.instruments.find((i) => i.id === r.instrumentId);
    return { ...r, code: target?.code, name: target?.name, status: target?.status };
  });
  return { instrument: inst, batches, usage, pauses, related };
}

export function pauseRelated(state, now, { rootInstrumentId, reason, actor }) {
  const root = mustFind(state.instruments, rootInstrumentId, '器械');
  if (!reason) throw new DomainError(400, 'NO_REASON', '必须填写暂停原因');
  const related = computeRelated(state, rootInstrumentId);
  const pausable = new Set(['待处理', '处理中', '待放行', '无菌在库', '使用中']);
  const items = [];
  for (const id of [rootInstrumentId, ...related.map((r) => r.instrumentId)]) {
    const inst = mustFind(state.instruments, id);
    if (!pausable.has(inst.status)) continue; // 已隔离/已暂停的不重复处理
    items.push({ instrumentId: id, prevStatus: inst.status, restoredAt: null });
  }
  if (!items.length) throw new DomainError(409, 'NOTHING_TO_PAUSE', '没有可暂停的关联器械（均已隔离或暂停）');
  const pause = {
    id: nextId(state, 'pause', 'PS'),
    rootInstrumentId, reason,
    createdAt: iso(now), createdBy: actor,
    status: 'active',
    items,
    relations: related,
  };
  state.pauses.push(pause);
  for (const it of items) {
    const inst = mustFind(state.instruments, it.instrumentId);
    inst.status = '已暂停';
    inst.version += 1;
    inst.updatedAt = iso(now);
    for (const u of state.usage) {
      if (u.instrumentId === inst.id && u.status === '使用中') u.status = '已暂停';
    }
  }
  audit(state, now, actor, '一键暂停关联器械', 'pause', pause.id,
    `因「${reason}」暂停 ${items.length} 件关联器械（源头：${root.code} ${root.name}）`);
  return { pause };
}

export function liftPause(state, now, { pauseId, scopeInstrumentIds, actor }) {
  const p = mustFind(state.pauses, pauseId, '暂停记录');
  if (p.status === 'lifted') throw new DomainError(409, 'ALREADY_LIFTED', '该暂停已全部解除');
  if (!Array.isArray(scopeInstrumentIds) || scopeInstrumentIds.length === 0) {
    throw new DomainError(400, 'EMPTY_SCOPE', '必须按指定范围恢复（至少选择一件器械）');
  }
  const open = p.items.filter((i) => !i.restoredAt);
  const openIds = new Set(open.map((i) => i.instrumentId));
  for (const id of scopeInstrumentIds) {
    if (!openIds.has(id)) throw new DomainError(400, 'OUT_OF_SCOPE', `器械 ${id} 不在本次暂停的可恢复范围内`);
  }
  for (const id of scopeInstrumentIds) {
    const item = open.find((i) => i.instrumentId === id);
    item.restoredAt = iso(now);
    const inst = mustFind(state.instruments, id);
    if (inst.status === '已暂停') {
      inst.status = item.prevStatus;
      inst.version += 1;
      inst.updatedAt = iso(now);
      for (const u of state.usage) {
        if (u.instrumentId === id && u.status === '已暂停') u.status = '使用中';
      }
    }
  }
  p.status = p.items.every((i) => i.restoredAt) ? 'lifted' : 'partial';
  audit(state, now, actor, '按范围解除暂停', 'pause', p.id,
    `暂停 ${p.id} 按指定范围恢复 ${scopeInstrumentIds.length} 件（${scopeInstrumentIds.join('、')}），状态：${p.status === 'lifted' ? '全部解除' : '部分解除'}`);
  return { pause: p };
}

// ---------- 分级提醒 / 跨日清扫 ----------

export function computeAlerts(state, now) {
  const alerts = [];
  const t = now.getTime();
  for (const eq of state.equipment) {
    if (eq.status === '停用') continue;
    const days = (new Date(eq.calibrationDue).getTime() - t) / D;
    if (days < 0) {
      alerts.push({ tier: '严重', kind: '校准过期', entityType: 'equipment', entityId: eq.id, dueAt: eq.calibrationDue,
        title: `${eq.name} 校准已过期`, detail: `校准有效期至 ${eq.calibrationDue}，超期 ${Math.ceil(-days)} 天；相关批次放行已锁死` });
    } else if (days <= CAL_WARN_DAYS) {
      alerts.push({ tier: '警告', kind: '校准临期', entityType: 'equipment', entityId: eq.id, dueAt: eq.calibrationDue,
        title: `${eq.name} 校准即将到期`, detail: `剩余 ${Math.max(1, Math.ceil(days))} 天（${eq.calibrationDue}），请安排校准` });
    } else if (days <= CAL_NOTICE_DAYS) {
      alerts.push({ tier: '提示', kind: '校准临期', entityType: 'equipment', entityId: eq.id, dueAt: eq.calibrationDue,
        title: `${eq.name} 校准临近`, detail: `剩余 ${Math.ceil(days)} 天（${eq.calibrationDue}）` });
    }
  }
  for (const b of state.batches) {
    if (b.releaseStatus === '待放行' && b.bioMonitor === '未做' && b.bioMonitorDueAt) {
      const leftH = (new Date(b.bioMonitorDueAt).getTime() - t) / H;
      if (leftH < 0) {
        alerts.push({ tier: '严重', kind: '生物监测超时', entityType: 'batch', entityId: b.id, dueAt: b.bioMonitorDueAt,
          title: `批次 ${b.batchNo} 生物监测超时未判读`, detail: `判读时限 ${b.bioMonitorDueAt} 已过，批次已自动锁定` });
      } else if (leftH <= 12) {
        alerts.push({ tier: '警告', kind: '生物监测临期', entityType: 'batch', entityId: b.id, dueAt: b.bioMonitorDueAt,
          title: `批次 ${b.batchNo} 生物监测待判读`, detail: `剩余 ${Math.ceil(leftH)} 小时（时限 ${b.bioMonitorDueAt}）` });
      } else if (leftH <= 24) {
        alerts.push({ tier: '提示', kind: '生物监测临期', entityType: 'batch', entityId: b.id, dueAt: b.bioMonitorDueAt,
          title: `批次 ${b.batchNo} 生物监测待判读`, detail: `剩余 ${Math.ceil(leftH)} 小时` });
      }
    }
    if (b.releaseStatus === '已锁定' || b.releaseStatus === '部分恢复') {
      alerts.push({ tier: '严重', kind: '批次锁定', entityType: 'batch', entityId: b.id, dueAt: b.lockedAt,
        title: `批次 ${b.batchNo} 已锁定`, detail: `${b.lockReason}；同批器械已隔离，待复检` });
    }
  }
  for (const inst of state.instruments) {
    if (inst.status === '无菌在库' && inst.sterileUntil) {
      const days = (new Date(inst.sterileUntil).getTime() - t) / D;
      if (days < 0) {
        alerts.push({ tier: '严重', kind: '无菌效期过期', entityType: 'instrument', entityId: inst.id, dueAt: inst.sterileUntil,
          title: `${inst.code} ${inst.name} 无菌效期已过`, detail: `效期至 ${inst.sterileUntil}，需重新处理` });
      } else if (days <= STERILE_WARN_DAYS) {
        alerts.push({ tier: '警告', kind: '无菌效期临期', entityType: 'instrument', entityId: inst.id, dueAt: inst.sterileUntil,
          title: `${inst.code} ${inst.name} 无菌效期将至`, detail: `剩余 ${Math.max(1, Math.ceil(days))} 天（${inst.sterileUntil}）` });
      } else if (days <= STERILE_NOTICE_DAYS) {
        alerts.push({ tier: '提示', kind: '无菌效期临期', entityType: 'instrument', entityId: inst.id, dueAt: inst.sterileUntil,
          title: `${inst.code} ${inst.name} 无菌效期临近`, detail: `剩余 ${Math.ceil(days)} 天` });
      }
    }
  }
  for (const p of state.pauses) {
    if (p.status === 'lifted') continue;
    const openCount = p.items.filter((i) => !i.restoredAt).length;
    alerts.push({ tier: '警告', kind: '暂停中', entityType: 'pause', entityId: p.id, dueAt: p.createdAt,
      title: `关联暂停 ${p.id}（${openCount} 件待恢复）`, detail: p.reason });
  }
  const rank = { 严重: 0, 警告: 1, 提示: 2 };
  alerts.sort((a, b) => rank[a.tier] - rank[b.tier] || (a.dueAt < b.dueAt ? -1 : 1));
  return alerts;
}

// 跨日/重启后的状态清扫：校准过期标记、生物监测超时锁定、无菌效期过期回收。
// 服务器启动时与每分钟运行一次，保证隔夜状态不丢、时限自动生效。
export function sweep(state, now) {
  const t = now.getTime();
  for (const eq of state.equipment) {
    if (eq.status === '正常' && new Date(eq.calibrationDue).getTime() <= t) {
      eq.status = '校准过期';
      eq.version += 1;
      eq.updatedAt = iso(now);
      audit(state, now, '系统自动', '设备校准过期', 'equipment', eq.id,
        `${eq.name} 校准有效期至 ${eq.calibrationDue}，已自动标记「校准过期」，相关批次放行锁死`);
    }
  }
  for (const b of state.batches) {
    if (b.releaseStatus === '待放行' && b.bioMonitor === '未做' && b.bioMonitorDueAt
        && new Date(b.bioMonitorDueAt).getTime() <= t) {
      lockBatchInternal(state, now, b, '系统自动', '生物监测超时未判读（超过 48 小时时限）');
    }
  }
  for (const inst of state.instruments) {
    if (inst.status === '无菌在库' && inst.sterileUntil && new Date(inst.sterileUntil).getTime() <= t) {
      inst.status = '待处理';
      inst.sterileUntil = null;
      inst.version += 1;
      inst.updatedAt = iso(now);
      audit(state, now, '系统自动', '无菌效期过期', 'instrument', inst.id,
        `${inst.code} ${inst.name} 无菌效期已过，自动转入待处理`);
    }
  }
}

// ---------- 总览 / 交接班 ----------

export function dashboard(state, now) {
  const alerts = computeAlerts(state, now);
  return {
    now: iso(now),
    counts: {
      pendingRelease: state.batches.filter((b) => b.releaseStatus === '待放行').length,
      processing: state.batches.filter((b) => b.releaseStatus === '处理中').length,
      lockedBatches: state.batches.filter((b) => ['已锁定', '部分恢复'].includes(b.releaseStatus)).length,
      quarantined: state.instruments.filter((i) => i.status === '已隔离').length,
      paused: state.instruments.filter((i) => i.status === '已暂停').length,
      sterile: state.instruments.filter((i) => i.status === '无菌在库').length,
      inUse: state.instruments.filter((i) => i.status === '使用中').length,
      severeAlerts: alerts.filter((a) => a.tier === '严重').length,
    },
    alerts,
    recentAudit: state.audit.slice(-8).reverse(),
  };
}

export function handoverSummary(state, now) {
  const since = new Date(now.getTime() - 24 * H).toISOString();
  const instBrief = (id) => {
    const i = state.instruments.find((x) => x.id === id);
    return i ? { id: i.id, code: i.code, name: i.name, status: i.status } : { id };
  };
  return {
    generatedAt: iso(now),
    pendingRelease: state.batches.filter((b) => b.releaseStatus === '待放行')
      .map((b) => ({ id: b.id, batchNo: b.batchNo, items: b.items.length, chemMonitor: b.chemMonitor, bioMonitor: b.bioMonitor, bioMonitorDueAt: b.bioMonitorDueAt })),
    lockedBatches: state.batches.filter((b) => ['已锁定', '部分恢复'].includes(b.releaseStatus))
      .map((b) => ({ id: b.id, batchNo: b.batchNo, releaseStatus: b.releaseStatus, lockReason: b.lockReason, lockedAt: b.lockedAt, unrestored: b.quarantine.filter((q) => !q.restoredAt).length })),
    activePauses: state.pauses.filter((p) => p.status !== 'lifted')
      .map((p) => ({ id: p.id, reason: p.reason, createdAt: p.createdAt, createdBy: p.createdBy, status: p.status, openItems: p.items.filter((i) => !i.restoredAt).map((i) => instBrief(i.instrumentId)) })),
    openUsage: state.usage.filter((u) => u.endAt == null)
      .map((u) => ({ ...u, instrument: instBrief(u.instrumentId) })),
    quarantined: state.instruments.filter((i) => i.status === '已隔离').map((i) => instBrief(i.id)),
    alerts: computeAlerts(state, now),
    recentEvents: state.audit.filter((a) => a.ts >= since).slice().reverse(),
  };
}

export function recordHandover(state, now, { actor, shift, note }) {
  if (!shift) throw new DomainError(400, 'NO_SHIFT', '必须选择交接班次');
  const summary = handoverSummary(state, now);
  const record = {
    id: nextId(state, 'handover', 'HO'),
    ts: iso(now), operator: actor, shift, note: note || '',
    summary: {
      pendingRelease: summary.pendingRelease.length,
      lockedBatches: summary.lockedBatches.length,
      activePauses: summary.activePauses.length,
      openUsage: summary.openUsage.length,
      quarantined: summary.quarantined.length,
      severeAlerts: summary.alerts.filter((a) => a.tier === '严重').length,
    },
  };
  state.handovers.push(record);
  audit(state, now, actor, '交接班确认', 'handover', record.id,
    `${shift}交接：待放行 ${record.summary.pendingRelease} 批、锁定 ${record.summary.lockedBatches} 批、活跃暂停 ${record.summary.activePauses} 项、未归还 ${record.summary.openUsage} 件、隔离 ${record.summary.quarantined} 件${note ? `；备注：${note}` : ''}`);
  return { handover: record, summary };
}

function gcIdempotency(state, now) {
  const cutoff = now.getTime() - 24 * H;
  for (const [k, v] of Object.entries(state.idempotency)) {
    if (new Date(v.createdAt).getTime() < cutoff) delete state.idempotency[k];
  }
}
