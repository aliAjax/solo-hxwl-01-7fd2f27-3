import React, { createContext, useCallback, useContext, useState } from 'react';
import { ApiError } from './api';

// ---------- 全局提示 ----------
type Toast = { id: number; kind: 'ok' | 'err' | 'warn'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// 统一错误提示：409 冲突给出醒目提示
export function useApiError(onConflict?: () => void) {
  const toast = useToast();
  return useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 409) {
        toast('err', `冲突：${e.message}`);
        onConflict?.();
        return;
      }
      toast('err', e.message);
    } else {
      toast('err', '网络或服务异常');
    }
  }, [toast, onConflict]);
}

// ---------- 状态徽章 ----------
const STATUS_STYLE: Record<string, string> = {
  '待处理': 'gray', '处理中': 'blue', '待放行': 'amber', '无菌在库': 'green',
  '使用中': 'cyan', '已隔离': 'red', '已暂停': 'purple',
  '已放行': 'green', '已锁定': 'red', '部分恢复': 'amber', '已恢复': 'green',
  '正常': 'green', '校准过期': 'red', '停用': 'gray',
  '合格': 'green', '不合格': 'red', '未做': 'gray',
  '已归还': 'gray', 'active': 'red', 'partial': 'amber', 'lifted': 'green',
  '严重': 'red', '警告': 'amber', '提示': 'blue',
};
export function Pill({ text }: { text: string }) {
  return <span className={`pill pill-${STATUS_STYLE[text] || 'gray'}`}>{text}</span>;
}

// ---------- 弹窗 ----------
export function Modal({ title, onClose, children, width }: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---------- 表单 ----------
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h3>{title}</h3>
        <div>{extra}</div>
      </div>
      {children}
    </section>
  );
}
