import { Adapter, AdapterCredentials, FetchLikeContext, NormalizedUsage, fetchJson, num } from './types';

/**
 * DeepSeek 官方余额适配器：GET {base}/user/balance
 * 响应 { balance_infos: [{ currency, total_balance, granted_balance }] }
 * remaining = total_balance；used 无法从该端点获得 → null（趋势按 remaining 画）。
 */
export const deepseekAdapter: Adapter = {
  id: 'deepseek',
  async fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage> {
    const base = cred.baseUrl.replace(/\/+$/, '');
    const data = (await fetchJson(ctx, `${base}/user/balance`, {
      headers: { Authorization: `Bearer ${cred.apiKey}` },
    })) as { balance_infos?: { currency?: string; total_balance?: unknown; granted_balance?: unknown }[] };
    const first = (data.balance_infos ?? [])[0];
    if (!first) return { used: null, remaining: null, total: null };
    return {
      used: null,
      remaining: num(first.total_balance),
      total: num(first.granted_balance),
      currency: (first.currency as string) ?? 'CNY',
    };
  },
};
