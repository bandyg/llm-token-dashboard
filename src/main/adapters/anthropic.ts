import { Adapter, AdapterCredentials, FetchLikeContext, NormalizedUsage, fetchJson, num } from './types';

/**
 * Anthropic 官方用量适配器（Admin API）。
 * GET {base}/v1/organizations/usage_report/messages?starting_on=&ending_on=
 * 响应 data[]: { date, usage: { input, output }, costUSD }
 * used = Σ costUSD；remaining = provider 配置的 quota_total - used（由编排器补齐）。
 */
export const anthropicAdapter: Adapter = {
  id: 'anthropic',
  async fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage> {
    const base = cred.baseUrl.replace(/\/+$/, '');
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const data = (await fetchJson(
      ctx,
      `${base}/v1/organizations/usage_report/messages?starting_on=${iso(start)}&ending_on=${iso(end)}`,
      {
        headers: {
          'x-api-key': cred.apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
    )) as { data?: { usage?: { input?: unknown; output?: unknown }; costUSD?: unknown }[] };
    const rows = data.data ?? [];
    let usedInput = 0;
    let usedOutput = 0;
    let usedCost = 0;
    for (const r of rows) {
      usedInput += num(r.usage?.input) ?? 0;
      usedOutput += num(r.usage?.output) ?? 0;
      usedCost += num(r.costUSD) ?? 0;
    }
    return {
      used: usedCost,
      used_input: usedInput,
      used_output: usedOutput,
      remaining: null,
      total: null,
      currency: 'USD',
    };
  },
};
