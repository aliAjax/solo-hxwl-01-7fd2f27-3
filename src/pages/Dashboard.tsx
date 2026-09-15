import React from 'react';
import type { AlertItem } from '../api';
import { fmtTime, remainText } from '../api';
import { Pill, Section, Empty } from '../ui';

export interface DashboardState {
  now: string;
  counts: Record<string, number>;
  alerts: AlertItem[];
  recentAudit: AuditRow[];
}
export interface AuditRow { id: string; ts: string; actor: string; action: string; entityType: string; entityId: string; detail: string; }

const TIER_ICON: Record<string, string> = { '严重': '⛔', '警告': '⚠️', '提示': 'ℹ️' };

export function AlertList({ alerts, onJump }: { alerts: AlertItem[]; onJump?: (a: AlertItem) => void }) {
  if (!alerts.length) return <Empty text="当前无待办提醒" />;
  const groups: [string, AlertItem[]][] = [['严重', []], ['警告', []], ['提示', []]];
  for (const a of alerts) groups.find((g) => g[0] === a.tier)![1].push(a);
  return (
    <div className="alert-groups">
      {groups.filter(([, list]) => list.length).map(([tier, list]) => (
        <div key={tier} className={`alert-group tier-${tier}`}>
          <div className="alert-group-head">{TIER_ICON[tier]} {tier}（{list.length}）</div>
          {list.map((a, i) => (
            <div key={i} className="alert-row" onClick={() => onJump?.(a)} role="button">
              <div className="alert-main">
                <span className="alert-title">{a.title}</span>
                <span className="alert-detail">{a.detail}</span>
              </div>
              {a.dueAt && <span className="alert-due">{remainText(a.dueAt)}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Dashboard({ state, onJump }: { state: DashboardState; onJump: (a: AlertItem) => void }) {
  const c = state.counts;
  const cards: [string, number, string][] = [
    ['待放行批次', c.pendingRelease ?? 0, 'var(--blue)'],
    ['已隔离器械', c.quarantined ?? 0, 'var(--red)'],
    ['活跃暂停', c.activePauses ?? 0, 'var(--purple)'],
    ['使用中器械', c.inUse ?? 0, 'var(--cyan)'],
    ['无菌在库', c.sterile ?? 0, 'var(--green)'],
    ['严重提醒', c.severeAlerts ?? 0, 'var(--red)'],
  ];
  return (
    <div className="page">
      <div className="stat-grid">
        {cards.map(([label, n, color]) => (
          <div key={label} className="stat-card" style={{ borderTopColor: color }}>
            <div className="stat-num" style={{ color }}>{n}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>
      <Section title="分级提醒（校准到期 / 灭菌周期 / 生物监测时限）">
        <AlertList alerts={state.alerts} onJump={onJump} />
      </Section>
      <Section title="最近动态">
        {state.recentAudit.length === 0 ? <Empty text="暂无记录" /> : (
          <table className="table">
            <tbody>
              {state.recentAudit.map((a) => (
                <tr key={a.id}>
                  <td className="mono nowrap">{fmtTime(a.ts)}</td>
                  <td className="nowrap">{a.actor}</td>
                  <td className="nowrap"><Pill text={a.action} /></td>
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
