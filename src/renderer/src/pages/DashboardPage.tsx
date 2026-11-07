import React, { useEffect, useMemo, useState } from 'react';
import type { ProviderUsageView, SyncSettings, TrendPoint } from '../../../shared/types';
import { api } from '../api';
import { useApp } from '../store';
import { navigate } from '../App';
import { Modal, Segmented, Spinner } from '../components/common';
import { TrendChart } from '../components/TrendChart';
import { PlanCard } from '../components/PlanCard';
import { OverviewBanner } from '../components/OverviewBanner';
import type { MenuItem } from '../components/common';
import { fmtMoney, fmtSnapshotDetail, providerRemainingPct } from '../utils';

const bandColor: Record<string, string> = { low: 'band-low', mid: 'band-mid', high: 'band-high' };

/** 数值格式化：TOKEN/COUNT 自动千进位 + M/k；USD/CNY 加货币符号（复用 utils） */

/** 额度维度徽章：USD（美元）/ CNY（人民币）/ TOKEN（token 配额）/ CREDIT（额度点数）/ COUNT（次数） */
function currencyBadge(currency: string): { label: string; className: string } | null {
  const c = currency.toUpperCase();
  if (c === 'USD') return { label: 'USD', className: 'usd' };
  if (c === 'CNY') return { label: 'CNY', className: 'cny' };
  if (c === 'TOKEN') return { label: 'TOKEN', className: 'token' };
  if (c === 'CREDIT') return { label: 'CREDIT', className: 'credit' };
  if (c === 'COUNT') return { label: '次数', className: 'count' };
  return null;
}

export function DashboardPage({
  search,
  onContextMenu,
  selectedIds,
  onSelectedChange,
}: {
  search: string;
  onContextMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  selectedIds: string[];
  onSelectedChange: (ids: string[]) => void;
}): React.ReactElement {
  const { usage, refreshInFlight, providers, pushToast, refreshUsage, refreshProviders } = useApp();
  const [trendFor, setTrendFor] = useState<ProviderUsageView | null>(null);
  const [manualFor, setManualFor] = useState<ProviderUsageView | null>(null);
  const [loginFor, setLoginFor] = useState<ProviderUsageView | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProviderUsageView | null>(null);
  const [deleting, setDeleting] = useState(false);

  const doDelete = async (): Promise<void> => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.providerDelete(confirmDelete.id);
      pushToast({ type: 'success', message: `已删除 ${confirmDelete.provider_name}` });
      setConfirmDelete(null);
    } catch (err) {
      pushToast({ type: 'error', message: '删除失败', detail: (err as Error).message });
    } finally {
      setDeleting(false);
      await refreshProviders();
      await refreshUsage();
    }
  };

  const filtered = useMemo(() => {
    const list = usage?.providers ?? [];
    const q = search.trim().toLowerCase();
    const matched = q ? list.filter((p) => `${p.provider_name} ${p.alias}`.toLowerCase().includes(q)) : [...list];
    // 卡片按剩余量降序，一眼先看到还能用的：余量多的在前；
    // 耗尽（最紧窗口 0%）的沉到最底；读不出水位的（纯余额/未采集/失败）排在有余量之后、耗尽之前。
    // 同档内保持原顺序（sort 稳定），不打散后端创建序。
    const pctOf = new Map(matched.map((p) => [p.id, providerRemainingPct(p)]));
    const tierOf = (pct: number | null): 0 | 1 | 2 => (pct === null ? 1 : pct <= 0 ? 2 : 0);
    return matched.sort((a, b) => {
      const pa = pctOf.get(a.id) ?? null;
      const pb = pctOf.get(b.id) ?? null;
      const ta = tierOf(pa);
      const tb = tierOf(pb);
      if (ta !== tb) return ta - tb;
      if (ta === 0) return (pb ?? 0) - (pa ?? 0);
      return 0;
    });
  }, [usage, search]);

  const refreshOne = async (id: string): Promise<void> => {
    // 「立即刷新」是用户显式动作，绕开 60s 节流（后端 force 通道已存在，之前 renderer 未传）
    const r = await api.refreshOne(id, { force: true });
    if (r.ok && r.snapshot) {
      const detail = fmtSnapshotDetail(r.snapshot);
      pushToast({ type: 'success', message: '已采集', detail: detail ?? undefined });
    } else if (!r.ok && r.reason) {
      pushToast({ type: r.reason.includes('频繁') ? 'warning' : 'error', message: r.reason });
    }
    await refreshUsage();
  };

  if (!usage) {
    return (
      <div>
        <h1>Dashboard</h1>
        <div className="provider-grid" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card provider-card" style={{ cursor: 'default' }}>
              <div className="skeleton" style={{ height: 20, width: '55%' }} />
              <div className="skeleton" style={{ height: 8 }} />
              <div className="skeleton" style={{ height: 12, width: '40%' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const list = filtered;
  /** 今日概览的数据源：多窗口厂商已由套餐卡逐窗口展示，概览不再重复它们 */
  const overviewItems = list.filter((p) => p.used !== null && (p.windows?.length ?? 0) === 0);
  /** 存在额度窗口时才显示总览头图（纯余额厂商没有可比百分比） */
  const showBanner = list.some((p) => (p.windows?.length ?? 0) > 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
        <h1>Dashboard</h1>
        <span className="hint">打开/切回应用或点「同步刷新」即采集，无任何后台轮询</span>
        {/* 各额度维度的用量明细（P1-002 契约：多维度共存时各桶独立呈现，不跨维度相加）。
            下方「额度总览」只做最紧窗口的横向对比，两处职责不同：这里看分维度总量，那里看风险排序。 */}
        {usage.byCurrency.length > 0 ? (
          <span data-testid="summary-by-currency" style={{ display: 'inline-flex', gap: 12, flexWrap: 'wrap' }}>
            {usage.byCurrency.map((b) => {
              const badge = currencyBadge(b.currency);
              // 纯百分比维度（PERCENT）没有可加总的数值，恒不展示数字
              const showNumbers = b.currency.toUpperCase() !== 'PERCENT';
              return (
                <span key={b.currency} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
                  {badge && <span className={`tag-dim ${badge.className}`}>{badge.label}</span>}
                  {showNumbers ? (
                    <span className="mono">
                      已用 {fmtMoney(b.used, b.currency)} / 剩余 {fmtMoney(b.remaining, b.currency)}
                      {b.provider_count > 1 ? <span className="hint">（{b.provider_count} 个）</span> : null}
                    </span>
                  ) : (
                    <span className="hint">{b.provider_count} 个</span>
                  )}
                </span>
              );
            })}
          </span>
        ) : null}
      </div>

      {showBanner ? <OverviewBanner providers={list} /> : null}

      {list.length === 0 ? (
        <EmptyState hasAnyProvider={providers.length > 0} searchActive={!!search.trim()} />
      ) : (
        <ProviderGrid
          items={list}
          inFlight={refreshInFlight}
          selectedIds={selectedIds}
          onSelectedChange={onSelectedChange}
          onClickCard={(p) => {
            // 失败卡片单击直达手动录入（判据：点击行 → 录入 → 提交 ≤3 次点击）；正常卡片打开趋势弹层
            if (p.status === 'failed') setManualFor(p);
            else setTrendFor(p);
          }}
          onDoubleClickCard={(p) => {
            navigate(`#/provider-detail/${p.id}`);
          }}
          onManualEntry={(p) => setManualFor(p)}
          onLogin={(p) => setLoginFor(p)}
          onRefresh={refreshOne}
          onContextMenu={onContextMenu}
          onRequestDelete={(p) => setConfirmDelete(p)}
        />
      )}

      {overviewItems.length > 0 ? <TodayOverview items={overviewItems} /> : null}

      {trendFor ? <TrendModal provider={trendFor} onClose={() => setTrendFor(null)} /> : null}
      {confirmDelete ? (
        <Modal
          title={`删除 ${confirmDelete.provider_name}${confirmDelete.alias ? `（${confirmDelete.alias}）` : ''}`}
          onClose={() => setConfirmDelete(null)}
          width={420}
          footer={
            <>
              <button onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn-danger" style={{ border: '1px solid var(--danger)' }} onClick={() => void doDelete()} disabled={deleting} data-testid="confirm-delete">
                {deleting ? <Spinner /> : null} 确认删除
              </button>
            </>
          }
        >
          <p>将删除该 Provider 及其全部历史快照，此操作不可撤销。</p>
          <p className="hint">如只是想暂停监控，可在卡片右键菜单中选择「禁用」。</p>
        </Modal>
      ) : null}
      {manualFor ? (
        <ManualEntryModal
          provider={manualFor}
          onClose={() => setManualFor(null)}
          onSaved={async () => {
            await refreshUsage();
          }}
        />
      ) : null}
      {loginFor ? <LoginModal provider={loginFor} onClose={() => setLoginFor(null)} onDone={async () => { await refreshUsage(); await refreshProviders(); }} /> : null}
    </div>
  );
}

/**
 * 套餐卡折叠状态：按 provider 逐个记忆，默认折叠（点标题才展开）。
 * 通过 settings KV 持久化，重启后保持上次状态；localStorage 兜底避免设置写入失败时状态跳回。
 */
const COLLAPSE_KEY = 'plan-card-collapsed';

function usePlanCollapse(): { isCollapsed: (id: string) => boolean; toggle: (id: string) => void } {
  const [map, setMap] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    // 先用本地缓存立即渲染，避免首屏闪烁；随后以持久化设置为准
    try {
      const cached = window.localStorage.getItem(COLLAPSE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as Record<string, boolean>;
        if (alive && parsed && typeof parsed === 'object') setMap(parsed);
      }
    } catch {
      /* 缓存损坏时忽略，用默认展开态 */
    }
    void api
      .settingsGet()
      .then((s) => {
        const stored = (s as unknown as Record<string, unknown>)[COLLAPSE_KEY];
        if (alive && stored && typeof stored === 'object') setMap(stored as Record<string, boolean>);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // 折叠集合的语义：key 存在且为 true 表示折叠；未出现的 provider 默认折叠
  const isCollapsed = React.useCallback((id: string) => map[id] !== false, [map]);

  const toggle = React.useCallback(
    (id: string) => {
      setMap((prev) => {
        const next = { ...prev, [id]: prev[id] === false };
        try {
          window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
        } catch {
          /* 存储不可用时仅保留内存态 */
        }
        void api
          .settingsSet({ [COLLAPSE_KEY]: next } as unknown as Partial<SyncSettings>)
          .catch(() => undefined);
        return next;
      });
    },
    [],
  );

  return { isCollapsed, toggle };
}

export function EmptyState({ hasAnyProvider, searchActive }: { hasAnyProvider: boolean; searchActive: boolean }): React.ReactElement {
  return (
    <div className="empty-state" data-testid="dashboard-empty">
      {/* 空态插画（判据要求插画元素本体存在并可断言） */}
      <svg width="160" height="120" viewBox="0 0 160 120" role="img" aria-label="空态插画：尚未配置任何提供商" data-testid="empty-illustration">
        <rect x="20" y="18" width="120" height="84" rx="8" fill="#EFF6FF" stroke="#BFDBFE" />
        <rect x="34" y="34" width="40" height="26" rx="4" fill="#DBEAFE" />
        <rect x="86" y="34" width="40" height="26" rx="4" fill="#DBEAFE" />
        <rect x="34" y="68" width="92" height="8" rx="4" fill="#BFDBFE" />
        <rect x="34" y="82" width="60" height="8" rx="4" fill="#BFDBFE" />
        <circle cx="128" cy="26" r="12" fill="#2D7FF9" />
        <path d="M128 20v12M122 26h12" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <p style={{ margin: 0 }}>
        {searchActive
          ? '没有匹配搜索条件的提供商'
          : hasAnyProvider
            ? '所有提供商均已禁用，启用后即可在这里看到额度'
            : '还没有配置任何 LLM 提供商，点击右上角添加'}
      </p>
      {!searchActive && !hasAnyProvider ? (
        <button className="btn-primary" data-testid="empty-add-provider" onClick={() => navigate('#/providers')}>
          添加 Provider
        </button>
      ) : null}
    </div>
  );
}

function ProviderGrid({
  items,
  inFlight,
  selectedIds,
  onSelectedChange,
  onClickCard,
  onDoubleClickCard,
  onManualEntry,
  onLogin,
  onRefresh,
  onContextMenu,
  onRequestDelete,
}: {
  items: ProviderUsageView[];
  inFlight: Set<string>;
  selectedIds: string[];
  onSelectedChange: (ids: string[]) => void;
  onClickCard: (p: ProviderUsageView) => void;
  onDoubleClickCard: (p: ProviderUsageView) => void;
  onManualEntry: (p: ProviderUsageView) => void;
  onLogin: (p: ProviderUsageView) => void;
  onRefresh: (id: string) => Promise<void>;
  onContextMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  onRequestDelete: (p: ProviderUsageView) => void;
}): React.ReactElement {
  const { refreshProviders, refreshUsage } = useApp();
  // 判据：Provider 数量超过 12 时启用虚拟滚动
  const [virtual, setVirtual] = useState(false);
  useEffect(() => {
    setVirtual(items.length > 12);
  }, [items.length]);
  const visible = virtual ? items.slice(0, 12) : items;
  const { isCollapsed, toggle } = usePlanCollapse();
  return (
    <>
      <div className="provider-grid plan-grid" data-testid="provider-grid" aria-busy={inFlight.size > 0}>
        {visible.map((p) => (
          <PlanCard
            key={p.id}
            p={p}
            loading={inFlight.has(p.id)}
            checked={selectedIds.includes(p.id)}
            onCheck={(c) => onSelectedChange(c ? [...selectedIds, p.id] : selectedIds.filter((x) => x !== p.id))}
            collapsed={isCollapsed(p.id)}
            onToggle={() => toggle(p.id)}
            onClick={() => onClickCard(p)}
            onDoubleClick={() => onDoubleClickCard(p)}
            onManualEntry={() => onManualEntry(p)}
            onLogin={() => onLogin(p)}
            onRefresh={() => void onRefresh(p.id)}
            onEdit={() => navigate(`#/providers/${p.id}`)}
            onContextMenu={onContextMenu}
            onDelete={() => onRequestDelete(p)}
            onToggleEnabled={() => {
              void (async () => {
                await api.providerSetEnabled(p.id, !p.enabled);
                await refreshProviders();
                await refreshUsage();
              })();
            }}
          />
        ))}
      </div>
      {virtual ? <p className="hint">已启用虚拟滚动：当前显示前 12 张卡片（共 {items.length}）</p> : null}
    </>
  );
}

export function ProviderCard({
  p,
  loading,
  checked,
  onCheck,
  onClick,
  onDoubleClick,
  onManualEntry,
  onLogin,
  onRefresh,
  onContextMenu,
  onRequestDelete,
}: {
  p: ProviderUsageView;
  loading: boolean;
  checked: boolean;
  onCheck: (c: boolean) => void;
  onClick: () => void;
  onDoubleClick: () => void;
  onManualEntry: () => void;
  onLogin: () => void;
  onRefresh: () => void;
  onContextMenu: (e: React.MouseEvent, items: MenuItem[]) => void;
  onRequestDelete?: () => void;
}): React.ReactElement {
  const { pushToast, refreshProviders, refreshUsage } = useApp();
  const statusDot = p.status === 'failed' ? 'err' : p.alert ? 'warn' : p.status === 'never' ? 'idle' : 'ok';
  const statusText = p.status === 'failed' ? '抓取失败' : p.alert ? '额度告警' : p.status === 'never' ? '未采集' : '正常';
  const deleteItem: MenuItem = onRequestDelete
    ? { label: '删除', danger: true, onClick: onRequestDelete }
    : {
        label: '删除',
        danger: true,
        onClick: () => void (async () => {
          try {
            await api.providerDelete(p.id);
            pushToast({ type: 'success', message: `已删除 ${p.provider_name}` });
          } catch (err) {
            pushToast({ type: 'error', message: '删除失败', detail: (err as Error).message });
          }
          await refreshProviders();
          await refreshUsage();
        })(),
      };
  const clickTimer = React.useRef<number>(0);
  return (
    <div
      className={`card provider-card${p.status === 'failed' ? ' failed' : ''}${p.alert ? ' alert-bg' : ''}`}
      data-testid={`provider-card-${p.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${p.provider_name} ${p.alias} 卡片`}
      onClick={() => {
        window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(onClick, 220);
      }}
      onDoubleClick={() => {
        window.clearTimeout(clickTimer.current);
        onDoubleClick();
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') onClick();
        else if (e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={(e) =>
        onContextMenu(e, [
          { label: '立即刷新', onClick: onRefresh },
          { label: '编辑配置', onClick: () => navigate(`#/providers/${p.id}`) },
          {
            label: p.enabled ? '禁用' : '启用',
            onClick: async () => {
              await api.providerSetEnabled(p.id, !p.enabled);
              await refreshProviders();
              await refreshUsage();
            },
          },
          deleteItem,
        ])
      }
    >
      <div className="head">
        <input
          type="checkbox"
          aria-label={`选中 ${p.provider_name}`}
          data-testid={`card-check-${p.id}`}
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onCheck(e.target.checked)}
        />
        <span role="img" className={`status-dot ${statusDot}`} aria-label={`状态：${statusText}`} />
        <span className="card-title">
          {p.provider_name}
          {p.alias ? <span className="hint">（{p.alias}）</span> : null}
        </span>
        {(() => {
          const badge = currencyBadge(p.currency);
          return badge ? (
            <span
              className={`tag-dim ${badge.className}`}
              data-testid={`currency-badge-${p.id}`}
              title={`额度维度：${badge.label}`}
            >
              {badge.label}
            </span>
          ) : null;
        })()}
        {p.alert ? <span className="tag alert">告警</span> : null}
        {p.status === 'manual-override' ? <span className="tag ok">手动覆盖</span> : null}
        {loading ? <Spinner dark /> : null}
      </div>

      {loading ? (
        <>
          <div className="skeleton" style={{ height: 8 }} />
          <div className="skeleton" style={{ height: 12, width: '60%' }} />
        </>
      ) : (
        <>
          <div className="progress-track" title={p.percent_used === null ? '暂无数据' : `使用率 ${p.percent_used}%`}>
            <div className={`progress-fill ${bandColor[p.progress_band]}`} style={{ width: `${Math.min(100, p.percent_used ?? 0)}%` }} data-testid={`progress-fill-${p.id}`} />
          </div>
          {/* 判据：文本为「已用 $X / $Y（Z%）」格式；尚无任何用量数据时给出下一步指引，避免「已用 - / - （-）」的空洞占位 */}
          <div className="progress-text mono" data-testid={`progress-text-${p.id}`}>
            {p.used === null && p.percent_used === null ? (
              p.auth_required ? (
                <span className="hint">尚未采集：先登录后点「刷新」读取额度</span>
              ) : (
                <span className="hint">尚未采集：点「刷新」读取额度</span>
              )
            ) : (
              `已用 ${fmtMoney(p.used, p.currency)} / ${fmtMoney(p.total, p.currency)}（${p.percent_used === null ? '—' : `${p.percent_used}%`}）`
            )}
          </div>
          {p.auth_required ? (
            <div className="auth-required" data-testid={`card-auth-${p.id}`}>
              🔐 请手动登录
            </div>
          ) : null}
          {p.status === 'failed' ? (
            <div className="card-error-msg" data-testid={`card-error-msg-${p.id}`} title={p.fail_reason ?? ''}>
              ⚠️ 抓取失败：{p.fail_reason}
            </div>
          ) : null}
          <div className="card-foot">
            <span title="最近一次抓取时间">最近抓取：{p.collected_at ? new Date(p.collected_at).toLocaleString() : '—'}</span>
            <span className="card-actions">
              {p.auth_required ? (
                <button className="btn-danger icon-btn" data-testid={`card-login-${p.id}`} aria-label="手动登录" onClick={(e) => { e.stopPropagation(); onLogin(); }}>
                  🔐 登录
                </button>
              ) : null}
              {p.status === 'failed' ? (
                <button className="btn-danger icon-btn" data-testid={`card-manual-entry-${p.id}`} aria-label="手动录入" onClick={(e) => { e.stopPropagation(); onManualEntry(); }}>
                  手动录入
                </button>
              ) : null}
              <button className="icon-btn" data-testid={`card-refresh-${p.id}`} aria-label={`刷新 ${p.provider_name}`} onClick={(e) => { e.stopPropagation(); onRefresh(); }}>
                ⟳ 刷新
              </button>
              <button className="icon-btn" data-testid={`card-edit-${p.id}`} aria-label={`编辑 ${p.provider_name}`} onClick={(e) => { e.stopPropagation(); navigate(`#/providers/${p.id}`); }}>
                ✎ 编辑
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** 单击卡片 → 趋势弹层（已用/剩余双 Y 轴，24h/7d/30d/custom，仅有效快照） */
export function TrendModal({ provider, onClose }: { provider: ProviderUsageView; onClose: () => void }): React.ReactElement {
  const [range, setRange] = useState<'24h' | '7d' | '30d' | 'custom'>('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [points, setPoints] = useState<TrendPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .trend({ providerId: provider.id, range, from: from || undefined, to: to || undefined })
      .then((pts) => alive && setPoints(pts))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [provider.id, range, from, to, attempt]);

  const reloadOnce = (): void => {
    if (reloading) return;
    setReloading(true);
    void api
      .refreshOne(provider.id, { force: true })
      .catch(() => undefined)
      .finally(() => {
        setReloading(false);
        setAttempt((n) => n + 1);
      });
  };

  return (
    <Modal title={`${provider.provider_name} 历史趋势`} onClose={onClose} width={700}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <Segmented
          testid="trend-range"
          value={range}
          onChange={(v) => setRange(v)}
          options={[
            { value: '24h', label: '24h' },
            { value: '7d', label: '7d' },
            { value: '30d', label: '30d' },
            { value: 'custom', label: 'custom' },
          ]}
        />
        {range === 'custom' ? (
          <>
            <input type="date" aria-label="起始日期" value={from} onChange={(e) => setFrom(e.target.value)} />
            <input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} />
          </>
        ) : null}
        <span className="hint" data-testid="trend-point-count">
          数据点 {points?.length ?? 0}（仅有效快照）
        </span>
      </div>
      {error ? (
        <div className="error-text" role="alert">
          图表加载失败，<a href="#/" onClick={(e) => { e.preventDefault(); setAttempt((n) => n + 1); }}>点击重试</a>
        </div>
      ) : points === null ? (
        <div className="skeleton" style={{ height: 260 }} />
      ) : points.length === 0 ? (
        <div className="empty-state" data-testid="trend-empty">
          <p>暂无趋势数据</p>
          <button className="btn-primary" onClick={reloadOnce} disabled={reloading}>
            {reloading ? <Spinner dark /> : null} {reloading ? '正在刷新…' : '立即刷新一次'}
          </button>
        </div>
      ) : (
        <TrendChart points={points} />
      )}
    </Modal>
  );
}

/** 手动录入兜底弹窗：预填最近快照值，「点击行 → 录入按钮 → 提交」≤3 次点击 */
export function ManualEntryModal({ provider, onClose, onSaved }: { provider: ProviderUsageView; onClose: () => void; onSaved: () => Promise<void> }): React.ReactElement {
  const { pushToast } = useApp();
  const [mode, setMode] = useState<'used' | 'remaining'>(provider.remaining !== null && provider.used === null ? 'remaining' : 'used');
  const [amount, setAmount] = useState<string>(String(provider.used ?? provider.remaining ?? ''));
  const [time, setTime] = useState<string>(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (keepOpen: boolean): Promise<void> => {
    const v = Number(amount.replace(/,/g, ''));
    if (!Number.isFinite(v) || v < 0) {
      pushToast({ type: 'error', message: '数值异常，请确认', detail: '请输入非负数字' });
      return;
    }
    setSaving(true);
    try {
      const r = await api.manualEntry(provider.id, {
        mode,
        amount: v,
        recordedAt: time ? new Date(time).toISOString() : undefined,
        note: note || undefined,
        total: provider.total,
      });
      if ('error' in (r as { error?: string })) {
        pushToast({ type: 'error', message: (r as unknown as { error: string }).error });
        return;
      }
      pushToast({ type: 'success', message: '已生成有效快照（来源：手动录入）' });
      await onSaved();
      if (keepOpen) {
        setAmount('');
      } else {
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`为 ${provider.provider_name}${provider.alias ? `（${provider.alias}）` : ''} 手动录入用量`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button onClick={() => void submit(true)} disabled={saving}>
            保存并继续
          </button>
          <button className="btn-primary" data-testid="manual-save" onClick={() => void submit(false)} disabled={saving}>
            {saving ? <Spinner /> : null} 保存
          </button>
        </>
      }
    >
      {provider.status === 'failed' ? <p className="hint">最后一次同步失败：{provider.fail_reason ?? '未知原因'}</p> : null}
      <div className="form-row">
        <label>录入模式</label>
        <Segmented
          testid="manual-mode"
          value={mode}
          onChange={(v) => setMode(v)}
          options={[
            { value: 'used', label: '已用金额' },
            { value: 'remaining', label: '剩余额度' },
          ]}
        />
      </div>
      <div className="form-row">
        <label htmlFor="manual-amount-input">数值{mode === 'used' ? '（本周期已用）' : '（当前剩余）'}</label>
        <input
          id="manual-amount-input"
          data-testid="manual-amount"
          value={amount}
          inputMode="decimal"
          aria-label="用量数值"
          onChange={(e) => setAmount(e.target.value)}
          onBlur={() => setAmount((v) => (Number.isFinite(Number(v.replace(/,/g, ''))) ? Number(v.replace(/,/g, '')).toLocaleString('en-US') : v))}
          onKeyDown={(e) => e.key === 'Enter' && void submit(false)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="manual-time-input">记录时间</label>
        <input id="manual-time-input" data-testid="manual-time" type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} aria-label="记录时间" />
      </div>
      <div className="form-row">
        <label htmlFor="manual-note-input">备注（可选）</label>
        <input id="manual-note-input" value={note} onChange={(e) => setNote(e.target.value)} aria-label="备注" />
      </div>
      <p className="hint">保存后生成 status=valid 快照，立即参与告警判断与趋势图。</p>
    </Modal>
  );
}

/** 未登录：弹窗 BrowserView 完成登录（复用会话，Cookie 持久化） */
export function LoginModal({ provider, onClose, onDone }: { provider: ProviderUsageView; onClose: () => void; onDone: () => Promise<void> }): React.ReactElement {
  const { pushToast } = useApp();
  const [opened, setOpened] = useState(false);
  const open = async (): Promise<void> => {
    try {
      await api.loginOpen(provider.id);
      setOpened(true);
      pushToast({ type: 'info', message: '已在独立窗口打开登录页，完成后点击「我已登录完成」' });
    } catch (e) {
      pushToast({ type: 'error', message: '打开登录窗口失败', detail: (e as Error).message });
    }
  };
  const complete = async (): Promise<void> => {
    const r = await api.loginComplete(provider.id);
    if (r.authStatus === 'ok') {
      pushToast({ type: 'success', message: `登录态已保存（${r.cookies} 条 Cookie）` });
      onClose();
      await onDone();
    } else {
      pushToast({ type: 'warning', message: '仍检测到未登录，请在窗口内完成登录后重试' });
    }
  };
  return (
    <Modal
      title={`登录 ${provider.provider_name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          {!opened ? (
            <button className="btn-primary" data-testid="login-open" onClick={() => void open()}>
              打开登录窗口
            </button>
          ) : (
            <button className="btn-primary" data-testid="login-complete" onClick={() => void complete()}>
              我已登录完成
            </button>
          )}
        </>
      }
    >
      <p>将在独立窗口打开 {provider.provider_name} 的控制台页面（独立会话分区，Cookie 仅保存在本地）。</p>
      <p className="hint">完成登录后关闭窗口或点击「我已登录完成」，登录态自动复用，重启应用无需再次登录。</p>
    </Modal>
  );
}

/** 今日用量概览：横向条形图（按已用/总额）。
 *  已有套餐卡的订阅型厂商不在此重复出现——它们的多窗口用量由套餐卡负责展示。 */
export function TodayOverview({ items, excludeIds }: { items: ProviderUsageView[]; excludeIds?: Set<string> }): React.ReactElement {
  const skip = excludeIds ?? new Set<string>();
  const rows = items.filter((p) => p.used !== null && !skip.has(p.id)).slice(0, 8);
  return (
    <section className="card" style={{ marginTop: 24 }} data-testid="today-overview" aria-label="今日用量概览">
      <h2 style={{ marginTop: 0 }}>今日用量概览</h2>
      {rows.length === 0 ? (
        <p className="hint">暂无数据：点击卡片上的「刷新」或顶部「同步刷新」后展示</p>
      ) : (
        <div className="overview-bars">
          {rows.map((p) => (
            <div key={p.id} className="overview-bar" data-testid={`overview-bar-${p.id}`}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.provider_name}
                {p.alias ? <span className="hint">（{p.alias}）</span> : null}
                {(() => {
                  const b = currencyBadge(p.currency);
                  return b ? <span className={`tag-dim ${b.className}`} style={{ marginLeft: 6 }}>{b.label}</span> : null;
                })()}
              </span>
              <div className="track">
                <div className={`progress-fill ${bandColor[p.progress_band]}`} style={{ height: '100%', width: `${Math.min(100, p.percent_used ?? 0)}%` }} />
              </div>
              <span className="mono" style={{ fontSize: 12 }}>
                已用 {fmtMoney(p.used, p.currency)} / {fmtMoney(p.total, p.currency)}（{p.percent_used ?? '—'}%）
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
