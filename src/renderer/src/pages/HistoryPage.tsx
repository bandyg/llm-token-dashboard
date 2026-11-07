import React, { useEffect, useMemo, useState } from 'react';
import type { ProviderConfig, UsageSnapshot } from '../../../shared/types';
import { api } from '../api';
import { useApp } from '../store';
import { TrendChart } from '../components/TrendChart';

export function HistoryPage({ focusProviderId }: { focusProviderId?: string }): React.ReactElement {
  const { providers, pushToast } = useApp();
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'custom'>('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState<string[]>(focusProviderId ? [focusProviderId] : []);
  const [rows, setRows] = useState<UsageSnapshot[]>([]);
  const [loading, setLoading] = useState(true);

  const since = useMemo(() => {
    const now = new Date();
    if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    if (range === '7d') return new Date(now.getTime() - 7 * 86400_000).toISOString();
    if (range === '30d') return new Date(now.getTime() - 30 * 86400_000).toISOString();
    return from ? new Date(from).toISOString() : new Date(now.getTime() - 7 * 86400_000).toISOString();
  }, [range, from]);

  const until = useMemo(() => (range === 'custom' && to ? new Date(to).toISOString() : undefined), [range, to]);

  useEffect(() => {
    setLoading(true);
    void api
      .snapshotsList({ providerIds: picked.length ? picked : undefined, since, until, limit: 10000 })
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [picked, since, until]);

  const chartPoints = useMemo(
    () =>
      rows
        .slice(0, 200)
        .reverse()
        .map((r) => ({ collected_at: r.collected_at, used: r.used, remaining: r.remaining, source: r.source })),
    [rows],
  );

  const exportAs = async (format: 'csv' | 'json'): Promise<void> => {
    const content = await api.historyExport(format);
    pushToast({ type: 'success', message: `已导出 ${format.toUpperCase()}（${content.split('\n').length} 行，见主进程日志）` });
    window.prompt(`复制导出内容（${format}）：`, content.slice(0, 4000));
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h1 style={{ flex: 1 }}>历史趋势</h1>
        <select value={range} onChange={(e) => setRange(e.target.value as typeof range)} aria-label="时间范围">
          <option value="today">今日</option>
          <option value="7d">7 天</option>
          <option value="30d">30 天</option>
          <option value="custom">自定义</option>
        </select>
        {range === 'custom' ? (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="起始日期" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="结束日期" />
          </>
        ) : null}
        <button className="icon-btn" onClick={() => void exportAs('csv')}>
          导出 CSV
        </button>
        <button className="icon-btn" onClick={() => void exportAs('json')}>
          导出 JSON
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, marginTop: 16 }}>
        <div className="card" aria-label="Provider 多选">
          <h3 style={{ marginTop: 0 }}>Provider</h3>
          {(providers as ProviderConfig[]).filter((p) => p.enabled === 1).map((p) => (
            <label key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, padding: '4px 0' }}>
              <input
                type="checkbox"
                checked={picked.includes(p.id)}
                onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id)))}
                aria-label={`选择 ${p.provider_name}`}
              />
              {p.provider_name}
              {p.alias ? <span className="hint">（{p.alias}）</span> : null}
            </label>
          ))}
        </div>
        <div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>用量曲线（金额）</h3>
            {loading ? (
              <div className="skeleton" style={{ height: 240 }} aria-label="图表加载中" />
            ) : chartPoints.length === 0 ? (
              <p className="hint">选择时间范围开始查看（暂无有效快照）</p>
            ) : (
              <TrendChart points={chartPoints} width={760} />
            )}
          </div>
          <div className="card" style={{ marginTop: 16, maxHeight: 360, overflow: 'auto' }}>
            <h3 style={{ marginTop: 0 }}>明细</h3>
            <table className="table" data-testid="history-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>Provider</th>
                  <th>模式</th>
                  <th>已用</th>
                  <th>剩余</th>
                </tr>
              </thead>
              <tbody>
                {!loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="hint" style={{ textAlign: 'center' }}>
                      暂无明细：该时间范围内没有快照，先去 Dashboard 点「同步刷新」
                    </td>
                  </tr>
                ) : (
                  rows.slice(0, 300).map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{new Date(r.collected_at).toLocaleString()}</td>
                      <td>{(providers as ProviderConfig[]).find((p) => p.id === r.provider_id)?.provider_name ?? r.provider_id}</td>
                      <td>{r.source.toUpperCase()}</td>
                      <td className="mono">{r.used ?? '—'}</td>
                      <td className="mono">{r.remaining ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
