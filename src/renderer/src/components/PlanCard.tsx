import React from 'react';
import type { ProviderUsageView, QuotaWindow } from '../../../shared/types';
import { MONEY_UNITS, fmtCnDate, fmtMoney, fmtRelative, windowBarColor, windowPrimary, windowRemainingPct } from '../utils';
import { Spinner } from './common';
import type { MenuItem } from './common';

/**
 * 统一 Provider 卡片。
 *
 * 所有厂商都用同一张卡渲染：订阅型（智谱/MiniMax 等有多额度窗口的）展示逐窗口卡片，
 * 单额度厂商（OpenAI/DeepSeek 等余额或 token 口径）展示等价的单窗口卡片，视觉与操作完全一致。
 *
 * 保留了原 provider-card 的全部交互与 testid 契约（复选框、状态点、右键菜单、登录、手动录入、
 * 进度条、错误提示），因此替换渲染层不会造成功能回退。
 */

/** 窗口展示顺序：5 小时 → 每周 → 月度 MCP → 其它 */
const WINDOW_ORDER: Record<string, number> = { five_hour: 0, weekly: 1, monthly_mcp: 2, monthly: 3 };

/** 外壳配色索引：按 provider id 稳定散列到 6 色面板（纯装饰，不承载语义） */
function accentIndex(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 6;
}

export function sortWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) => {
    const ra = WINDOW_ORDER[a.window_key] ?? 90;
    const rb = WINDOW_ORDER[b.window_key] ?? 90;
    return ra - rb;
  });
}

/** 额度维度徽章 */
function currencyBadge(currency: string): { label: string; className: string } | null {
  const c = currency.toUpperCase();
  if (c === 'USD') return { label: 'USD', className: 'usd' };
  if (c === 'CNY') return { label: 'CNY', className: 'cny' };
  if (c === 'TOKEN') return { label: 'TOKEN', className: 'token' };
  if (c === 'CREDIT') return { label: 'CREDIT', className: 'credit' };
  if (c === 'PERCENT') return { label: '百分比', className: 'percent' };
  if (c === 'COUNT') return { label: '次数', className: 'count' };
  return null;
}

export function PlanCard({
  p,
  onRefresh,
  onEdit,
  onLogin,
  onManualEntry,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDelete,
  onToggleEnabled,
  loading,
  collapsed,
  onToggle,
  checked,
  onCheck,
}: {
  p: ProviderUsageView;
  onRefresh?: () => void;
  onEdit?: () => void;
  onLogin?: () => void;
  onManualEntry?: () => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent, items: MenuItem[]) => void;
  onDelete?: () => void;
  onToggleEnabled?: () => void;
  loading?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  checked?: boolean;
  onCheck?: (c: boolean) => void;
}): React.ReactElement {
  const sub = p.subscription;
  const windows = sortWindows(p.windows ?? []);
  // 无订阅信息时以 provider 名为标题，避免多窗口厂商都显示成「智谱」这类重复标题
  const planName = sub?.product_name ?? sub?.level ?? null;
  const title = planName ?? p.provider_name;
  const renewDate = fmtCnDate(sub?.next_renew_at);
  const cycleLabel = sub?.billing_cycle === 'annually' ? '年付' : sub?.billing_cycle === 'monthly' ? '月付' : sub?.billing_cycle === 'quarterly' ? '季付' : null;
  const badge = currencyBadge(p.currency);
  const statusDot = p.status === 'failed' ? 'err' : p.alert ? 'warn' : p.status === 'never' ? 'idle' : 'ok';
  const statusText = p.status === 'failed' ? '抓取失败' : p.alert ? '额度告警' : p.status === 'never' ? '未采集' : '正常';

  // 单额度厂商合成为一个窗口卡片，视觉与多窗口厂商一致
  const effectiveWindows: QuotaWindow[] = windows.length
    ? windows
    : [
        {
          id: `${p.id}-single`,
          snapshot_id: '',
          provider_id: p.id,
          window_key: 'single',
          window_label: '剩余额度',
          percent_used: p.percent_used,
          used: p.used,
          remaining: p.remaining,
          total: p.total,
          unit: p.currency === 'COUNT' ? '次' : '%',
          reset_at: null,
          collected_at: p.collected_at ?? '',
        },
      ];
  const hasRealData = p.percent_used !== null || p.used !== null || p.remaining !== null;

  const clickTimer = React.useRef<number>(0);
  const handleClick = (): void => {
    if (!onClick) return;
    window.clearTimeout(clickTimer.current);
    clickTimer.current = window.setTimeout(onClick, 220);
  };

  return (
    <div
      className={`plan-card${p.status === 'failed' ? ' failed' : ''}${p.alert ? ' alert-bg' : ''}${collapsed ? ' collapsed' : ''}`}
      data-accent={accentIndex(p.id)}
      data-testid={`provider-card-${p.id}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={`${p.provider_name} ${p.alias} 卡片`}
      onClick={handleClick}
      onDoubleClick={() => {
        window.clearTimeout(clickTimer.current);
        onDoubleClick?.();
      }}
      onKeyDown={(e) => {
        if (!onClick || e.target !== e.currentTarget) return;
        if (e.key === 'Enter') onClick();
        else if (e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={
        onContextMenu
          ? (e) =>
              onContextMenu(e, [
                { label: '立即刷新', onClick: () => onRefresh?.() },
                { label: '编辑配置', onClick: () => onEdit?.() },
                {
                  label: p.enabled ? '禁用' : '启用',
                  onClick: () => onToggleEnabled?.(),
                },
                ...(onDelete
                  ? [{ label: '删除', danger: true, onClick: () => onDelete() } as MenuItem]
                  : []),
              ])
          : undefined
      }
    >
      <div className="plan-head">
        <div className="plan-title-row">
          {onCheck ? (
            <input
              type="checkbox"
              aria-label={`选中 ${p.provider_name}`}
              data-testid={`card-check-${p.id}`}
              checked={!!checked}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onCheck(e.target.checked)}
            />
          ) : null}
          <span role="img" className={`status-dot ${statusDot}`} aria-label={`状态：${statusText}`} />
          <span className="plan-title-name-col">
            <button
              className="plan-toggle"
              aria-expanded={!collapsed}
              aria-label={collapsed ? `展开 ${title}` : `折叠 ${title}`}
              data-testid={`plan-toggle-${p.id}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle?.();
              }}
              disabled={!onToggle}
            >
              <span className="plan-caret" aria-hidden>{collapsed ? '▸' : '▾'}</span>
              <span className="plan-name" data-testid={`plan-name-${p.id}`} title={title}>
                {title}
                {/* alias 与套餐名重复时不再重复展示（如「MiniMax Token Plan（Token Plan）」） */}
                {p.alias && !title.toLowerCase().includes(p.alias.toLowerCase()) ? (
                  <span className="hint">（{p.alias}）</span>
                ) : null}
              </span>
            </button>
            {/* 折叠态：额度维度是次要信息，缩成名字下方的小铭牌，把横向空间让给 usage */}
            {collapsed && badge ? (
              <span className={`tag-dim ${badge.className}`} data-testid={`currency-badge-${p.id}`} title={`额度维度：${badge.label}`}>
                {badge.label}
              </span>
            ) : null}
          </span>
          {/* 展开态：徽章仍在名字右侧同行 */}
          {!collapsed && badge ? (
            <span className={`tag-dim ${badge.className}`} data-testid={`currency-badge-${p.id}`} title={`额度维度：${badge.label}`}>
              {badge.label}
            </span>
          ) : null}
          {/* 折叠态：卡片已加宽加高，逐窗口展示「百分比 + 绝对值 + 重置时间」，
              不再压缩成单个百分比，避免浪费横向空间 */}
          {collapsed && hasRealData ? (
            <span className="plan-collapsed-summary" data-testid={`plan-summary-${p.id}`}>
              {effectiveWindows.map((w) => (
                <CollapsedWindow key={w.window_key} w={w} />
              ))}
            </span>
          ) : null}
          {/* 右侧操作区成组：状态标签（告警/手动覆盖/订阅异常）+ spinner + 登录/刷新/编辑。
              状态标签放在预留宽度的操作区内 —— 告警态也不会推挤左边的 LCD 读数框对齐。 */}
          <span className="plan-title-actions">
            {/* 「生效中」只在异常时提示：正常是默认状态，三个绿徽章并列纯属噪音 */}
            {sub?.status && sub.status !== 'VALID' ? (
              <span className="plan-badge warn">{sub.status}</span>
            ) : null}
            {p.alert ? <span className="tag alert">告警</span> : null}
            {p.status === 'manual-override' ? <span className="tag ok">手动覆盖</span> : null}
            {loading ? <Spinner dark /> : null}
            {p.auth_required ? (
              <button className="btn-danger icon-btn" data-testid={`card-login-${p.id}`} aria-label="手动登录" onClick={(e) => { e.stopPropagation(); onLogin?.(); }}>
                🔐 登录
              </button>
            ) : null}
            {onRefresh ? (
              <button className="icon-btn" data-testid={`plan-refresh-${p.id}`} aria-label={`刷新 ${p.provider_name}`} onClick={(e) => { e.stopPropagation(); onRefresh(); }} disabled={loading}>
                ⟳ 刷新
              </button>
            ) : null}
            {onEdit ? (
              <button className="icon-btn" data-testid={`card-edit-${p.id}`} aria-label={`编辑 ${p.provider_name}`} onClick={(e) => { e.stopPropagation(); onEdit(); }}>
                ✎ 编辑
              </button>
            ) : null}
          </span>
        </div>

        {!collapsed && renewDate ? (
          <div className="plan-meta">
            <span>
              续费 {renewDate}
              {cycleLabel ? ` · ${cycleLabel}` : ''}
              {sub?.auto_renew === 1 ? ' · 自动续费' : ''}
            </span>
            {sub?.valid_to ? <span className="hint">有效期至 {fmtCnDate(sub.valid_to) ?? sub.valid_to}</span> : null}
          </div>
        ) : null}
        {p.status === 'failed' && p.fail_reason ? (
          <div className="card-error-msg" data-testid={`card-error-msg-${p.id}`} title={p.fail_reason ?? ''}>
            ⚠️ 抓取失败：{p.fail_reason}
          </div>
        ) : null}
        {p.auth_required && p.status !== 'failed' ? (
          <div className="auth-required" data-testid={`card-auth-${p.id}`}>
            🔐 请手动登录
          </div>
        ) : null}
      </div>

      {collapsed ? null : loading ? (
        <div className="plan-windows">
          <div className="win-tile">
            <div className="skeleton" style={{ height: 14, width: '50%' }} />
            <div className="skeleton" style={{ height: 26, width: '35%' }} />
            <div className="skeleton" style={{ height: 6 }} />
          </div>
        </div>
      ) : (
        <>
          <div className="plan-section-label">{windows.length ? '剩余额度' : '额度'}</div>
          <div className="plan-windows" data-testid={`plan-windows-${p.id}`}>
            {hasRealData ? (
              effectiveWindows.map((w) => <WindowTile key={w.id || w.window_key} w={w} providerId={p.id} />)
            ) : (
              <div className="win-tile">
                <div className="win-label">剩余额度</div>
                <div className="win-value">—</div>
                <div className="hint" data-testid={`progress-text-${p.id}`}>
                  {p.auth_required ? '尚未采集：先登录后点「刷新」读取额度' : '尚未采集：点「刷新」读取额度'}
                </div>
                <div className="win-bar">
                  <div className="win-bar-fill win-bar-empty" style={{ width: 0 }} />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {collapsed ? null : (
        <div className="plan-foot">
          {/* 总额口径汇总：纯百分比维度（PERCENT）没有绝对值，改为「最紧窗口已用 X%」 */}
          {hasRealData ? (
            <span className="mono" data-testid={`plan-total-${p.id}`}>
              {p.currency === 'PERCENT'
                ? `最紧窗口已用 ${Math.round(p.percent_used ?? 0)}%`
                : `已用 ${fmtMoney(p.used, p.currency)} / ${fmtMoney(p.total, p.currency)}（${p.percent_used ?? '—'}%）`}
            </span>
          ) : null}
          <span className="hint">最近采集：{p.collected_at ? new Date(p.collected_at).toLocaleString() : '—'}</span>
          {p.status === 'failed' && onManualEntry ? (
            <button className="btn-danger icon-btn" data-testid={`card-manual-entry-${p.id}`} aria-label="手动录入" onClick={(e) => { e.stopPropagation(); onManualEntry(); }}>
              手动录入
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** 剩余百分比 → 水位语义类名（折叠摘要徽章用） */
function windowBandClass(pct: number | null): string {
  if (pct === null) return 'empty';
  if (pct > 50) return 'ok';
  if (pct > 20) return 'mid';
  return 'low';
}

/**
 * 折叠态的单个窗口：上排「标签 + 剩余百分比」，下排「绝对值 + 重置时间」。
 * 卡片加宽后横向空间充裕，把展开态才有的绝对值与重置时间也带到折叠态，
 * 不用点开就能判断「还剩多少」和「什么时候回补」。
 */
function CollapsedWindow({ w }: { w: QuotaWindow }): React.ReactElement {
  const pct = windowRemainingPct(w);
  const fmtUnit = MONEY_UNITS.has(w.unit) ? w.unit : 'COUNT';
  // 重置时间已过（如 5 小时窗口刚滚动）时 fmtRelative 返回「xx前」，那种情况下
  // 只显示日期即可，标「前」会被误读成过期告警
  const resetTs = w.reset_at ? new Date(w.reset_at).getTime() : NaN;
  const rel = fmtRelative(w.reset_at);
  const resetDate = Number.isFinite(resetTs)
    ? new Date(resetTs).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
    : null;
  const relForward = rel && resetTs > Date.now() ? rel : null;
  // 余额类窗口（无总额、无百分比，主读数已经是金额）第二行不再重复同一个数
  const showAmount = (w.remaining !== null || (w.total !== null && w.total > 0)) && pct !== null;
  return (
    <span className={`plan-mini ${windowBandClass(pct)}`}>
      <span className="plan-mini-head">
        <span className="plan-mini-label">{w.window_label.replace(/剩余|限额$/, '')}</span>
        <span className="plan-mini-value">{windowPrimary(w)}</span>
      </span>
      {/* 折叠态进度条：扫视时靠颜色直接判断水位，省去逐个读数字 */}
      <span className="plan-mini-bar" aria-hidden>
        <span className={`win-bar-fill ${windowBarColor(pct)}`} style={{ width: `${pct ?? 0}%` }} />
      </span>
      {showAmount || resetDate ? (
        <span className="plan-mini-sub">
          {showAmount ? (
            <span className="plan-mini-amount">
              {w.remaining !== null ? fmtMoney(w.remaining, fmtUnit) : '—'}
              {w.total !== null && w.total > 0 ? ` / ${fmtMoney(w.total, fmtUnit)}` : ''}
            </span>
          ) : null}
          {resetDate ? (
            <span className="plan-mini-reset" title={w.reset_at ?? ''}>
              ↻ {resetDate}
              {relForward ? ` ${relForward}` : ''}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function WindowTile({ w, providerId }: { w: QuotaWindow; providerId: string }): React.ReactElement {
  const pct = windowRemainingPct(w);
  const rel = fmtRelative(w.reset_at);
  const resetDate = w.reset_at ? new Date(w.reset_at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : null;
  const fmtUnit = MONEY_UNITS.has(w.unit) ? w.unit : 'COUNT';
  // 主读数已是百分比时，补一行绝对值，让「剩余多少」也能直接读到
  const showAmount = pct !== null && w.remaining !== null;
  return (
    <div className="win-tile" data-testid={`win-tile-${providerId}-${w.window_key}`}>
      <div className="win-label">
        {w.window_label}
        {w.unit === '次' ? <span className="win-unit">（{w.unit}）</span> : null}
      </div>
      <div className="win-value" data-testid={`win-value-${providerId}-${w.window_key}`}>
        {windowPrimary(w)}
      </div>
      {showAmount ? (
        <div className="win-amount">
          剩余 {fmtMoney(w.remaining, fmtUnit)}
          {w.total !== null && w.total > 0 ? ` / ${fmtMoney(w.total, fmtUnit)}` : null}
        </div>
      ) : null}
      {resetDate ? (
        <div className="win-reset" title={w.reset_at ?? ''}>
          {resetDate}
          {rel ? <span className="hint"> {rel}</span> : null}
        </div>
      ) : null}
      <div className="win-bar">
        <div className={`win-bar-fill ${windowBarColor(pct)}`} style={{ width: `${pct ?? 0}%` }} />
      </div>
    </div>
  );
}
