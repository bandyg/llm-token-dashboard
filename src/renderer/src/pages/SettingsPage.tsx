import React, { useEffect, useState } from 'react';
import type { SyncSettings } from '../../../shared/types';
import { api } from '../api';
import { useApp } from '../store';
import { DEFAULT_SETTINGS_CLIENT } from '../defaults';

export function SettingsPage(): React.ReactElement {
  const { pushToast, loadSettings, applyTheme } = useApp();
  const [form, setForm] = useState<SyncSettings | null>(null);
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void api.settingsGet().then(setForm);
    void api.systemInfo().then(setInfo);
  }, []);

  if (!form) {
    return <div className="skeleton" style={{ height: 300 }} aria-label="设置加载中" />;
  }

  const patch = (p: Partial<SyncSettings>): void => {
    setForm({ ...form, ...p });
    setDirty(true);
  };

  const save = async (): Promise<void> => {
    try {
      const saved = await api.settingsSet(form);
      setForm(saved);
      setDirty(false);
      applyTheme(saved.theme);
      pushToast({ type: 'success', message: '设置已保存' });
    } catch (e) {
      pushToast({ type: 'error', message: '写配置失败', detail: (e as Error).message });
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, maxWidth: 720 }}>
      <h1>设置</h1>
      <section className="card" aria-label="同步设置">
        <h2 style={{ marginTop: 0 }}>同步（刷新策略）</h2>
        <div className="form-row">
          <label htmlFor="set-strategy">刷新策略</label>
          <select id="set-strategy" value={form.strategy} onChange={(e) => patch({ strategy: e.target.value as SyncSettings['strategy'] })} aria-label="刷新策略">
            <option value="batch">分批并行（推荐）</option>
            <option value="parallel">全部并行</option>
            <option value="serial">串行</option>
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="set-batch">并发批次 batch_size（1~10）</label>
          <input
            id="set-batch"
            type="number"
            min={1}
            max={10}
            value={form.batch_size}
            onChange={(e) => patch({ batch_size: Math.min(10, Math.max(1, Number(e.target.value) || 1)) })}
            aria-label="并发批次"
          />
          <span className="hint">判据：默认 5，可调范围 1 到 10；实际并发不超过 batch_size。</span>
        </div>
        <div className="form-row">
          <label htmlFor="set-interval">相邻 Provider 刷新间隔 interval_seconds（秒）</label>
          <input id="set-interval" type="number" min={0} max={3600} value={form.interval_seconds} onChange={(e) => patch({ interval_seconds: Math.max(0, Number(e.target.value) || 0) })} aria-label="刷新间隔" />
          <span className="hint">运行日志可见相邻 provider 之间 await sleep(N) 且 N ≥ 该配置。</span>
        </div>
        <div className="form-row">
          <label htmlFor="set-minrefresh">同一 Provider 最小刷新间隔（秒，60 秒内重复刷新将跳过）</label>
          <input id="set-minrefresh" type="number" min={10} max={3600} value={form.min_refresh_seconds} onChange={(e) => patch({ min_refresh_seconds: Math.max(1, Number(e.target.value) || 60) })} aria-label="最小刷新间隔" />
        </div>
      </section>

      <section className="card" aria-label="通用设置">
        <h2 style={{ marginTop: 0 }}>通用</h2>
        <div className="form-row">
          <label htmlFor="set-theme">主题</label>
          <select id="set-theme" value={form.theme} onChange={(e) => patch({ theme: e.target.value as 'light' | 'dark' })} aria-label="主题">
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </div>
      </section>

      <section className="card" aria-label="隐私设置">
        <h2 style={{ marginTop: 0 }}>隐私</h2>
        <p className="hint">本地数据目录：{info?.dataDir ?? '…'}</p>
        <p className="hint">所有 Provider 配置、Cookie、用量快照仅保存在本机 SQLite（llm-dashboard.sqlite3），无任何云端同步或遥测。</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={async () => {
              const json = await api.configExport();
              window.prompt('复制配置导出（JSON）：', json);
            }}
          >
            导出配置
          </button>
          <button
            onClick={async () => {
              const json = window.prompt('粘贴配置导出 JSON：');
              if (!json) return;
              try {
                const r = await api.configImport(json);
                pushToast({ type: 'success', message: `已导入 ${r.imported} 条配置` });
              } catch (e) {
                pushToast({ type: 'error', message: '导入失败', detail: (e as Error).message });
              }
            }}
          >
            导入配置
          </button>
          <button
            onClick={async () => {
              const r = await api.cacheClear();
              pushToast({ type: 'success', message: r.cleared ? '缓存已清理（90 天前快照）' : '无缓存可清' });
            }}
          >
            清除缓存
          </button>
        </div>
      </section>

      <section className="card" aria-label="关于">
        <h2 style={{ marginTop: 0 }}>关于</h2>
        <p className="hint">
          LLM 额度监控台 v{info?.version ?? '1.0.0'} · Electron {navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1] ?? ''} · 采集仅由手动刷新触发
        </p>
      </section>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 24 }}>
        {dirty ? <span className="hint">● 未保存</span> : null}
        <button
          onClick={() => {
            setForm({ ...DEFAULT_SETTINGS_CLIENT });
            setDirty(true);
          }}
        >
          恢复默认
        </button>
        <button className="btn-primary" data-testid="settings-save" onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  );
}
