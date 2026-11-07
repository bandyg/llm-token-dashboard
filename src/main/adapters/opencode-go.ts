import { Adapter, AdapterCredentials, FetchLikeContext, NormalizedUsage, QuotaWindowOut, fetchJson, num } from './types';

/**
 * OpenCode Zen / Go 适配器。
 *
 * 与智谱、MiniMax、MiMo 不同：**额度接口认 API Key，无需网页 Cookie**，
 * 是这几家里接入成本最低的。
 *
 *   GET {base}/zen/go/v1/usage      Go 订阅的三窗口用量
 *   GET {base}/zen/v1/credits      Zen 账户余额（按量计费 / 超额后回退用）
 *
 * usage 响应结构（已对真实接口验证）：
 *   { usage: { rolling: {...}, weekly: {...}, monthly: {...} } }
 *   每个窗口含 percent（已用百分比 0-100）、resetsAt（ISO 重置时间）与 status。
 *
 * 限额以美元计价：Go 为 5 小时 $12 / 每周 $30 / 每月 $60（Go Plus 更高档位不同，
 * 但接口只返回百分比，金额需在控制台查看，故此处不硬编码金额）。
 */
export const opencodeGoAdapter: Adapter = {
  id: 'opencode',
  async fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage> {
    const base = zenBase(cred);
    const headers: Record<string, string> = { Authorization: `Bearer ${cred.apiKey}`, Accept: 'application/json' };

    // 三窗口是主路径；余额是补充（Zen 按量账户），失败不影响窗口展示
    const usagePayload = (await fetchJson(ctx, `${base}/zen/go/v1/usage`, { headers })) as {
      usage?: Record<string, ZenWindow> | null;
    };
    const windows = buildWindows(usagePayload.usage ?? {});
    if (!windows.length) {
      throw new (await import('./types')).AdapterError(
        'parse_error',
        'OpenCode 未返回额度窗口，请确认该 Key 已订阅 Go（Go 是订阅制，未订阅时 usage 为空）',
      );
    }

    const top = [...windows].sort((a, b) => (b.percent_used ?? -1) - (a.percent_used ?? -1))[0];

    // Zen 余额：超额后可在控制台开启「使用余额」回退，这里只展示当前余额
    try {
      const credit = (await fetchJson(ctx, `${base}/zen/v1/credits`, { headers })) as Record<string, unknown>;
      const balance = num(credit.balance);
      if (balance !== null) {
        windows.push({
          window_key: 'zen_balance',
          window_label: 'Zen 余额',
          percent_used: null,
          used: null,
          remaining: balance,
          total: null,
          unit: 'USD',
          reset_at: null,
        });
      }
    } catch {
      // 未订阅 Zen 或端点不可用属正常，窗口数据已足够
    }

    return {
      // 该端点只给百分比，不给绝对美元金额，故不伪造 used/total
      used: top.percent_used,
      remaining: null,
      total: null,
      currency: 'PERCENT',
      reset_at: windows.find((w) => w.reset_at)?.reset_at ?? null,
      account_preview: 'opencode-go',
      windows,
      subscription: null,
    };
  },
};

interface ZenWindow {
  percent?: unknown;
  used?: unknown;
  limit?: unknown;
  reset?: unknown;
  reset_at?: unknown;
  resets_at?: unknown;
  /** 真实接口用 camelCase */
  resetsAt?: unknown;
  next_reset?: unknown;
}

/** window_key → 展示名（与官方 TUI 插件一致的口径） */
const WINDOW_LABELS: [string, string][] = [
  ['rolling', '5 小时限额'],
  ['weekly', '每周限额'],
  ['monthly', '每月限额'],
];

function zenBase(cred: AdapterCredentials): string {
  const fromExtra = cred.extra?.zenBase?.trim();
  if (fromExtra) return fromExtra.replace(/\/+$/, '');
  try {
    // baseUrl 形如 https://opencode.ai/zen/v1 → 取 origin
    return new URL(cred.baseUrl).origin;
  } catch {
    return 'https://opencode.ai';
  }
}

/** "38%" / 38 → 0-100；越界视为异常返回 null */
function pct(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const v = typeof raw === 'string' ? Number(raw.trim().replace(/%$/, '')) : num(raw);
  if (v === null || !Number.isFinite(v) || v < 0 || v > 100) return null;
  return Math.round(v * 10) / 10;
}

function iso(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function buildWindows(usage: Record<string, ZenWindow>): QuotaWindowOut[] {
  const out: QuotaWindowOut[] = [];
  for (const [key, label] of WINDOW_LABELS) {
    const w = usage[key];
    if (!w) continue;
    const used = pct(w.percent);
    if (used === null) continue;
    out.push({
      window_key: key === 'rolling' ? 'five_hour' : key,
      window_label: label,
      percent_used: used,
      used: null,
      remaining: null,
      total: null,
      unit: '%',
      reset_at: iso(w.resetsAt ?? w.reset ?? w.reset_at ?? w.resets_at ?? w.next_reset),
    });
  }
  return out;
}
