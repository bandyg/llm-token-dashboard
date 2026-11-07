import { Adapter, AdapterCredentials, FetchLikeContext, NormalizedUsage, QuotaWindowOut, AdapterError, fetchJson, num } from './types';

/**
 * 小米 MiMo 适配器（结构实测自真实控制台响应，并与官方 mimo-cli 的 quota 实现交叉验证）。
 *
 * 与 OpenAI 兼容网关不同：额度接口只认网页登录 Cookie，不认 API Key。
 * 控制台接口挂在 platform.xiaomimimo.com/api/v1 下，未登录时返回 HTTP 401 + { code: 401 }。
 * 必需 Cookie：api-platform_serviceToken、userId（api-platform_ph / _slh 可选）。
 *
 * 关键：套餐额度与账户余额【互不排斥】——TokenPlan 订阅用户同时也有余额（赠送金），
 * 且余额是唯一的 CNY 口径读数。所以两个端点都读，按可用性合并为多窗口，
 * 而不是按 API Key 前缀二选一（用户没填 Key 时会误显示余额、掩盖套餐额度）。
 *
 *   GET /api/v1/tokenPlan/usage → data.usage.items[]: { name, used, limit, percent }
 *        plan_total_token（套餐额度）/ compensation_total_token（补偿额度）
 *        percent 是已用比例(0-1)；另有 data.monthUsage（自然月口径），不参与展示
 *   GET /api/v1/balance → data: { balance, cashBalance, giftBalance, frozenBalance, currency }
 *        值是字符串（如 "5.00"），且余额随时可充值 → 无「总额」概念，只展示 remaining
 */
export const mimoAdapter: Adapter = {
  id: 'xiaomi-mimo',
  async fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage> {
    const base = apiBase(cred);
    const cookie = (cred.cookie ?? '').trim();
    if (!cookie) {
      throw new AdapterError('auth_expired', 'MiMo 额度接口需要网页登录 Cookie，请先在卡片上「登录」导入浏览器会话');
    }
    const headers: Record<string, string> = {
      Cookie: cookie,
      Accept: 'application/json',
      Referer: 'https://platform.xiaomimimo.com/',
      'User-Agent': 'llm-token-dashboard/1.0',
    };
    if (cred.apiKey) headers.Authorization = `Bearer ${cred.apiKey}`;

    // 两个端点独立采集：任一失败不影响另一个，避免套餐用户因余额端点异常而丢套餐额度
    const planResult = await tryFetch(ctx, `${base}/tokenPlan/usage`, headers);
    const balanceResult = await tryFetch(ctx, `${base}/balance`, headers);

    const plan = planResult.data ? fromTokenPlan(planResult.data) : null;
    const bal = balanceResult.data ? fromBalance(balanceResult.data) : null;

    if (!plan && !bal) {
      // 两端点都失败：优先抛鉴权类错误（登录失效），否则报解析失败
      const authErr = [planResult.error, balanceResult.error].find((e) => e?.code === 'auth_expired');
      throw authErr ?? new AdapterError('parse_error', 'MiMo 未返回任何额度数据，请确认已登录且账号状态正常');
    }

    const windows = [...(plan?.windows ?? []), ...(bal?.windows ?? [])];
    if (!windows.length) {
      throw new AdapterError('parse_error', 'MiMo 未返回可识别的额度数据');
    }
    // 顶部汇总取最紧张的窗口；订阅制优先用套餐口径（余额可随时充值，不代表紧张程度）
    const top = [...(plan?.windows ?? windows)].sort((a, b) => (b.percent_used ?? -1) - (a.percent_used ?? -1))[0];

    return {
      used: top.used,
      remaining: top.remaining,
      total: top.total,
      currency: plan ? 'CREDIT' : (bal?.currency ?? 'CNY'),
      reset_at: plan?.reset_at ?? null,
      account_preview: plan ? 'mimo-token-plan' : 'mimo-payg',
      windows,
      subscription: null,
    };
  },
};

/** 采集单个端点，把失败转成结构化结果而非直接抛，保证两端点互不影响 */
async function tryFetch(
  ctx: FetchLikeContext,
  url: string,
  headers: Record<string, string>,
): Promise<{ data: Record<string, unknown> | null; error: AdapterError | null }> {
  try {
    const payload = (await fetchJson(ctx, url, { headers })) as { code?: number; data?: Record<string, unknown> };
    if (payload.code !== undefined && num(payload.code) !== 0) {
      return { data: null, error: new AdapterError('auth_expired', `MiMo 会话失效 (${payload.code})，请重新登录导入 Cookie`, num(payload.code) ?? undefined) };
    }
    return { data: payload.data ?? {}, error: null };
  } catch (e) {
    return { data: null, error: e instanceof AdapterError ? e : new AdapterError('network', (e as Error).message) };
  }
}

/** API 网关 baseUrl（api. 或 token-plan-cn. 开头）→ 控制台接口 base */
function apiBase(cred: AdapterCredentials): string {
  const fromExtra = cred.extra?.consoleBase?.trim();
  if (fromExtra) return fromExtra.replace(/\/+$/, '');
  return 'https://platform.xiaomimimo.com/api/v1';
}

/** TokenPlan 套餐额度（credits）。返回 null 表示无套餐数据（按量计费账号属正常）。 */
function fromTokenPlan(d: Record<string, unknown>): { windows: QuotaWindowOut[]; reset_at: string | null } | null {
  const usage = (d.usage ?? {}) as Record<string, unknown>;
  const items = Array.isArray(usage.items) ? (usage.items as Record<string, unknown>[]) : [];
  if (!items.length) return null;

  // 仅取额度维度；rpm/concurrency 等速率项不是额度，不展示
  const wanted: { name: string; label: string }[] = [
    { name: 'plan_total_token', label: '套餐额度' },
    { name: 'compensation_total_token', label: '补偿额度' },
  ];
  const windows: QuotaWindowOut[] = [];
  for (const w of wanted) {
    const item = items.find((i) => i?.name === w.name);
    if (!item) continue;
    const used = num(item.used);
    const limit = num(item.limit);
    if (used === null && limit === null) continue;
    // limit 为 0（如未获赠补偿额度）时无展示价值，跳过避免出现「0 / 0」空卡
    if (limit !== null && limit <= 0) continue;
    const percent = num(item.percent);
    const usedPct = percent !== null ? percent * 100 : limit && used !== null ? (used / limit) * 100 : null;
    windows.push({
      window_key: w.name,
      window_label: w.label,
      percent_used: usedPct === null ? null : Math.round(usedPct * 10) / 10,
      used,
      remaining: used !== null && limit !== null ? Math.max(limit - used, 0) : null,
      total: limit,
      unit: 'CREDIT',
      reset_at: epochStr(usage.resetTime ?? usage.reset_time ?? d.resetTime ?? d.reset_time),
    });
  }
  return windows.length ? { windows, reset_at: windows.find((w) => w.reset_at)?.reset_at ?? null } : null;
}

/** 账户余额（货币）。值是字符串需转换；余额可随时充值，无「总额」概念，只展示 remaining。 */
function fromBalance(d: Record<string, unknown>): { windows: QuotaWindowOut[]; currency: string } | null {
  const balance = num(d.balance);
  if (balance === null) return null;
  const cash = num(d.cashBalance);
  const gift = num(d.giftBalance);
  const frozen = num(d.frozenBalance);
  const currency = (d.currency as string) ?? 'CNY';

  const windows: QuotaWindowOut[] = [
    { window_key: 'balance', window_label: '账户余额', percent_used: null, used: cash, remaining: balance, total: null, unit: currency, reset_at: null },
  ];
  // 赠送金通常已包含在 balance 里，单独列出会重复计数，故只在余额为 0 且有赠送时提示
  if (gift !== null && gift > 0 && balance <= 0) {
    windows.push({ window_key: 'gift', window_label: '赠送额度', percent_used: null, used: null, remaining: gift, total: null, unit: currency, reset_at: null });
  }
  if (frozen !== null && frozen > 0) {
    windows.push({ window_key: 'frozen', window_label: '冻结额度', percent_used: null, used: null, remaining: frozen, total: null, unit: currency, reset_at: null });
  }
  return { windows, currency };
}

function epochStr(raw: unknown): string | null {
  const v = num(raw);
  if (v === null || v <= 0) return null;
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
}
