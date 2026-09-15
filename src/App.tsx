import React, { useCallback, useEffect, useState } from 'react';
import { api, getActor, setActor, AlertItem } from './api';
import { ToastProvider } from './ui';
import { Dashboard, DashboardState } from './pages/Dashboard';
import { Batches } from './pages/Batches';
import { Instruments } from './pages/Instruments';
import { EquipmentPage } from './pages/Equipment';
import { UsagePage } from './pages/Usage';
import { Handover } from './pages/Handover';
import './styles.css';

type Tab = 'dashboard' | 'batches' | 'instruments' | 'equipment' | 'usage' | 'handover';
const TABS: [Tab, string][] = [
  ['dashboard', '总览'],
  ['batches', '消毒批次'],
  ['instruments', '器械追溯'],
  ['equipment', '设备校准'],
  ['usage', '领用登记'],
  ['handover', '交接班'],
];
const OPERATORS = ['王芳', '李强', '赵敏'];

function Shell() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [actor, setActorState] = useState(getActor());
  const [state, setState] = useState<DashboardState | null>(null);
  const [focus, setFocus] = useState<{ type: 'batch' | 'instrument'; id: string } | null>(null);

  const refreshState = useCallback(async () => {
    try { setState(await api<DashboardState>('GET', '/api/state')); } catch { /* 后端未就绪时静默重试 */ }
  }, []);
  useEffect(() => {
    refreshState();
    const t = setInterval(refreshState, 15000);
    return () => clearInterval(t);
  }, [refreshState]);

  const severe = state?.alerts.filter((a) => a.tier === '严重').length ?? 0;

  const jumpTo = (entityType: string, entityId: string) => {
    if (entityType === 'batch') { setFocus({ type: 'batch', id: entityId }); setTab('batches'); }
    else if (entityType === 'instrument') { setFocus({ type: 'instrument', id: entityId }); setTab('instruments'); }
    else if (entityType === 'equipment') { setTab('equipment'); }
    else setTab('dashboard');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⌖</span>
          <div>
            <div className="brand-title">听力门诊 · 器械消毒与校准追踪台</div>
            <div className="brand-sub">消毒供应追溯 / 校准效期 / 生物监测 / 交接班</div>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map(([key, label]) => (
            <button key={key} className={`tab ${tab === key ? 'on' : ''}`} onClick={() => setTab(key)}>
              {label}
              {key === 'dashboard' && severe > 0 && <span className="badge">{severe}</span>}
            </button>
          ))}
        </nav>
        <div className="actor">
          <span className="dim small">当前操作员</span>
          <select value={actor} onChange={(e) => { setActor(e.target.value); setActorState(e.target.value); }}>
            {OPERATORS.map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
      </header>

      <main>
        {tab === 'dashboard' && (state
          ? <Dashboard state={state} onJump={(a: AlertItem) => jumpTo(a.entityType, a.entityId)} />
          : <div className="page"><div className="empty">正在连接服务…</div></div>)}
        {tab === 'batches' && (
          <Batches focusId={focus?.type === 'batch' ? focus.id : null} onFocusConsumed={() => setFocus(null)} />
        )}
        {tab === 'instruments' && (
          <Instruments focusId={focus?.type === 'instrument' ? focus.id : null} onFocusConsumed={() => setFocus(null)} />
        )}
        {tab === 'equipment' && <EquipmentPage />}
        {tab === 'usage' && <UsagePage />}
        {tab === 'handover' && <Handover onJump={jumpTo} />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
