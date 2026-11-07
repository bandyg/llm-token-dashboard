import { Adapter, AdapterCredentials, FetchLikeContext, NormalizedUsage, QuotaWindowOut, SubscriptionOut, AdapterError, fetchJson, num } from './types';

/**
 * MiniMax Token Plan 适配器。
 *
 * 与智谱的关键差异：额度接口**不接受 API Key**，只认网页登录 Cookie。
 * 端点均挂在 host 根的 /backend/account/ 下，未登录时返回 HTTP 200 + base_resp.status_code=1004，
 * 因此不能只看 HTTP 状态判断成败。
 *
 * 订阅额度（主路径，实测自控制台「套餐用量」页）：
 *   GET {host}/backend/account/token_plan/remains_percent
 *     model_remains[] 按模型分类：
 *       general → current_interval_used_percent（5h 限额）+ current_weekly_used_percent（周限额）
 *                  end_time / weekly_end_time 为下次重置（epoch ms）
 *       video   → 赠送视频次数（count 口径，-1 表示该维度不适用）
 *     百分比字段是 "38%" 这样的字符串，需剥掉 % 再转数字。
 *
 * 积分余额（补充路径，订阅到期后按量计费才用得上）：
 *   GET {host}/backend/account/token_plan_credit → total_credits / used_credits / remaining_credits
 */
export const minimaxAdapter: Adapter = {
  id: 'minimax',
  async fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage> {
    const host = resolveHost(cred);
    const cookie = (cred.cookie ?? '').trim();
    if (!cookie) {
      // 明确要求登录态，避免「探活成功但全 null」那种静默失败
      throw new AdapterError('auth_expired', 'MiniMax 额度接口需要网页登录 Cookie，请先在卡片上「登录」导入浏览器会话');
    }
    const headers: Record<string, string> = {
      Cookie: cookie,
      Accept: 'application/json',
      Referer: `${host}/`,
      Origin: host,
    };
    if (cred.apiKey) headers.Authorization = `Bearer ${cred.apiKey}`;

    // 主路径：订阅额度窗口
    const data = (await fetchJson(ctx, `${host}/backend/account/token_plan/remains_percent`, { headers })) as {
      base_resp?: { status_code?: number; status_msg?: string };
      model_remains?: MiniMaxModelRemains[];
    };

    const code = num(data.base_resp?.status_code);
    if (code !== null && code !== 0) {
      throw new AdapterError(
        'auth_expired',
        `MiniMax 会话失效 (${code})：${data.base_resp?.status_msg ?? 'not login'}，请重新登录导入 Cookie`,
        code,
      );
    }

    const models = data.model_remains ?? [];
    if (!models.length) throw new AdapterError('parse_error', 'MiniMax 未返回任何额度窗口，请确认已开通 Token Plan 订阅');

    const windows = buildWindows(models);
    if (!windows.length) throw new AdapterError('parse_error', 'MiniMax 额度响应中没有可识别的额度窗口');

    // 顶层汇总取最紧张的窗口
    const top = [...windows].sort((a, b) => (b.percent_used ?? -1) - (a.percent_used ?? -1))[0];

    // 积分余额是补充信息，失败不影响订阅额度展示。
    // 套餐名/续费日期：控制台未开放对应端点（bundle 里 /backend/account/token_plan 仅为前缀，
    // 实际调用均带子路径，无独立套餐信息端点），故此处只标记产品线，不臆造档位与续费日期。
    let subscription: SubscriptionOut | null = {
      product_name: 'MiniMax Token Plan',
      level: null,
      status: 'VALID',
      valid_from: null,
      valid_to: null,
      next_renew_at: null,
      auto_renew: 0,
      billing_cycle: null,
      raw: null,
    };
    try {
      const credit = (await fetchJson(ctx, `${host}/backend/account/token_plan_credit`, { headers })) as {
        total_credits?: unknown;
        used_credits?: unknown;
        remaining_credits?: unknown;
      };
      const total = num(credit.total_credits);
      const used = num(credit.used_credits);
      const remaining = num(credit.remaining_credits);
      // 积分有余额时作为补充窗口展示；全 0（订阅制走限额而非积分）则不占位
      if (remaining !== null && remaining > 0) {
        windows.push({
          window_key: 'credit',
          window_label: '积分余额',
          percent_used: total !== null && total > 0 && used !== null ? (used / total) * 100 : null,
          used,
          remaining,
          total,
          unit: '次',
          reset_at: null,
        });
      }
    } catch {
      // 积分端点不可用属正常（部分账号无积分体系）
    }

    return {
      used: top.percent_used !== null ? top.percent_used : null,
      remaining: null,
      total: null,
      currency: 'PERCENT',
      reset_at: windows.find((w) => w.reset_at)?.reset_at ?? null,
      account_preview: 'minimax-token-plan',
      windows,
      subscription,
    };
  },
};

interface MiniMaxModelRemains {
  model_name?: string;
  start_time?: unknown;
  end_time?: unknown;
  remains_time?: unknown;
  current_interval_total_count?: unknown;
  current_interval_used_count?: unknown;
  current_interval_remains_count?: unknown;
  current_interval_used_percent?: unknown;
  current_interval_total_percent?: unknown;
  weekly_start_time?: unknown;
  weekly_end_time?: unknown;
  weekly_remains_time?: unknown;
  current_weekly_total_count?: unknown;
  current_weekly_used_count?: unknown;
  current_weekly_remains_count?: unknown;
  current_weekly_used_percent?: unknown;
  current_weekly_total_percent?: unknown;
}

/** 国内站 api.minimaxi.com → www.minimaxi.com；国际站 api.minimax.io → www.minimax.io */
function resolveHost(cred: AdapterCredentials): string {
  const fromExtra = cred.extra?.host?.trim();
  if (fromExtra) return fromExtra.replace(/\/+$/, '');
  try {
    const u = new URL(cred.baseUrl);
    const root = u.hostname.replace(/^(api|platform)\./, '');
    return `https://www.${root}`;
  } catch {
    return 'https://www.minimaxi.com';
  }
}

/**
 * "38%" / 38 / "0.38" 统一转成 0-100 的数字；无法解析或越界返回 null。
 * -1 表示该维度不适用（如订阅制没有次数口径），必须当 null 处理而非 0%。
 */
function pct(raw: unknown): number | null {
  if (typeof raw === 'string') {
    const s = raw.trim().replace(/%$/, '');
    if (!s || s === '-1') return null;
    const v = Number(s);
    if (!Number.isFinite(v) || v < 0) return null;
    return v > 100 ? null : Math.round(v * 10) / 10;
  }
  const v = num(raw);
  if (v === null || v < 0 || v > 100) return null;
  return Math.round(v * 10) / 10;
}

function epochMs(raw: unknown): string | null {
  const v = num(raw);
  if (v === null || v <= 0) return null;
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
}

/**
 * 归一化额度窗口。
 * 控制台「套餐用量」页按 model_name 分组展示（general / video / …），
 * 但对 Coding 场景有意义的是 general 的 5 小时与周限额——其余模型维度是
 * 视频/图像等赠送次数，与额度监控无关，默认不展示（避免 4 张几乎全满的卡挤占版面）。
 * 非 general 维度仅在用户账号确实存在对应消耗时才有参考价值，这里保持过滤。
 */
function buildWindows(models: MiniMaxModelRemains[]): QuotaWindowOut[] {
  const out: QuotaWindowOut[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const key = m.model_name ?? 'general';
    // 只取 general（语言模型）限额，其余维度忽略
    if (key !== 'general') continue;

    const intervalPct = pct(m.current_interval_used_percent);
    if (intervalPct !== null && !seen.has('five_hour')) {
      out.push({
        window_key: 'five_hour',
        window_label: '5 小时限额',
        percent_used: intervalPct,
        used: null,
        remaining: null,
        total: null,
        unit: '%',
        reset_at: epochMs(m.end_time),
      });
      seen.add('five_hour');
    }

    const weeklyPct = pct(m.current_weekly_used_percent);
    if (weeklyPct !== null && !seen.has('weekly')) {
      out.push({
        window_key: 'weekly',
        window_label: '周限额',
        percent_used: weeklyPct,
        used: null,
        remaining: null,
        total: null,
        unit: '%',
        reset_at: epochMs(m.weekly_end_time),
      });
      seen.add('weekly');
    }
  }
  return out;
}
