import { Adapter, AdapterCredentials, AdapterError, FetchLikeContext, NormalizedUsage, fetchJson, num } from './types';

/**
 * OpenAI 官方用量适配器。
 * 主路径：GET {base}/v1/dashboard/billing/subscription（total_granted / total_used / total_available）
 * 兜底：GET {base}/v1/organization/costs?start_date&end_date（汇总 amount.value 为已用）
 */
export const openaiAdapter: Adapter = {
  id: 'openai',
  async fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage> {
    const base = cred.baseUrl.replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${cred.apiKey}` };
    // OpenAI 兼容厂商（智谱/通义/MiMo 等）走 POST probePath 探活试键；非 2xx → 抛错。
    const probePath = cred.extra?.probePath;
    if (probePath) {
      const path = probePath.startsWith('/') ? probePath : `/${probePath}`;
      // 直接复用 fetchJson 的语义：401/403 抛 auth_expired；其它非 2xx 抛 adapter_upstream_error
      try {
        await fetchJson(ctx, `${base}${path}`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'ping', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        });
        return { used: null, remaining: null, total: null, account_preview: cred.extra?.accountLabel ?? 'openai-compatible' };
      } catch (probeErr) {
        if (probeErr instanceof AdapterError && probeErr.code === 'auth_expired') throw probeErr;
        // probePath 走通但返回非 2xx：上游不可用，冒泡原 message（不要继续降级到 OpenAI billing）
        throw new AdapterError('adapter_upstream_error', `probe ${path} ${(probeErr as Error).message}`, (probeErr as AdapterError).upstreamStatus);
      }
    }
    try {
      const data = (await fetchJson(ctx, `${base}/v1/dashboard/billing/subscription`, { headers })) as Record<
        string,
        unknown
      >;
      const total = num(data.total_granted) ?? num(data.hard_limit_usd);
      const used = num(data.total_used);
      const available = num(data.total_available);
      const remaining = available ?? (total !== null && used !== null ? total - used : null);
      return {
        used,
        remaining,
        total,
        currency: 'USD',
        reset_at: (data.access_until as string) ?? null,
        account_preview: (data.plan as string) ?? 'openai',
      };
    } catch (subErr) {
      // 凭据错误直接上抛（不降级）；订阅端点不可用时降级 organization/costs（近 30 天）
      if (subErr instanceof AdapterError && subErr.code === 'auth_expired') throw subErr;
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const data = (await fetchJson(
        ctx,
        `${base}/v1/organization/costs?start_date=${iso(start)}&end_date=${iso(end)}`,
        { headers },
      )) as { data?: { amount?: { value?: unknown; currency?: string } }[] };
      const rows = data.data ?? [];
      const used = rows.reduce((acc, r) => acc + (num(r.amount?.value) ?? 0), 0);
      return { used, remaining: null, total: null, currency: 'USD' };
    }
  },
};
