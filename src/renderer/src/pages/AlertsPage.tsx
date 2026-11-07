import React, { useEffect, useState } from 'react';
import type { AlertRule } from '../../../shared/types';
import { api } from '../api';
import { useApp } from '../store';
import { Spinner } from '../components/common';

export function AlertsPage(): React.ReactElement {
  const { providers, pushToast } = useApp();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<{ type: string; enabled: boolean }[]>([
    { type: 'system', enabled: true },
    { type: 'webhook', enabled: false },
    { type: 'email', enabled: false },
  ]);
  const [adding, setAdding] = useState(false);
  const [events, setEvents] = useState<{ id: string; provider_name: string; message: string; triggered_at: string }[]>([]);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    setRules(await api.alertRulesList());
    setEvents(await api.alertEventsList(30));
  };
  useEffect(() => {
    void reload();
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h1 style={{ flex: 1 }}>告警与阈值</h1>
        <button className="btn-primary" data-testid="alert-add-rule" onClick={() => setAdding(true)}>
          ＋ 新增规则
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, marginTop: 16 }}>
        <div>
          {rules.length === 0 ? (
            <div className="card empty-state" data-testid="alert-empty">
              <p>还没有告警规则，添加一条试试</p>
            </div>
          ) : (
            rules.map((r) => (
              <div key={r.id} className="card" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }} data-testid={`alert-rule-${r.id}`}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={r.enabled === 1}
                    onChange={async (e) => {
                      try {
                        await api.alertRuleSave({ ...r, enabled: e.target.checked ? 1 : 0 });
                      } catch (err) {
                        pushToast({ type: 'error', message: '更新规则失败', detail: (err as Error).message });
                      }
                      await reload();
                    }}
                    aria-label="启用规则"
                  />
                  启用
                </label>
                <div style={{ flex: 1 }}>
                  <div>
                    {r.provider_id ? providers.find((p) => p.id === r.provider_id)?.provider_name ?? r.provider_id : '全部 Provider'} ·{' '}
                    {r.metric === 'remaining_pct' ? '剩余百分比 ≤' : r.metric === 'remaining_abs' ? '剩余绝对值 ≤' : '今日已用 ≥'} <strong className="mono">{r.threshold}</strong>
                  </div>
                  <div className="hint">去重窗口 {r.dedupe_minutes} 分钟</div>
                </div>
                <button
                  className="btn-danger icon-btn"
                  onClick={async () => {
                    try {
                      await api.alertRuleDelete(r.id);
                    } catch (err) {
                      pushToast({ type: 'error', message: '删除规则失败', detail: (err as Error).message });
                    }
                    await reload();
                  }}
                >
                  删除
                </button>
              </div>
            ))
          )}
          <div className="card">
            <h3 style={{ marginTop: 0 }}>最近告警记录</h3>
            {events.length === 0 ? (
              <p className="hint">暂无告警记录</p>
            ) : (
              events.map((e) => (
                <div key={e.id} style={{ borderBottom: '1px solid var(--border)', padding: '6px 0', fontSize: 13 }}>
                  <strong>{e.provider_name}</strong> · {e.message}
                  <span className="hint" style={{ marginLeft: 8 }}>
                    {new Date(e.triggered_at).toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>通知渠道</h3>
          {channels.map((c) => (
            <div key={c.type} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                <input
                  type="checkbox"
                  data-testid={`alert-channel-${c.type}`}
                  checked={c.enabled}
                  onChange={async (e) => {
                    await api.alertChannelSet(c.type, e.target.checked);
                    setChannels((prev) => prev.map((x) => (x.type === c.type ? { ...x, enabled: e.target.checked } : x)));
                  }}
                  aria-label={`${c.type} 渠道开关`}
                />
                {c.type === 'system' ? '系统通知' : c.type === 'webhook' ? 'Webhook' : '邮件'}
              </label>
              <button
                className="icon-btn"
                disabled={testingChannel !== null}
                onClick={async () => {
                  setTestingChannel(c.type);
                  try {
                    const r = await api.alertChannelTest(c.type);
                    pushToast({ type: r.ok ? 'success' : 'error', message: r.message });
                  } catch (err) {
                    pushToast({ type: 'error', message: '测试请求失败', detail: (err as Error).message });
                  } finally {
                    setTestingChannel(null);
                  }
                }}
              >
                {testingChannel === c.type ? <Spinner dark /> : null} 测试
              </button>
            </div>
          ))}
        </div>
      </div>
      {adding ? (
        <AddRuleModal
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

function AddRuleModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }): React.ReactElement {
  const { providers, pushToast } = useApp();
  const [providerId, setProviderId] = useState('');
  const [metric, setMetric] = useState<AlertRule['metric']>('remaining_pct');
  const [threshold, setThreshold] = useState('80');
  const [dedupe, setDedupe] = useState('30');
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const t = Number(threshold);
    if (!Number.isFinite(t)) {
      pushToast({ type: 'error', message: '阈值无效', detail: '请输入一个数字，例如 80 或 10.5' });
      return;
    }
    setSaving(true);
    try {
      await api.alertRuleSave({ provider_id: providerId || null, metric, threshold: t, dedupe_minutes: Math.max(1, Number(dedupe) || 30) });
      await onSaved();
    } catch (e) {
      pushToast({ type: 'error', message: '保存规则失败', detail: (e as Error).message });
      setSaving(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="新增告警规则" style={{ minWidth: 420 }}>
        <div className="modal-head">新增告警规则</div>
        <div className="modal-body">
          <div className="form-row">
            <label>作用范围</label>
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)} aria-label="作用范围">
              <option value="">全部 Provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.provider_name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>触发条件</label>
            <select value={metric} onChange={(e) => setMetric(e.target.value as AlertRule['metric'])} aria-label="触发条件">
              <option value="remaining_pct">剩余百分比（%）≤</option>
              <option value="remaining_abs">剩余绝对值 ≤</option>
              <option value="daily_used">今日已用 ≥</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="alert-threshold-input">阈值</label>
            <input id="alert-threshold-input" value={threshold} inputMode="decimal" onChange={(e) => setThreshold(e.target.value)} aria-label="阈值" />
          </div>
          <div className="form-row">
            <label htmlFor="alert-dedupe-input">去重窗口（分钟）</label>
            <input id="alert-dedupe-input" value={dedupe} inputMode="numeric" onChange={(e) => setDedupe(e.target.value)} aria-label="去重窗口" />
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner /> : null} 保存
          </button>
        </div>
      </div>
    </div>
  );
}
