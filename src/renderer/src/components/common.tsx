import React, { useEffect, useRef } from 'react';
import { useApp } from '../store';

export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    // 焦点锁定在弹窗内
    const focusable = ref.current?.querySelector<HTMLElement>('button, input, select, [tabindex]');
    focusable?.focus();
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  // Tab 循环：焦点始终留在弹窗内
  const trapTab = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab' || !ref.current) return;
    const nodes = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inside = ref.current.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : '弹窗'} style={width ? { minWidth: width } : undefined} onKeyDown={trapTab}>
        <div className="modal-head">
          <span style={{ flex: 1 }}>{title}</span>
          <button aria-label="关闭" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Toasts(): React.ReactElement {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`} data-testid={`toast-${t.type}`}>
          <div>{t.message}</div>
          {t.detail ? (
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>{t.detail}</div>
          ) : null}
          <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
            {t.onUndo ? (
              <button
                className="icon-btn"
                style={{ background: 'rgba(255,255,255,.2)', border: 'none', color: '#fff' }}
                data-testid="toast-undo"
                onClick={() => {
                  t.onUndo?.();
                  dismissToast(t.id);
                }}
              >
                撤销
              </button>
            ) : null}
            {t.sticky || t.type === 'warning' || t.type === 'error' ? (
              <button className="icon-btn" style={{ background: 'rgba(255,255,255,.2)', border: 'none', color: '#fff' }} aria-label="关闭提示" onClick={() => dismissToast(t.id)}>
                关闭
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="menu" role="menu" ref={ref} style={{ left: x, top: y }}>
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          style={it.danger ? { color: '#EF4444' } : undefined}
          disabled={it.disabled}
          onClick={() => {
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, testid }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; testid?: string }): React.ReactElement {
  return (
    <div role="radiogroup" aria-label={testid ?? 'segmented'} style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }} data-testid={testid}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          style={{
            border: 'none',
            borderRadius: 0,
            background: value === o.value ? 'var(--primary)' : 'var(--card-bg)',
            color: value === o.value ? '#fff' : 'var(--text-2)',
            padding: '6px 14px',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ dark }: { dark?: boolean }): React.ReactElement {
  return <span className={`spin${dark ? ' dark' : ''}`} role="progressbar" aria-label="加载中" />;
}
