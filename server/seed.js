// 演示种子数据：日期均相对启动时刻计算，保证各类分级提醒开箱可见。
import { audit, addHours, addDays, iso } from './domain.js';

const at = (now, offsetHours) => new Date(now.getTime() + offsetHours * 3600 * 1000).toISOString();

export function seed(now = new Date()) {
  const state = {
    meta: { version: 1, createdAt: iso(now) },
    seq: { batch: 6, instrument: 13, usage: 2, audit: 0, pause: 0, recheck: 0, handover: 0 },
    operators: [
      { id: 'OP-01', name: '王芳', role: '消毒供应专员', shift: '白班' },
      { id: 'OP-02', name: '李强', role: '消毒供应专员', shift: '夜班' },
      { id: 'OP-03', name: '赵敏', role: '门诊护士', shift: '白班' },
    ],
    equipment: [
      { id: 'EQ-W01', code: 'W-01', name: '超声波清洗消毒机', type: 'washer', calibrationDue: at(now, 20 * 24), status: '正常', version: 1, updatedAt: iso(now) },
      { id: 'EQ-W02', code: 'W-02', name: '全自动清洗机', type: 'washer', calibrationDue: at(now, 5 * 24), status: '正常', version: 1, updatedAt: iso(now) },
      { id: 'EQ-S01', code: 'S-01', name: '压力蒸汽灭菌器', type: 'sterilizer', calibrationDue: at(now, 2 * 24), status: '正常', version: 1, updatedAt: iso(now) },
      { id: 'EQ-S02', code: 'S-02', name: '低温等离子灭菌器', type: 'sterilizer', calibrationDue: at(now, -26), status: '正常', version: 1, updatedAt: iso(now) },
    ],
    instruments: [
      { id: 'INS-001', code: 'EX-001', name: '耳镜A', category: '检查器械', status: '使用中', sterileUntil: null, location: '测听室2', version: 3, updatedAt: iso(now) },
      { id: 'INS-002', code: 'EX-002', name: '耳镜B', category: '检查器械', status: '无菌在库', sterileUntil: at(now, 26), location: '消毒供应室', version: 2, updatedAt: iso(now) },
      { id: 'INS-003', code: 'TF-101', name: '音叉组', category: '听力检查', status: '处理中', sterileUntil: null, location: '消毒供应室', version: 4, updatedAt: iso(now) },
      { id: 'INS-004', code: 'CU-201', name: '耵聍钩', category: '处置器械', status: '待放行', sterileUntil: null, location: '消毒供应室', version: 2, updatedAt: iso(now) },
      { id: 'INS-005', code: 'PR-202', name: '耳道探针', category: '处置器械', status: '待放行', sterileUntil: null, location: '消毒供应室', version: 2, updatedAt: iso(now) },
      { id: 'INS-006', code: 'IR-203', name: '耳道冲洗器', category: '处置器械', status: '待放行', sterileUntil: null, location: '消毒供应室', version: 2, updatedAt: iso(now) },
      { id: 'INS-007', code: 'AU-301', name: '听力计探头', category: '听力检查', status: '待放行', sterileUntil: null, location: '消毒供应室', version: 2, updatedAt: iso(now) },
      { id: 'INS-008', code: 'IM-302', name: '耳模取样器', category: '验配器械', status: '待放行', sterileUntil: null, location: '消毒供应室', version: 2, updatedAt: iso(now) },
      { id: 'INS-009', code: 'NS-401', name: '鼻窥器', category: '检查器械', status: '已隔离', sterileUntil: null, location: '隔离柜', version: 3, updatedAt: iso(now) },
      { id: 'INS-010', code: 'TY-402', name: '声导抗探头', category: '听力检查', status: '已隔离', sterileUntil: null, location: '隔离柜', version: 3, updatedAt: iso(now) },
      { id: 'INS-011', code: 'EN-501', name: '耳内窥镜', category: '检查器械', status: '处理中', sterileUntil: null, location: '消毒供应室', version: 2, updatedAt: iso(now) },
      { id: 'INS-012', code: 'FO-601', name: '镊子', category: '处置器械', status: '无菌在库', sterileUntil: at(now, 6 * 24), location: '消毒供应室', version: 2, updatedAt: iso(now) },
      { id: 'INS-013', code: 'PN-701', name: '鼓气耳镜', category: '检查器械', status: '待处理', sterileUntil: null, location: '消毒供应室', version: 1, updatedAt: iso(now) },
    ],
    batches: [
      {
        id: 'B-SEED-0', batchNo: 'B-SEED-0', washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01',
        items: ['INS-002'],
        createdAt: at(now, -6 * 24 - 2), createdBy: '王芳',
        completedAt: at(now, -6 * 24 - 1), completedBy: '王芳',
        chemMonitor: '合格', bioMonitor: '合格',
        bioMonitorDueAt: at(now, -4 * 24 - 1), monitorUpdatedAt: at(now, -6 * 24 + 3), monitorBy: '王芳', bioMonitorAt: at(now, -6 * 24 + 3),
        releaseStatus: '已放行', releasedAt: at(now, -6 * 24 + 3), releasedBy: '王芳', releaseIdemKey: null,
        lockReason: null, lockedAt: null, lockedBy: null, quarantine: [], rechecks: [],
        version: 4, updatedAt: at(now, -6 * 24 + 3),
      },
      {
        id: 'B-SEED-1', batchNo: 'B-SEED-1', washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01',
        items: ['INS-001', 'INS-003', 'INS-012'],
        createdAt: at(now, -26), createdBy: '王芳',
        completedAt: at(now, -25), completedBy: '王芳',
        chemMonitor: '合格', bioMonitor: '合格',
        bioMonitorDueAt: at(now, -25 + 48), monitorUpdatedAt: at(now, -23), monitorBy: '王芳', bioMonitorAt: at(now, -23),
        releaseStatus: '已放行', releasedAt: at(now, -23), releasedBy: '王芳', releaseIdemKey: null,
        lockReason: null, lockedAt: null, lockedBy: null, quarantine: [], rechecks: [],
        version: 4, updatedAt: at(now, -23),
      },
      {
        id: 'B-SEED-2', batchNo: 'B-SEED-2', washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01',
        items: ['INS-004', 'INS-005', 'INS-006'],
        createdAt: at(now, -3), createdBy: '王芳',
        completedAt: at(now, -2), completedBy: '王芳',
        chemMonitor: '合格', bioMonitor: '合格',
        bioMonitorDueAt: at(now, -2 + 48), monitorUpdatedAt: at(now, -1), monitorBy: '李强', bioMonitorAt: at(now, -1),
        releaseStatus: '待放行', releasedAt: null, releasedBy: null, releaseIdemKey: null,
        lockReason: null, lockedAt: null, lockedBy: null, quarantine: [], rechecks: [],
        version: 3, updatedAt: at(now, -1),
      },
      {
        id: 'B-SEED-3', batchNo: 'B-SEED-3', washerId: 'EQ-W02', sterilizerId: 'EQ-S01', operatorId: 'OP-02',
        items: ['INS-007', 'INS-008'],
        createdAt: at(now, -41), createdBy: '李强',
        completedAt: at(now, -40), completedBy: '李强',
        chemMonitor: '合格', bioMonitor: '未做',
        bioMonitorDueAt: at(now, -40 + 48), monitorUpdatedAt: at(now, -39), monitorBy: '李强', bioMonitorAt: null,
        releaseStatus: '待放行', releasedAt: null, releasedBy: null, releaseIdemKey: null,
        lockReason: null, lockedAt: null, lockedBy: null, quarantine: [], rechecks: [],
        version: 3, updatedAt: at(now, -39),
      },
      {
        id: 'B-SEED-4', batchNo: 'B-SEED-4', washerId: 'EQ-W01', sterilizerId: 'EQ-S02', operatorId: 'OP-02',
        items: ['INS-009', 'INS-010'],
        createdAt: at(now, -3 * 24), createdBy: '李强',
        completedAt: at(now, -3 * 24 + 1), completedBy: '李强',
        chemMonitor: '合格', bioMonitor: '不合格',
        bioMonitorDueAt: at(now, -3 * 24 + 49), monitorUpdatedAt: at(now, -2 * 24), monitorBy: '李强', bioMonitorAt: at(now, -2 * 24),
        releaseStatus: '已锁定', releasedAt: null, releasedBy: null, releaseIdemKey: null,
        lockReason: '监测不合格（化学:合格，生物:不合格）', lockedAt: at(now, -2 * 24), lockedBy: '李强',
        quarantine: [
          { instrumentId: 'INS-009', prevStatus: '待放行', restoredAt: null },
          { instrumentId: 'INS-010', prevStatus: '待放行', restoredAt: null },
        ],
        rechecks: [],
        version: 4, updatedAt: at(now, -2 * 24),
      },
      {
        id: 'B-SEED-5', batchNo: 'B-SEED-5', washerId: 'EQ-W01', sterilizerId: 'EQ-S01', operatorId: 'OP-01',
        items: ['INS-011', 'INS-003'],
        createdAt: at(now, -2), createdBy: '王芳',
        completedAt: null, completedBy: null,
        chemMonitor: '未做', bioMonitor: '未做',
        bioMonitorDueAt: null, monitorUpdatedAt: null, monitorBy: null, bioMonitorAt: null,
        releaseStatus: '处理中', releasedAt: null, releasedBy: null, releaseIdemKey: null,
        lockReason: null, lockedAt: null, lockedBy: null, quarantine: [], rechecks: [],
        version: 1, updatedAt: at(now, -2),
      },
    ],
    usage: [
      { id: 'U-001', instrumentId: 'INS-001', room: '测听室2', operator: '赵敏', startAt: at(now, -1), endAt: null, status: '使用中', alert: null },
      { id: 'U-002', instrumentId: 'INS-003', room: '诊室1', operator: '赵敏', startAt: at(now, -25), endAt: at(now, -23.5), status: '已归还', alert: null },
    ],
    pauses: [],
    rechecks: [],
    audit: [],
    idempotency: {},
    handovers: [],
  };

  audit(state, at(now, -6 * 24 + 3), '王芳', '放行批次', 'batch', 'B-SEED-0', '批次 B-SEED-0 放行，1 件器械转入无菌在库');
  audit(state, at(now, -25), '王芳', '完成灭菌周期', 'batch', 'B-SEED-1', '批次 B-SEED-1 灭菌周期完成');
  audit(state, at(now, -23), '王芳', '放行批次', 'batch', 'B-SEED-1', '批次 B-SEED-1 放行，3 件器械转入无菌在库');
  audit(state, at(now, -23.5), '赵敏', '归还器械', 'instrument', 'INS-003', 'TF-101 音叉组 自 诊室1 归还，转入待处理');
  audit(state, at(now, -2 * 24), '李强', '登记监测结果', 'batch', 'B-SEED-4', '批次 B-SEED-4：化学监测=合格，生物监测=不合格');
  audit(state, at(now, -2 * 24), '李强', '锁定批次', 'batch', 'B-SEED-4', '批次 B-SEED-4 锁定：监测不合格（化学:合格，生物:不合格）；同批 2 件器械已自动隔离');
  audit(state, at(now, -2), '王芳', '完成灭菌周期', 'batch', 'B-SEED-2', '批次 B-SEED-2 灭菌周期完成');
  audit(state, at(now, -1), '赵敏', '领取器械', 'instrument', 'INS-001', 'EX-001 耳镜A 由 赵敏 领取至 测听室2');
  return state;
}
