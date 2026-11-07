import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardUsage, ProviderConfig, RefreshProgress, SyncSettings } from '../../shared/types';
import { api } from './api';

export interface Toast {
  id: number;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  detail?: string;
  sticky?: boolean;
  onUndo?: () => void;
}

interface AppState {
  usage: DashboardUsage | null;
  providers: ProviderConfig[];
  settings: SyncSettings | null;
  progress: RefreshProgress | null;
  syncing: boolean;
  refreshInFlight: Set<string>;
  toasts: Toast[];
  unreadAlerts: number;
  refreshUsage: () => Promise<void>;
  refreshProviders: () => Promise<void>;
  loadSettings: () => Promise<void>;
  pushToast: (t: Omit<Toast, 'id'>) => number;
  dismissToast: (id: number) => void;
  applyTheme: (theme: 'light' | 'dark') => void;
  sidenavCollapsed: boolean;
  toggleSidenav: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppProvider 缺失');
  return v;
}

let toastSeq = 1;

export function AppProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [usage, setUsage] = useState<DashboardUsage | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [progress, setProgress] = useState<RefreshProgress | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [refreshInFlight, setRefreshInFlight] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [sidenavCollapsed, setSidenavCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidenav-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const seenAlerts = useRef(new Set<string>());

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = toastSeq++;
    setToasts((prev) => [...prev.slice(-2), { ...t, id }]);
    if (!t.sticky && t.type !== 'warning' && t.type !== 'error') {
      window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), t.type === 'success' ? 2000 : 3000);
    }
    return id;
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await api.dashboardUsage());
    } catch (e) {
      pushToast({ type: 'error', message: '加载 Dashboard 失败', detail: (e as Error).message });
    }
  }, [pushToast]);

  const refreshProviders = useCallback(async () => {
    try {
      setProviders(await api.providersList());
    } catch {
      // 静默
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await api.settingsGet();
      setSettings(s);
      document.documentElement.dataset.theme = s.theme === 'dark' ? 'dark' : 'light';
    } catch {
      // 静默
    }
  }, []);

  const applyTheme = useCallback((theme: 'light' | 'dark') => {
    document.documentElement.dataset.theme = theme;
  }, []);

  const toggleSidenav = useCallback(() => {
    setSidenavCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('sidenav-collapsed', next ? '1' : '0');
      } catch {
        // 静默（隐私模式等场景 localStorage 不可用，仅本次会话生效）
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void refreshUsage();
    void refreshProviders();
    void loadSettings();
    const off = api.onEvent((payload) => {
      const p = payload as { type?: string } & Record<string, unknown>;
      if (p.type === 'refresh-progress') {
        const prog = p.progress as RefreshProgress;
        setProgress(prog);
        setSyncing(!prog.finished);
        if (!prog.finished && prog.currentProviderId) {
          setRefreshInFlight((prev) => new Set(prev).add(prog.currentProviderId!));
        } else {
          setRefreshInFlight(new Set());
        }
      } else if (p.type === 'refresh-finished') {
        setSyncing(false);
        setProgress(null);
        setRefreshInFlight(new Set());
        void refreshUsage();
      } else if (p.type === 'provider-updated') {
        void refreshUsage();
        void refreshProviders();
      } else if (p.type === 'alert-triggered') {
        const evt = p.event as { id: string; message: string };
        if (!seenAlerts.current.has(evt.id)) {
          seenAlerts.current.add(evt.id);
          setUnreadAlerts((n) => n + 1);
        }
        void refreshUsage();
      }
    });
    const offline = (): void => {
      pushToast({ type: 'warning', message: '网络不可用，仅显示缓存数据' });
    };
    window.addEventListener('offline', offline);
    return () => {
      off();
      window.removeEventListener('offline', offline);
    };
  }, [refreshUsage, refreshProviders, loadSettings, pushToast]);

  const value = useMemo<AppState>(
    () => ({
      usage,
      providers,
      settings,
      progress,
      syncing,
      refreshInFlight,
      toasts,
      unreadAlerts,
      refreshUsage,
      refreshProviders,
      loadSettings,
      pushToast,
      dismissToast,
      applyTheme,
      sidenavCollapsed,
      toggleSidenav,
    }),
    [usage, providers, settings, progress, syncing, refreshInFlight, toasts, unreadAlerts, refreshUsage, refreshProviders, loadSettings, pushToast, dismissToast, applyTheme, sidenavCollapsed, toggleSidenav],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
