import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { Spinner } from '../components/common';
import { regionBrowserBounds, sidenavWidth } from '../../../shared/layout';

/**
 * 区域选择器宿主页：点击「打开浏览器捕获」后主进程把对应 Provider 的 BrowserView
 * 附着到主窗口中部（地址栏下方），并在其上注入 9999 层透明选区画布（见 region-overlay）。
 */
export function RegionSelectorPage({ providerId }: { providerId?: string }): React.ReactElement {
  const { providers, pushToast, sidenavCollapsed } = useApp();
  const [selected, setSelected] = useState<string>(providerId ?? '');
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState('');
  const [opened, setOpened] = useState(false);
  const [loginRequired, setLoginRequired] = useState(false);

  useEffect(() => {
    if (selected) {
      void api.providerGet(selected).then((p) => p && setUrl(p.dom_url || p.page_url || ''));
    }
  }, [selected]);

  // 主进程通知浏览器视图关闭（overlay 取消 / 侧栏切换）→ 宿主页复位
  useEffect(() => {
    const off = api.onEvent((payload) => {
      const p = payload as { type?: string; providerId?: string };
      if (p.type === 'region-browser-closed' && (!p.providerId || p.providerId === selected)) {
        setOpened(false);
        setLoginRequired(false);
      }
    });
    return off;
  }, [selected]);

  // 打开 / 窗口尺寸变化 / 侧栏折叠切换 → 同步 BrowserView bounds
  const sidebarW = sidenavWidth(sidenavCollapsed);
  useEffect(() => {
    if (!opened || !selected) return;
    const sync = (): void => {
      void api.browserResize(selected, regionBrowserBounds(window.innerWidth, window.innerHeight, sidebarW));
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [opened, selected, sidebarW]);

  // 路由离开时解除附着
  useEffect(() => {
    return () => {
      if (opened && selected) void api.browserClose(selected).catch(() => undefined);
    };
  }, [opened, selected]);

  const open = async (): Promise<void> => {
    if (!selected) {
      pushToast({ type: 'warning', message: '请先选择一个 Provider（OCR 抓取需要先保存配置）' });
      return;
    }
    setLoading(true);
    try {
      const res = await api.browserOpen(selected, sidebarW);
      setOpened(true);
      if (res.mode === 'login_required') {
        setLoginRequired(true);
        // info 级自动消失：持久引导由工具栏「🔐 我已完成登录」按钮承担，粘性提示会遮挡工具栏控件
        pushToast({ type: 'info', message: '该页面需要登录：请直接在下方内嵌页面完成登录，再点「我已完成登录」' });
      } else {
        setLoginRequired(false);
        pushToast({ type: 'info', message: '选区画布已叠加：按住鼠标左键拖拽框选数字区域' });
      }
    } catch (e) {
      pushToast({ type: 'error', message: '打开浏览器失败', detail: (e as Error).message });
    } finally {
      setLoading(false);
    }
  };

  const recheckLogin = async (): Promise<void> => {
    const res = await api.browserRecheck(selected).catch(() => null);
    if (!res) {
      pushToast({ type: 'error', message: '登录态检测失败，请重试' });
      return;
    }
    if (res.mode === 'ready') {
      setLoginRequired(false);
      pushToast({ type: 'success', message: '登录态确认：选区画布已叠加，拖拽框选数字区域' });
    } else if (res.mode === 'login_required') {
      pushToast({ type: 'info', message: '还未检测到登录态：请完成登录后再点「我已完成登录」' });
    } else {
      setOpened(false);
      setLoginRequired(false);
    }
  };

  const closeBrowser = async (): Promise<void> => {
    await api.browserClose(selected).catch(() => undefined);
    setOpened(false);
    setLoginRequired(false);
  };

  return (
    <div className="region-page" data-testid="region-selector-page">
      <div className="region-address">
        <strong style={{ marginRight: 8 }}>区域选择器</strong>
        <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="选择 Provider" data-testid="region-provider-select">
          <option value="">选择 Provider…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.provider_name}
              {p.alias ? `（${p.alias}）` : ''}
            </option>
          ))}
        </select>
        <input className="mono" style={{ flex: 1 }} value={url} readOnly aria-label="目标页面地址" />
        <button className="btn-primary" data-testid="region-open-browser" onClick={() => void open()} disabled={loading}>
          {loading ? <Spinner /> : null} 打开浏览器捕获
        </button>
        {opened && loginRequired ? (
          <button className="btn-primary" data-testid="region-login-done" onClick={() => void recheckLogin()}>
            🔐 我已完成登录
          </button>
        ) : null}
        {opened ? (
          <button data-testid="region-close-browser" onClick={() => void closeBrowser()}>
            关闭浏览器
          </button>
        ) : null}
      </div>
      {!opened ? (
        <div className="region-placeholder">
          <div style={{ textAlign: 'center', maxWidth: 460 }}>
            <p style={{ fontSize: 16 }}>
              选择 Provider 后点击「打开浏览器捕获」，将在上方中部内嵌该控制台页面，
              并叠加一层截图工具式选区画布（z-index 9999）。
            </p>
            <p className="hint">拖拽框选 → 松开自动命名 → 保存后坐标终身复用，彻底告别手填 x,y,w,h。</p>
          </div>
        </div>
      ) : loginRequired ? (
        <div className="region-placeholder" data-testid="region-login-hint" style={{ visibility: 'hidden' }} aria-hidden />
      ) : (
        <div className="region-placeholder" style={{ visibility: 'hidden' }} aria-hidden />
      )}
    </div>
  );
}

