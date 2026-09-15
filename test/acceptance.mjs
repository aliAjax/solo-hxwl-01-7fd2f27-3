// 端到端验收：批次放行 / 锁定隔离 / 关联追溯 / 复检恢复 / 临期提醒 / 并发与持久化。
// 运行：npm test
import { createApp } from '../server/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5199;
const DATA = path.join(os.tmpdir(), `accept-${process.pid}.json`);
fs.rmSync(DATA, { force: true });

let nowMs = Date.now(); // 可推进时钟：模拟跨日
const app = createApp({ dataFile: DATA, nowFn: () => new Date(nowMs), sweepIntervalMs: 3_600_000 });
await app.listen(PORT);

let passed = 0, failed = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
};
const section = (t) => console.log(`\n■ ${t}`);

async function api(method, p, body, { actor = '验收员', idemKey } = {}) {
  const res = await fetch(`http://localhost:${PORT}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Connection': 'close', // 每次请求独立连接，重启场景不受连接池影响
      'X-Actor': encodeURIComponent(actor),
      ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, replay: res.headers.get('idempotent-replay') === 'true' };
}
const getBatch = async (id) => (await api('GET', `/api/batches/${id}`)).json.batch;
const getInst = async (id) => (await api('GET', `/api/instruments?q=`)).json.instruments.find((i) => i.id === id);

try {
  // ---------- 1. 批次放行 + 幂等 ----------
  section('1. 批次放行（监测合格 → 放行 → 器械转无菌在库）');
  let r = await api('POST', '/api/batches/B-SEED-2/release', { expectedVersion: (await getBatch('B-SEED-2')).version }, { actor: '王芳', idemKey: 'rel-1' });
  ok(r.status === 200, 'B-SEED-2 放行成功', JSON.stringify(r.json));
  ok((await getInst('INS-004')).status === '无菌在库', '同批器械转入无菌在库');
  ok((await getInst('INS-004')).sterileUntil != null, '无菌效期已生成');

  r = await api('POST', '/api/batches/B-SEED-2/release', {}, { actor: '王芳', idemKey: 'rel-1' });
  ok(r.status === 200 && r.replay, '同一幂等键重放返回首次结果（不重复放行）');
  r = await api('POST', '/api/batches/B-SEED-2/release', {}, { actor: '李强', idemKey: 'rel-2' });
  ok(r.status === 409 && r.json.error.code === 'ALREADY_PROCESSED', '他人再次放行被拒（409 不可重复放行）');

  // ---------- 2. 并发：两人同时操作 ----------
  section('2. 并发：两人同时放行同一批次，不得重复放行');
  await api('POST', '/api/instruments', { code: 'TST-001', name: '测试器械A' }, { actor: '王芳' });
  await api('POST', '/api/instruments', { code: 'TST-002', name: '测试器械B' }, { actor: '王芳' });
  const instA = (await api('GET', '/api/instruments?q=TST-001')).json.instruments[0].id;
  const instB = (await api('GET', '/api/instruments?q=TST-002')).json.instruments[0].id;
  r = await api('POST', '/api/batches', { washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01', instrumentIds: [instA, instB] }, { actor: '王芳' });
  const bT1 = r.json.batch.id;
  await api('POST', `/api/batches/${bT1}/complete`, {}, { actor: '王芳' });
  await api('POST', `/api/batches/${bT1}/monitor`, { chemMonitor: '合格', bioMonitor: '合格' }, { actor: '李强' });

  // 王芳与李强同时点击放行（不同幂等键）
  let results = await Promise.all([
    api('POST', `/api/batches/${bT1}/release`, {}, { actor: '王芳', idemKey: 'c-a' }),
    api('POST', `/api/batches/${bT1}/release`, {}, { actor: '李强', idemKey: 'c-b' }),
  ]);
  const okCount = results.filter((x) => x.status === 200).length;
  const conflictCount = results.filter((x) => x.status === 409).length;
  ok(okCount === 1 && conflictCount === 1, `一成功一冲突（200×${okCount} / 409×${conflictCount}）`);

  // 同一操作员双击/重试（相同幂等键并发）
  await api('POST', '/api/instruments', { code: 'TST-003', name: '测试器械C' }, { actor: '王芳' });
  const instC = (await api('GET', '/api/instruments?q=TST-003')).json.instruments[0].id;
  r = await api('POST', '/api/batches', { washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-02', instrumentIds: [instC] }, { actor: '李强' });
  const bT2 = r.json.batch.id;
  await api('POST', `/api/batches/${bT2}/complete`, {}, { actor: '李强' });
  await api('POST', `/api/batches/${bT2}/monitor`, { chemMonitor: '合格', bioMonitor: '合格' }, { actor: '李强' });
  results = await Promise.all([
    api('POST', `/api/batches/${bT2}/release`, {}, { actor: '王芳', idemKey: 'same-key' }),
    api('POST', `/api/batches/${bT2}/release`, {}, { actor: '王芳', idemKey: 'same-key' }),
  ]);
  ok(results.every((x) => x.status === 200) && results.some((x) => x.replay), '双击/重试：两次都返回成功且仅执行一次');
  const auditT2 = (await api('GET', `/api/audit?entityType=batch&entityId=${bT2}`)).json.audit;
  ok(auditT2.filter((a) => a.action === '放行批次').length === 1, '审计中仅一条放行记录（未重复放行）');

  // 不覆盖记录：过期版本号被拒
  const bBefore = await getBatch(bT2);
  r = await api('POST', `/api/batches/${bT2}/monitor`, { chemMonitor: '不合格', expectedVersion: 1 }, { actor: '李强' });
  ok(r.status === 409 && r.json.error.code === 'VERSION_CONFLICT', '携带过期版本号的修改被拒（不覆盖他人记录）');
  ok((await getBatch(bT2)).version === bBefore.version, '被拒后数据未被改动');

  // ---------- 3. 监测不合格 → 锁定 + 同批自动隔离 ----------
  section('3. 生物监测不合格 → 批次锁定、同批器械自动隔离');
  r = await api('POST', '/api/batches/B-SEED-3/monitor', { bioMonitor: '不合格' }, { actor: '李强' });
  ok(r.status === 200 && r.json.batch.releaseStatus === '已锁定', 'B-SEED-3 自动锁定');
  ok((await getInst('INS-007')).status === '已隔离' && (await getInst('INS-008')).status === '已隔离', '同批器械自动隔离');
  r = await api('POST', '/api/batches/B-SEED-3/release', {}, { actor: '王芳', idemKey: 'rel-locked' });
  ok(r.status === 409, '锁定批次放行被锁死（409）');

  // ---------- 4. 关联追溯 + 一键暂停 + 按范围恢复 ----------
  section('4. 器械反查（诊室/时段/后续批次）与一键暂停关联器械');
  const trace = (await api('GET', '/api/instruments/INS-001/trace')).json;
  ok(trace.usage.some((u) => u.room === '测听室2' && u.status === '使用中'), '反查到领取诊室与使用时段');
  ok(trace.batches.some((b) => b.batchNo === 'B-SEED-1'), '反查到所在批次');
  const relatedIds = trace.related.map((x) => x.instrumentId);
  ok(relatedIds.includes('INS-012') && relatedIds.includes('INS-004'), '关联器械含同批次与后续批次器械');
  r = await api('POST', '/api/instruments/INS-001/pause-related', { reason: '患者术后感染疑似关联' }, { actor: '王芳' });
  const pause = r.json.pause;
  ok(r.status === 200 && pause.items.length === 6, `一键暂停 ${pause?.items.length} 件关联器械（含源头）`);
  ok((await getInst('INS-012')).status === '已暂停', '关联器械已暂停');
  r = await api('POST', `/api/pauses/${pause.id}/lift`, { scopeInstrumentIds: ['INS-009'] }, { actor: '王芳' });
  ok(r.status === 400 && r.json.error.code === 'OUT_OF_SCOPE', '越范围恢复被拒');
  r = await api('POST', `/api/pauses/${pause.id}/lift`, { scopeInstrumentIds: ['INS-012'] }, { actor: '王芳' });
  ok(r.status === 200 && r.json.pause.status === 'partial', '按指定范围恢复（部分解除）');
  ok((await getInst('INS-012')).status === '无菌在库', '范围内器械恢复原状态');

  // ---------- 5. 复检恢复（只能按指定范围） ----------
  section('5. 复检通过后按指定范围恢复');
  r = await api('POST', '/api/batches/B-SEED-4/rechecks', { result: '合格', scopeInstrumentIds: ['INS-013'], note: '越界测试' }, { actor: '李强' });
  ok(r.status === 400 && r.json.error.code === 'OUT_OF_SCOPE', '恢复范围超出隔离清单被拒');
  r = await api('POST', '/api/batches/B-SEED-4/rechecks', { result: '合格', scopeInstrumentIds: ['INS-009'], note: '复测合格' }, { actor: '李强' });
  ok(r.status === 200 && r.json.batch.releaseStatus === '部分恢复', '范围内恢复，批次转部分恢复');
  ok((await getInst('INS-009')).status === '无菌在库' && (await getInst('INS-010')).status === '已隔离', '仅指定器械恢复，其余继续隔离');
  r = await api('POST', '/api/batches/B-SEED-4/rechecks', { result: '合格', scopeInstrumentIds: ['INS-010'] }, { actor: '李强' });
  ok(r.json.batch.releaseStatus === '已恢复', '全部恢复后批次转已恢复');

  // ---------- 6. 分级提醒 ----------
  section('6. 校准/灭菌周期/生物监测 分级提醒');
  let alerts = (await api('GET', '/api/alerts')).json.alerts;
  const tiers = new Set(alerts.map((a) => a.tier));
  ok(tiers.has('严重') && tiers.has('警告') && tiers.has('提示'), `三级提醒齐备（${[...tiers].join('/')}）`);
  ok(alerts.some((a) => a.kind === '校准过期' && a.entityId === 'EQ-S02'), '校准过期 → 严重');
  ok(alerts.some((a) => a.kind === '校准临期' && a.entityId === 'EQ-S01' && a.tier === '警告'), '校准≤3天 → 警告');
  ok(alerts.some((a) => a.kind === '校准临期' && a.entityId === 'EQ-W02' && a.tier === '提示'), '校准≤7天 → 提示');
  ok(alerts.some((a) => a.kind === '无菌效期临期' && a.entityId === 'INS-002'), '无菌效期临期提醒');
  ok(alerts.some((a) => a.kind === '批次锁定' && a.entityId === 'B-SEED-3'), '锁定批次严重提醒');

  // ---------- 7. 领用 / 归还 ----------
  section('7. 领取诊室登记与归还');
  r = await api('POST', '/api/instruments/INS-012/checkout', { room: '诊室1', operator: '赵敏' }, { actor: '赵敏' });
  ok(r.status === 200 && r.json.instrument.status === '使用中', '无菌器械领取至诊室');
  r = await api('POST', '/api/instruments/INS-012/return', {}, { actor: '赵敏' });
  ok(r.status === 200 && r.json.instrument.status === '待处理', '归还后转入待处理');

  // ---------- 8. 交接班 ----------
  section('8. 交接班（状态汇总不丢失）');
  const handover = (await api('GET', '/api/handover')).json;
  ok(handover.lockedBatches.some((b) => b.id === 'B-SEED-3'), '交接班含锁定批次');
  ok(handover.activePauses.some((p) => p.id === pause.id), '交接班含未解除暂停');
  r = await api('POST', '/api/handover', { shift: '夜班', note: 'B-SEED-3 待复检' }, { actor: '王芳' });
  ok(r.status === 200 && r.json.handover.id, '交接班记录已生成');

  // ---------- 9. 跨日推进：自动清扫 + 校准过期锁死放行 ----------
  section('9. 跨日：生物监测超时自动锁定、校准过期锁死放行');
  // 提前建好批次 B-T3（监测合格），用于验证“校准过期后放行被锁死”
  await api('POST', '/api/instruments', { code: 'TST-004', name: '测试器械D' }, { actor: '王芳' });
  const instD = (await api('GET', '/api/instruments?q=TST-004')).json.instruments[0].id;
  r = await api('POST', '/api/batches', { washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01', instrumentIds: [instD] }, { actor: '王芳' });
  const bT3 = r.json.batch.id;
  await api('POST', `/api/batches/${bT3}/complete`, {}, { actor: '王芳' });
  await api('POST', `/api/batches/${bT3}/monitor`, { chemMonitor: '合格', bioMonitor: '合格' }, { actor: '王芳' });
  // B-T4 完成但不判读生物监测，用于验证超时自动锁定
  await api('POST', '/api/instruments', { code: 'TST-005', name: '测试器械E' }, { actor: '王芳' });
  const instE = (await api('GET', '/api/instruments?q=TST-005')).json.instruments[0].id;
  r = await api('POST', '/api/batches', { washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-02', instrumentIds: [instE] }, { actor: '李强' });
  const bT4 = r.json.batch.id;
  await api('POST', `/api/batches/${bT4}/complete`, {}, { actor: '李强' });

  nowMs += 49 * 3600 * 1000; // 跨日推进 49 小时
  await api('GET', '/api/state'); // 触发清扫
  ok((await getBatch(bT4)).releaseStatus === '已锁定', '生物监测超 48h 未判读 → 批次自动锁定');
  ok((await getInst(instE)).status === '已隔离', '超时批次器械自动隔离');
  ok((await getInst('INS-002')).status === '待处理', '无菌效期跨日过期 → 自动转待处理');
  r = await api('POST', `/api/batches/${bT3}/release`, {}, { actor: '王芳', idemKey: 'rel-t3' });
  ok(r.status === 409 && r.json.error.code === 'CALIBRATION_EXPIRED', '灭菌器校准跨日过期 → 放行锁死');
  const eqS01 = (await api('GET', '/api/equipment')).json.equipment.find((e) => e.id === 'EQ-S01');
  ok(eqS01.status === '校准过期', '设备自动标记校准过期');
  r = await api('PATCH', '/api/equipment/EQ-S01', { calibrationDue: new Date(nowMs + 30 * 864e5).toISOString(), expectedVersion: eqS01.version }, { actor: '李强' });
  ok(r.status === 200 && r.json.equipment.status === '正常', '重新校准后设备恢复正常');
  r = await api('POST', `/api/batches/${bT3}/release`, {}, { actor: '王芳', idemKey: 'rel-t3b' });
  ok(r.status === 200, '校准恢复后放行成功');

  // ---------- 10. 持久化：重启不丢状态 ----------
  section('10. 持久化：重启后状态完整保留');
  await app.close();
  const app2 = createApp({ dataFile: DATA, nowFn: () => new Date(nowMs), sweepIntervalMs: 3_600_000 });
  await app2.listen(PORT);
  const bAfter = await getBatch(bT3);
  ok(bAfter.releaseStatus === '已放行' && bAfter.releasedBy === '王芳', '放行记录跨重启保留');
  ok((await getBatch(bT4)).releaseStatus === '已锁定', '锁定状态跨重启保留');
  const pausesAfter = (await api('GET', '/api/pauses')).json.pauses;
  ok(pausesAfter.find((p) => p.id === pause.id)?.status === 'partial', '暂停部分解除状态跨重启保留');
  const handovers = (await api('GET', '/api/handover')).json;
  ok(handovers.generatedAt != null, '交接班数据跨重启可用');
  const auditAll = (await api('GET', '/api/audit?limit=500')).json.audit;
  ok(auditAll.length > 20, `审计日志完整（${auditAll.length} 条）`);

  // ---------- 11. 反例：暂停保持 ----------
  section('11. 反例：暂停中的器械不随批次完成/监测/放行而改变');
  await api('POST', '/api/instruments', { code: 'TST-101', name: '暂停保持甲' }, { actor: '王芳' });
  const instP = (await api('GET', '/api/instruments?q=TST-101')).json.instruments[0].id;
  r = await api('POST', '/api/batches', { washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01', instrumentIds: [instP] }, { actor: '王芳' });
  const bP = r.json.batch.id;
  r = await api('POST', `/api/instruments/${instP}/pause-related`, { reason: '暂停保持测试' }, { actor: '王芳' });
  const pauseP = r.json.pause;
  ok(r.status === 200 && pauseP.items.length === 1, '暂停成功（单件批次仅含自身）');
  await api('POST', `/api/batches/${bP}/complete`, {}, { actor: '王芳' });
  ok((await getInst(instP)).status === '已暂停', '批次完成灭菌周期 → 器械仍暂停');
  await api('POST', `/api/batches/${bP}/monitor`, { chemMonitor: '合格', bioMonitor: '合格' }, { actor: '李强' });
  ok((await getInst(instP)).status === '已暂停', '登记监测合格 → 器械仍暂停');
  r = await api('POST', `/api/batches/${bP}/release`, {}, { actor: '王芳', idemKey: 'rel-p' });
  ok(r.status === 200 && (await getInst(instP)).status === '已暂停', '批次放行 → 器械仍暂停');
  ok((await getBatch(bP)).releaseStatus === '已放行', '批次本身正常放行');
  r = await api('POST', `/api/pauses/${pauseP.id}/lift`, { scopeInstrumentIds: [instP] }, { actor: '王芳' });
  ok(r.status === 200 && (await getInst(instP)).status === '无菌在库', '按范围解除暂停 → 依批次已放行解析为无菌在库');
  ok((await getInst(instP)).sterileUntil != null, '恢复后继承批次无菌效期');

  // ---------- 12. 反例：已恢复批次再次锁定 → 全部重新隔离 ----------
  section('12. 反例：已恢复批次再次锁定，全部受影响器械重新隔离');
  r = await api('POST', '/api/batches/B-SEED-4/lock', { reason: '同供应商另一批次检出污染，扩大召回' }, { actor: '李强' });
  ok(r.status === 200, '已恢复批次允许再次锁定');
  ok((await getInst('INS-009')).status === '已隔离' && (await getInst('INS-010')).status === '已隔离', '曾恢复的器械重新隔离');
  const b4r = await getBatch('B-SEED-4');
  ok(b4r.releaseStatus === '已锁定' && b4r.quarantine.filter((q) => !q.restoredAt).length === 2, '隔离清单重新打开 2 条');

  // ---------- 13. 反例：设备更新校验失败回滚 ----------
  section('13. 反例：设备更新校验失败，内存与磁盘均保持原值');
  const eqBefore = (await api('GET', '/api/equipment')).json.equipment.find((e) => e.id === 'EQ-W01');
  r = await api('PATCH', '/api/equipment/EQ-W01', { calibrationDue: new Date(nowMs - 864e5).toISOString(), status: '正常', expectedVersion: eqBefore.version }, { actor: '李强' });
  ok(r.status === 409 && r.json.error.code === 'CALIBRATION_EXPIRED', '以过期校准启用设备被拒');
  const eqAfter = (await api('GET', '/api/equipment')).json.equipment.find((e) => e.id === 'EQ-W01');
  ok(eqAfter.calibrationDue === eqBefore.calibrationDue && eqAfter.status === eqBefore.status && eqAfter.version === eqBefore.version, '校验失败后内存数据保持原值');
  r = await api('PATCH', '/api/equipment/EQ-W01', { calibrationDue: 'not-a-date' }, { actor: '李强' });
  ok(r.status === 400, '非法日期被拒');
  ok((await api('GET', '/api/equipment')).json.equipment.find((e) => e.id === 'EQ-W01').version === eqBefore.version, '再次失败后版本号未变');

  // ---------- 14. 反例：生物监测超时锁死 ----------
  section('14. 反例：超过判读时限，补录合格与放行均被拒');
  await api('POST', '/api/instruments', { code: 'TST-102', name: '超时锁死乙' }, { actor: '王芳' });
  const instQ = (await api('GET', '/api/instruments?q=TST-102')).json.instruments[0].id;
  r = await api('POST', '/api/batches', { washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01', instrumentIds: [instQ] }, { actor: '王芳' });
  const bQ = r.json.batch.id;
  await api('POST', `/api/batches/${bQ}/complete`, {}, { actor: '王芳' });
  nowMs += 49 * 3600 * 1000; // 超过 48h 判读时限（先不触发清扫）
  r = await api('POST', `/api/batches/${bQ}/monitor`, { bioMonitor: '合格' }, { actor: '李强' });
  ok(r.status === 409 && r.json.error.code === 'BIO_MONITOR_OVERDUE', '超时补录合格被拒（领域守卫，不依赖定时清扫）');
  r = await api('POST', `/api/batches/${bQ}/release`, {}, { actor: '王芳', idemKey: 'rel-q' });
  ok(r.status === 400 && r.json.error.code === 'MONITOR_NOT_PASSED', '超时未判读批次放行被拒');
  await api('GET', '/api/state'); // 触发清扫
  ok((await getBatch(bQ)).releaseStatus === '已锁定', '清扫后超时批次自动锁定');
  r = await api('POST', `/api/batches/${bQ}/monitor`, { bioMonitor: '合格' }, { actor: '李强' });
  ok(r.status === 409 && r.json.error.code === 'BIO_MONITOR_OVERDUE', '锁定后补录合格仍被拒');

  // ---------- 15. 刷新/重启一致 + 幂等重放跨重启 ----------
  section('15. 刷新与重启后数据一致，幂等重放跨重启有效');
  const countsBefore = (await api('GET', '/api/state')).json.counts;
  await app2.close();
  const app3 = createApp({ dataFile: DATA, nowFn: () => new Date(nowMs), sweepIntervalMs: 3_600_000 });
  await app3.listen(PORT);
  const countsAfter = (await api('GET', '/api/state')).json.counts;
  ok(JSON.stringify(countsAfter) === JSON.stringify(countsBefore), '重启后看板计数一致');
  const eqW01 = (await api('GET', '/api/equipment')).json.equipment.find((e) => e.id === 'EQ-W01');
  ok(eqW01.calibrationDue === eqBefore.calibrationDue, '失败更新未写入磁盘（持久化保持原值）');
  await api('POST', '/api/instruments', { code: 'TST-103', name: '重放验证丙' }, { actor: '王芳' });
  const instR = (await api('GET', '/api/instruments?q=TST-103')).json.instruments[0].id;
  r = await api('POST', '/api/batches', { washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01', instrumentIds: [instR] }, { actor: '王芳' });
  const bR = r.json.batch.id;
  await api('POST', `/api/batches/${bR}/complete`, {}, { actor: '王芳' });
  await api('POST', `/api/batches/${bR}/monitor`, { chemMonitor: '合格', bioMonitor: '合格' }, { actor: '王芳' });
  r = await api('POST', `/api/batches/${bR}/release`, {}, { actor: '王芳', idemKey: 'persist-key' });
  ok(r.status === 200, '新批次放行成功');
  await app3.close();
  const app4 = createApp({ dataFile: DATA, nowFn: () => new Date(nowMs), sweepIntervalMs: 3_600_000 });
  await app4.listen(PORT);
  r = await api('POST', `/api/batches/${bR}/release`, {}, { actor: '李强', idemKey: 'persist-key' });
  ok(r.status === 200 && r.replay, '重启后同一幂等键返回首次结果（不重复放行）');
  const auditR = (await api('GET', `/api/audit?entityType=batch&entityId=${bR}`)).json.audit;
  ok(auditR.filter((a) => a.action === '放行批次').length === 1, '审计仍仅一条放行记录');
  await app4.close();
} catch (e) {
  failed++;
  console.error('验收执行异常：', e);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
fs.rmSync(DATA, { force: true });
process.exit(failed ? 1 : 0);
