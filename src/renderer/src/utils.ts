import type { ProviderUsageView, QuotaWindow, UsageSnapshot } from '../../shared/types';

/** 把数值格式化为「5,000,000 / 5M / $5.00」等可读形式 */
export function fmtMoney(v: number | null, currency: string): string {
  if (v === null) return '—';
  // PERCENT 是纯百分比口径（MiniMax 订阅限额），没有绝对值可格式化
  if (currency === 'PERCENT') return `${v}%`;
  if (currency === 'TOKEN' || currency === 'COUNT' || currency === 'CREDIT') {
    const abs = Math.abs(v);
    // 大额 credits（如小米 TokenPlan 的 132,000,000,000）需要 B 档，否则会显示成 132000.00M
    if (abs >= 1_000_000_000_000) return `${(v / 1_000_000_000_000).toFixed(2)}T`;
    if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  }
  return `${currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''}${v.toFixed(2)}`;
}

/** 把 ISO 时间戳渲染成「4h12m」「2d3h」「已过」等人类可读相对时间；空值返回 null */
export function fmtRelative(target: string | null | undefined, now: Date = new Date()): string | null {
  if (!target) return null;
  const t = new Date(target).getTime();
  if (!Number.isFinite(t)) return null;
  const diffMs = t - now.getTime();
  const past = diffMs < 0;
  const abs = Math.abs(diffMs);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const d = Math.floor(abs / 86_400_000);
  let text: string;
  if (d >= 1) text = `${d}d${h % 24}h`;
  else if (h >= 1) text = `${h}h${m}m`;
  else text = `${m}m`;
  return past ? `${text}前` : `${text}后`;
}

/** 把 snapshot 渲染成 toast/detail 一行可读字符串：'已用 2.4M / 剩余 47.6M / 总 50M TOKENS（4h12m 后重置）' */
export function fmtSnapshotDetail(snap: UsageSnapshot | undefined | null): string | null {
  if (!snap) return null;
  const cur = snap.currency ?? 'USD';
  const used = fmtMoney(snap.used, cur);
  const rem = fmtMoney(snap.remaining, cur);
  const total = fmtMoney(snap.total, cur);
  const parts = [`已用 ${used}`, `剩余 ${rem}`, `总 ${total}`, cur];
  const rel = fmtRelative(snap.reset_at);
  return rel ? `${parts.join(' / ')}（${rel}重置）` : parts.join(' / ');
}

/** 窗口的剩余百分比：优先用 API 给的 percent_used 反推（百分比口径），否则按 absolute 值算 */
export function windowRemainingPct(w: QuotaWindow): number | null {
  if (w.unit === '%') {
    if (w.percent_used !== null) return Math.max(0, Math.min(100, 100 - w.percent_used));
    if (w.total !== null && w.total > 0 && w.remaining !== null) return Math.max(0, Math.min(100, (w.remaining / w.total) * 100));
    return null;
  }
  if (w.total !== null && w.total > 0 && w.remaining !== null) return Math.max(0, Math.min(100, (w.remaining / w.total) * 100));
  return null;
}

/** Provider 级剩余水位（Dashboard 卡片排序用）。
 *  多窗口厂商取最紧的一个窗口——短板决定「这家还能不能用」；
 *  单额度厂商用 percent_used 反推；两者都拿不到（纯余额/未采集/抓取失败）返回 null。 */
export function providerRemainingPct(p: ProviderUsageView): number | null {
  const winPcts = (p.windows ?? []).map(windowRemainingPct).filter((v): v is number => v !== null);
  if (winPcts.length > 0) return Math.min(...winPcts);
  if (p.percent_used !== null) return Math.max(0, Math.min(100, 100 - p.percent_used));
  return null;
}

/** 货币单位（余额类窗口），按 unit 正确套货币符号 */
export const MONEY_UNITS = new Set(['USD', 'CNY', 'EUR', 'JPY']);

/** 窗口的主读数。
 *  有可用百分比时优先显示百分比（一眼看出水位，且绝对值常大到难读，如 129.97B / 132.00B）；
 *  无百分比（余额类窗口，随充值变动、没有分母）才退回绝对值文本。 */
export function windowPrimary(w: QuotaWindow): string {
  const pct = windowRemainingPct(w);
  if (pct !== null) return `${Math.round(pct)}%`;
  if (w.remaining === null) return '—';
  // 货币口径必须用对应币种格式化，否则 ¥5 会退化成裸 5
  const fmtUnit = MONEY_UNITS.has(w.unit) ? w.unit : 'COUNT';
  if (w.total !== null && w.total > 0) return `${fmtMoney(w.remaining, fmtUnit)} / ${fmtMoney(w.total, fmtUnit)}`;
  return fmtMoney(w.remaining, fmtUnit);
}

/** 剩余百分比 → 进度条颜色：>50% 绿、>20% 橙、其余红（与截图的绿/绿/橙语义一致） */
export function windowBarColor(pct: number | null): string {
  if (pct === null) return 'win-bar-empty';
  if (pct > 50) return 'win-bar-ok';
  if (pct > 20) return 'win-bar-mid';
  return 'win-bar-low';
}

/** '2027-09-11' → '2027年9月11日'；'2027-09-11 10:00:00' → '2027年9月11日' */
export function fmtCnDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}