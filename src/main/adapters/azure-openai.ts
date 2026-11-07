import { Adapter, AdapterCredentials, FetchLikeContext, NormalizedUsage, fetchJson, num } from './types';

/**
 * Azure OpenAI 用量适配器。
 * 通过 ARM Usage API：GET https://management.azure.com/subscriptions/{sub}/providers/
 *   Microsoft.CognitiveServices/locations/{loc}/usages?api-version=2023-05-01
 * cred.apiKey = ARM 访问令牌；cred.extra.subscriptionId / location 必填。
 * 返回 value[]: { currentValue, limit, unit } → used = Σ currentValue，total = Σ limit。
 */
export const azureOpenAiAdapter: Adapter = {
  id: 'azure-openai',
  async fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage> {
    const sub = cred.extra?.subscriptionId;
    const loc = cred.extra?.location;
    if (!sub || !loc) {
      throw new (await import('./types')).AdapterError('parse_error', 'Azure 适配器需要 subscriptionId 与 location 参数');
    }
    const url = `https://management.azure.com/subscriptions/${encodeURIComponent(
      sub,
    )}/providers/Microsoft.CognitiveServices/locations/${encodeURIComponent(loc)}/usages?api-version=2023-05-01`;
    const data = (await fetchJson(ctx, url, {
      headers: { Authorization: `Bearer ${cred.apiKey}` },
    })) as { value?: { currentValue?: unknown; limit?: unknown; unit?: unknown }[] };
    const rows = data.value ?? [];
    let used = 0;
    let total = 0;
    for (const r of rows) {
      used += num(r.currentValue) ?? 0;
      total += num(r.limit) ?? 0;
    }
    return {
      used,
      remaining: total > 0 ? total - used : null,
      total: total > 0 ? total : null,
      currency: 'COUNT',
    };
  },
};
