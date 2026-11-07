import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppProvider, useApp } from './store';
import { Toasts, ContextMenu, type MenuItem } from './components/common';
import { DashboardPage } from './pages/DashboardPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { RegionSelectorPage } from './pages/RegionSelectorPage';
import { AlertsPage } from './pages/AlertsPage';
import { HistoryPage } from './pages/HistoryPage';
import { SettingsPage } from './pages/SettingsPage';
import { ProviderDetailPage } from './pages/ProviderDetailPage';
import { api } from './api';
import { RefreshProgress } from '../../shared/types';

type Route =
  | { name: 'dashboard' }
  | { name: 'providers'; editId?: string; newFromTemplate?: string }
  | { name: 'region'; providerId?: string }
  | { name: 'alerts' }
  | { name: 'history'; providerId?: string }
  | { name: 'settings' }
  | { name: 'provider-detail'; providerId: string };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [name, param] = h.split('/');
  switch (name) {
    case 'providers':
      return { name: 'providers', editId: param || undefined };
    case 'region':
      return { name: 'region', providerId: param || undefined };
    case 'alerts':
      return { name: 'alerts' };
    case 'history':
      return { name: 'history', providerId: param || undefined };
    case 'settings':
      return { name: 'settings' };
    case 'provider-detail':
      return { name: 'provider-detail', providerId: param || '' };
    default:
      return { name: 'dashboard' };
  }
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

const NAV: { route: Route['name']; label: string; hash: string; icon: string }[] = [
  { route: 'dashboard', label: 'Dashboard', hash: '#/dashboard', icon: '📊' },
  { route: 'providers', label: '提供商配置', hash: '#/providers', icon: '⚙️' },
  { route: 'region', label: '区域选择器', hash: '#/region', icon: '🖼️' },
  { route: 'alerts', label: '告警', hash: '#/alerts', icon: '🔔' },
  { route: 'history', label: '历史', hash: '#/history', icon: '📈' },
  { route: 'settings', label: '设置', hash: '#/settings', icon: '🛠️' },
];

function Shell(): React.ReactElement {
  const [route, setRoute] = useState<Route>(parseHash);
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const { syncing, progress, pushToast, refreshUsage, refreshProviders, settings, applyTheme, unreadAlerts, sidenavCollapsed, toggleSidenav } = useApp();
  const [cooldown, setCooldown] = useState(0);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [alertDrawerOpen, setAlertDrawerOpen] = useState(false);
  const syncMenuRef = useRef<HTMLDivElement>(null);

  // 下拉菜单点击外部时关闭
  useEffect(() => {
    if (!dropdownOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!syncMenuRef.current?.contains(e.target as Node)) setDropdownOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [dropdownOpen]);

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearInterval(t);
  }, [cooldown]);

  const doSync = useCallback(
    async (scope: 'all' | 'failed' | 'selected') => {
      if (cooldown > 0) return;
      if (scope === 'selected' && selectedIds.length === 0) {
        pushToast({ type: 'info', message: '请先勾选要刷新的 Provider 卡片' });
        return;
      }
      setDropdownOpen(false);
      setCooldown(10); // 判据：全部刷新按钮点击后置灰 10 秒
      setSyncSelected(true);
      try {
        const results = await api.refreshBatch(scope, scope === 'selected' ? selectedIds : []);
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          pushToast({ type: 'warning', message: `同步完成，${failed.length} 个失败`, detail: failed.slice(0, 3).map((f) => f.reason).join('；') });
        } else {
          pushToast({ type: 'success', message: `同步完成（${results.length} 个 Provider）` });
        }
      } catch (e) {
        pushToast({ type: 'error', message: '同步失败', detail: (e as Error).message });
      } finally {
        setSyncSelected(false);
        void refreshUsage();
        void refreshProviders();
      }
    },
    [cooldown, selectedIds, pushToast, refreshUsage, refreshProviders],
  );

  const [, setSyncSelected] = useState(false);

  // 全局快捷键：R 全量同步；Cmd/Ctrl+1..6 导航；Cmd/Ctrl+, 设置；Cmd/Ctrl+F 搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        void doSync('all');
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        navigate('#/settings');
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidenav();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('[data-testid="topbar-search"]')?.focus();
      } else if ((e.metaKey || e.ctrlKey) && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        navigate(NAV[Number(e.key) - 1].hash);
      } else if (!typing && e.key.toLowerCase() === 'r' && route.name === 'dashboard') {
        void doSync('all');
      } else if (e.key === 'Escape') {
        setDropdownOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doSync, route.name, toggleSidenav]);

  const openContextMenu = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const progressView = (p: RefreshProgress | null): string => (p && !p.finished ? `正在同步 ${Math.min(p.done + (p.currentProviderId ? 1 : 0), p.total) || 1}/${p.total}` : '');

  return (
    <div className="app-shell">
      <OfflineBanner />
      <header className="topbar">
        <span
          className="logo"
          role="link"
          tabIndex={0}
          aria-label="返回 Dashboard"
          onClick={() => navigate('#/dashboard')}
          onKeyDown={(e) => e.key === 'Enter' && navigate('#/dashboard')}
        >
          <span className="logo-mark">LLM</span>额度监控台
        </span>
        <input
          className="topbar-search"
          placeholder="搜索提供商（Cmd/Ctrl+F）"
          aria-label="搜索提供商"
          data-testid="topbar-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="topbar-right">
          {syncing && progress ? (
            <div className="sync-progress" data-testid="topbar-progress" aria-live="polite">
              {progressView(progress)}
              <div className="bar">
                <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
            </div>
          ) : null}
          <div style={{ position: 'relative' }} ref={syncMenuRef}>
            <button
              className="btn-primary"
              data-testid="topbar-sync-all"
              disabled={cooldown > 0}
              aria-haspopup="menu"
              aria-expanded={dropdownOpen}
              onClick={() => setDropdownOpen((v) => !v)}
            >
              {cooldown > 0 ? `同步冷却 ${cooldown}s` : '同步刷新 ▾'}
            </button>
            {dropdownOpen ? (
              <div className="menu" style={{ top: '40px', right: 0, position: 'absolute' }}>
                <button role="menuitem" onClick={() => void doSync('all')}>刷新全部</button>
                <button role="menuitem" onClick={() => void doSync('failed')}>仅刷新失败的</button>
                <button role="menuitem" onClick={() => void doSync('selected')}>刷新选中</button>
              </div>
            ) : null}
          </div>
          <button
            className={unreadAlerts > 0 ? 'badge-dot' : ''}
            aria-label={`通知中心，${unreadAlerts} 条未读`}
            data-testid="topbar-alerts"
            onClick={() => {
              setAlertDrawerOpen(true);
            }}
          >
            🔔
          </button>
          <button aria-label="设置" data-testid="topbar-settings" onClick={() => navigate('#/settings')}>
            ⚙️
          </button>
        </div>
      </header>
      <div className="layout">
        <nav className={`sidenav${sidenavCollapsed ? ' collapsed' : ''}`} aria-label="主导航" data-testid="sidenav">
          {NAV.map((n) => (
            <a
              key={n.route}
              href={n.hash}
              className={route.name === n.route ? 'active' : ''}
              title={n.label}
              aria-label={n.label}
            >
              <span aria-hidden>{n.icon}</span>
              <span className="nav-label">{n.label}</span>
            </a>
          ))}
          <button
            type="button"
            className="sidenav-toggle"
            data-testid="sidenav-toggle"
            aria-label={sidenavCollapsed ? '展开侧栏' : '收起侧栏'}
            aria-expanded={!sidenavCollapsed}
            title={sidenavCollapsed ? '展开侧栏（Cmd/Ctrl+B）' : '收起侧栏（Cmd/Ctrl+B）'}
            onClick={toggleSidenav}
          >
            {sidenavCollapsed ? '»' : '« 收起'}
          </button>
        </nav>
        <main className="main" data-testid="main-area">
          {route.name === 'dashboard' && <DashboardPage search={search} onContextMenu={openContextMenu} selectedIds={selectedIds} onSelectedChange={setSelectedIds} />}
          {route.name === 'providers' && <ProvidersPage editId={route.editId} />}
          {route.name === 'region' && <RegionSelectorPage providerId={route.providerId} />}
          {route.name === 'alerts' && <AlertsPage />}
          {route.name === 'history' && <HistoryPage focusProviderId={route.providerId} />}
          {route.name === 'settings' && <SettingsPage />}
          {route.name === 'provider-detail' && <ProviderDetailPage providerId={route.providerId} />}
        </main>
      </div>
      <Toasts />
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
      {alertDrawerOpen ? (
        <AlertDrawer
          onClose={() => {
            setAlertDrawerOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function OfflineBanner(): React.ReactElement | null {
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = (): void => setOffline(true);
    const off = (): void => setOffline(false);
    window.addEventListener('offline', on);
    window.addEventListener('online', off);
    return () => {
      window.removeEventListener('offline', on);
      window.removeEventListener('online', off);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="banner-offline" data-testid="banner-offline" role="alert">
      网络不可用，仅显示缓存数据
    </div>
  );
}

function AlertDrawer({ onClose }: { onClose: () => void }): React.ReactElement {
  const [events, setEvents] = useState<{ id: string; provider_name: string; message: string; triggered_at: string }[]>([]);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    api
      .alertEventsList(30)
      .then(setEvents)
      .catch(() => setLoadError(true));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-mask" style={{ alignItems: 'flex-start', justifyContent: 'flex-end' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card" style={{ width: 380, margin: 16, maxHeight: '80vh', overflow: 'auto' }} role="dialog" aria-modal="true" aria-label="通知中心">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ marginTop: 0, flex: 1 }}>通知中心（最近 30 条）</h2>
          <button aria-label="关闭通知中心" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        {loadError ? (
          <p className="error-text" role="alert">
            告警记录加载失败，请关闭后稍后重试
          </p>
        ) : events.length === 0 ? (
          <p className="hint">暂无告警记录</p>
        ) : (
          events.map((e) => (
            <div key={e.id} style={{ borderBottom: '1px solid var(--border)', padding: '8px 0' }}>
              <div style={{ fontWeight: 600 }}>{e.provider_name}</div>
              <div style={{ fontSize: 13 }}>{e.message}</div>
              <div className="hint">{new Date(e.triggered_at).toLocaleString()}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function App(): React.ReactElement {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
