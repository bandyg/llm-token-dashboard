import React, { useEffect, useState } from 'react';
import type { ProviderConfig, UsageSnapshot } from '../../../shared/types';
import { api } from '../api';
import { TrendChart } from '../components/TrendChart';
import { navigate } from '../App';

export function ProviderDetailPage({ providerId }: { providerId: string }): React.ReactElement {
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [points, setPoints] = useState<{ collected_at: string; used: number | null; remaining: number | null; source: 'api' | 'dom' | 'ocr' | 'manual' }[]>([]);
  const [snapshots, setSnapshots] = useState<UsageSnapshot[]>([]);

  useEffect(() => {
    let alive = true;
    setLoadError(false);
    setProvider(null);
    api
      .providerGet(providerId)
      .then((p) => {
        if (!alive) return;
        if (p) setProvider(p);
        else setLoadError(true);
      })
      .catch(() => alive && setLoadError(true));
    void api.trend({ providerId, range: '30d' }).then((pts) => alive && setPoints(pts)).catch(() => undefined);
    void api.snapshotsList({ providerIds: [providerId], limit: 200 }).then((s) => alive && setSnapshots(s)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [providerId]);

  if (loadError) {
    return (
      <div className="empty-state" data-testid="provider-detail-error">
        <p>找不到该 Provider，可能已被删除，或链接已失效</p>
        <button className="btn-primary" onClick={() => navigate('#/dashboard')}>
          返回 Dashboard
        </button>
      </div>
    );
  }
  if (!provider) {
    return (
      <div aria-busy="true">
        <div className="skeleton" style={{ height: 24, width: '30%' }} />
        <div className="skeleton" style={{ height: 160, marginTop: 16 }} />
        <div className="skeleton" style={{ height: 260, marginTop: 16 }} />
      </div>
    );
  }
  return (
    <div>
      <button className="icon-btn" onClick={() => navigate('#/dashboard')}>
        ← 返回 Dashboard
      </button>
      <h1>
        {provider.provider_name}
        {provider.alias ? <span className="hint">（{provider.alias}）</span> : null}
      </h1>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>配置摘要</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, fontSize: 13 }}>
          <div>采集模式：{provider.mode}{provider.sub_mode ? ` / ${provider.sub_mode}` : ''}</div>
          <div>适配器：{provider.adapter ?? '—'}</div>
          <div>货币：{provider.currency}</div>
          <div>总额度：{provider.quota_total ?? '—'}</div>
          <div>告警阈值：{provider.alert_threshold}</div>
          <div>OCR 阈值：{provider.ocr_threshold}</div>
          <div className="mono" style={{ gridColumn: '1 / -1' }}>
            region：{provider.region ? `{x:${provider.region.x}, y:${provider.region.y}, w:${provider.region.w}, h:${provider.region.h}}` : '未配置'}
          </div>
          <div>最近刷新：{provider.last_refresh_at ? new Date(provider.last_refresh_at).toLocaleString() : '—'}</div>
          <div className={provider.last_error ? 'error-text' : ''}>{provider.last_error ? `最近失败：${provider.last_error}` : '状态正常'}</div>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>30 天趋势（仅有效快照）</h3>
        {points.length ? <TrendChart points={points} /> : <p className="hint">暂无趋势数据</p>}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>快照明细</h3>
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>已用</th>
              <th>剩余</th>
              <th>来源</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.length === 0 ? (
              <tr>
                <td colSpan={5} className="hint" style={{ textAlign: 'center' }}>
                  暂无快照：点击 Dashboard 卡片「刷新」后这里会显示明细
                </td>
              </tr>
            ) : (
              snapshots.map((s) => (
                <tr key={s.id}>
                  <td>{new Date(s.collected_at).toLocaleString()}</td>
                  <td className="mono">{s.used ?? '—'}</td>
                  <td className="mono">{s.remaining ?? '—'}</td>
                  <td>{s.source}</td>
                  <td className={s.status === 'valid' ? '' : 'error-text'}>{s.status}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
