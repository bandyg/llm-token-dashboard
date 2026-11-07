import { Adapter, AdapterCredentials, FetchLikeContext, NormalizedUsage, QuotaWindowOut, SubscriptionOut, fetchJson, num } from './types';

/**
 * 智谱 GLM Coding Plan 适配器。
 *
 * 端点（挂 api host 根路径，不在 /api/paas/v4 子树下，从 baseUrl 派生 protocol://host 再拼）：
 *   - GET {host}/api/monitor/usage/quota/limit   额度窗口
 *   - GET {host}/api/biz/subscription/list      订阅（套餐名 / 续费日期）
 *
 * 鉴权：Authorization: Bearer <key>（社区实现亦有裸 Key 写法，两者服务端均接受）。
 *
 * limits[] 口径随套餐演进，务必按 unit 而非 type 判定窗口，否则会静默返回全 null：
 *   CREDIT_LIMIT unit=3  number=5 → 5 小时窗口（percentage 为已用百分比）
 *   CREDIT_LIMIT unit=6  number=1 → 每周窗口
 *   TOKENS_LIMIT unit=3 / unit=6  → 同上，旧套餐类型
 *   TIME_LIMIT                  → 月度 MCP 工具次数（usage/currentValue/remaining 为绝对值）
 * 早期只过滤 type === 'TOKENS_LIMIT'，而智谱现网已改发 CREDIT_LIMIT，导致两个窗口都匹配不到、
 * 返回全 null 且不报错——这正是「刷新成功但看不到任何数据」的根因。
 */
export const zhipuAdapter: Adapter = {
  id: 'zhipu',
  async fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage> {
    const base = cred.baseUrl.replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${cred.apiKey}`, 'Content-Type': 'application/json' };

    const u = new URL(base);
    const monitorBase = `${u.protocol}//${u.host}`;
    const quotaPath = cred.extra?.quotaPath ?? '/api/monitor/usage/quota/limit';
    const path = quotaPath.startsWith('/') ? quotaPath : `/${quotaPath}`;

    try {
      const data = (await fetchJson(ctx, `${monitorBase}${path}`, { headers })) as {
        success?: boolean;
        code?: number;
        msg?: string;
        data?: {
          level?: string | number;
          limits?: {
            type?: string;
            unit?: unknown;
            number?: unknown;
            percentage?: unknown;
            usage?: unknown;
            currentValue?: unknown;
            remaining?: unknown;
            nextResetTime?: unknown;
          }[];
        };
      };

      const { AdapterError } = await import('./types');
      if (data.success === false && (data.code === 401 || data.code === 403 || data.code === 1000 || data.code === 1001)) {
        throw new AdapterError('auth_expired', `凭据无效 (${data.code})：${data.msg ?? '令牌已过期或验证不正确'}`, data.code);
      }

      const limits = data.data?.limits ?? [];
      const windows = classifyWindows(limits);

      // 顶层聚合值取最紧张的窗口（百分比最高者），保持快照表的单一数值口径可用
      let used: number | null = null;
      let remaining: number | null = null;
      let total: number | null = null;
      let resetAt: string | null = null;

      const ranked = [...windows].sort((a, b) => (b.percent_used ?? -1) - (a.percent_used ?? -1));
      for (const w of ranked) {
        if (w.percent_used !== null) {
          if (w.total !== null && w.total > 0) {
            total = w.total;
            used = Math.round((w.total * w.percent_used) / 100);
            remaining = w.total - used;
          }
          if (resetAt === null) resetAt = w.reset_at;
          // 只取最严的百分比窗口即停：否则靠后的窗口（如百分比为 0 的 5 小时窗口）会覆盖它
          break;
        }
      }
      // 百分比口径没给出绝对值时，退回绝对值窗口（MCP 次数等）
      if (used === null) {
        const abs = windows.find((w) => w.unit !== '%' && w.total !== null);
        if (abs) {
          used = abs.used;
          remaining = abs.remaining;
          total = abs.total;
          resetAt = resetAt ?? abs.reset_at;
        }
      }

      // 订阅信息是增强项，失败不影响额度展示
      let subscription: SubscriptionOut | null = null;
      try {
        subscription = await fetchSubscription(ctx, monitorBase, headers);
      } catch {
        subscription = null;
      }

      const level = data.data?.level;
      return {
        used,
        remaining,
        total,
        currency: deriveCurrency(limits),
        reset_at: resetAt,
        account_preview: level !== undefined && level !== null ? String(level) : 'zhipu',
        windows,
        subscription,
      };
    } catch (quotaErr) {
      const { AdapterError } = await import('./types');
      if (quotaErr instanceof AdapterError && quotaErr.code === 'auth_expired') throw quotaErr;
      // quota 端点不可用（智谱下线/网络）→ 降级探活试键，保证测试连接仍可用
      const probePath = cred.extra?.probePath ?? '/chat/completions';
      const probe = probePath.startsWith('/') ? probePath : `/${probePath}`;
      try {
        await fetchJson(ctx, `${base}${probe}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: 'glm-4-flash', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        });
        // 探活通过但 quota 端点挂 → 返回全 null 但不报错，让上层知道「凭据有效但采集失败」
        return {
          used: null,
          remaining: null,
          total: null,
          currency: 'CREDIT',
          account_preview: 'zhipu-quota-unavailable',
        };      } catch (probeErr) {
        // 探活失败：把 err 原样上抛（保持原错误信息）
        throw probeErr;
      }
    }
  },
};

/**
 * 额度维度按实际返回的 limit 类型推导，不写死：
 *   CREDIT_LIMIT（新套餐，现网主流）→ CREDIT 额度点数
 *   TOKENS_LIMIT（旧套餐）           → TOKEN token 计数
 * 二者量纲不同（点数 vs token），混算会得到无意义的总量，故必须区分。
 */
function deriveCurrency(limits: { type?: string }[]): string {
  if (limits.some((l) => l.type === 'CREDIT_LIMIT')) return 'CREDIT';
  if (limits.some((l) => l.type === 'TOKENS_LIMIT')) return 'TOKEN';
  return 'CREDIT';
}

/**
 * 把 limits[] 归一化为展示窗口。
 * 按 unit 判定时长（新旧类型通用），type 只用于区分「token 百分比窗口」与「绝对值窗口」。
 */
function classifyWindows(limits: NonNullable<{ limits?: unknown[] }['limits']>): QuotaWindowOut[] {
  const out: QuotaWindowOut[] = [];
  for (const l of limits as { type?: string; unit?: unknown; number?: unknown; percentage?: unknown; usage?: unknown; currentValue?: unknown; remaining?: unknown; nextResetTime?: unknown }[]) {
    const type = l.type ?? '';
    const unit = num(l.unit);
    const number = num(l.number);
    const pct = num(l.percentage);
    const total = num(l.usage);
    const usedAbs = num(l.currentValue);
    const remainingAbs = num(l.remaining);
    const reset = num(l.nextResetTime);
    const resetAt = reset !== null ? new Date(reset < 1e12 ? reset * 1000 : reset).toISOString() : null;

    // TIME_LIMIT：月度 MCP / 工具调用次数，绝对值口径
    if (type === 'TIME_LIMIT') {
      out.push({
        window_key: 'monthly_mcp',
        window_label: 'ZCode MCP',
        percent_used: pct,
        used: usedAbs,
        remaining: remainingAbs,
        total,
        unit: '次',
        reset_at: resetAt,
      });
      continue;
    }

    // CREDIT_LIMIT / TOKENS_LIMIT：unit=3 → 5 小时，unit=6 → 每周
    // 兜底：无 unit 时按 array 顺序（5h 在前、weekly 在后）分配，保证老响应也不丢窗口
    const hours = unit !== null && number !== null ? unit * number : null;
    let key: string | null = null;
    let label = '';
    if (unit === 3) {
      key = 'five_hour';
      label = '5 小时剩余';
    } else if (unit === 6) {
      key = 'weekly';
      label = '每周剩余';
    } else if (hours !== null && hours <= 6) {
      key = 'five_hour';
      label = '5 小时剩余';
    } else if (hours !== null && hours >= 24 * 6) {
      key = 'weekly';
      label = '每周剩余';
    }

    if (!key) {
      key = `extra_${out.length}`;
      label = '其他额度';
    }
    out.push({
      window_key: key,
      window_label: label,
      percent_used: pct,
      used: usedAbs,
      remaining: remainingAbs,
      total,
      unit: '%',
      reset_at: resetAt,
    });
  }
  // 同 key 重复时保留第一条，避免 5h/每周各被算两次
  const seen = new Set<string>();
  return out.filter((w) => (seen.has(w.window_key) ? false : (seen.add(w.window_key), true)));
}

async function fetchSubscription(
  ctx: FetchLikeContext,
  monitorBase: string,
  headers: Record<string, string>,
): Promise<SubscriptionOut | null> {
  const data = (await fetchJson(ctx, `${monitorBase}/api/biz/subscription/list`, { headers })) as {
    success?: boolean;
    data?: Record<string, unknown>[] | null;
  };
  const first = Array.isArray(data.data) ? data.data[0] : null;
  if (!first) return null;
  // valid 形如 "2027-09-11 10:00:00-2028-09-11 10:00:00"
  // 注意日期本身含 '-',朴素 split('-') 会把日期拆碎，必须按「后面紧跟完整日期」的位置切
  const valid = typeof first.valid === 'string' ? first.valid : '';
  const parts: (string | null)[] = valid ? valid.split(/-(?=\d{4}-\d{2}-\d{2})/).map((s) => s.trim()) : [];
  const from = parts[0] ?? null;
  const to = parts[1] ?? null;
  return {
    product_name: (first.productName as string) ?? (first.description as string) ?? null,
    level: typeof first.productName === 'string' ? first.productName : null,
    status: (first.status as string) ?? null,
    valid_from: from,
    valid_to: to,
    next_renew_at: (first.nextRenewTime as string) ?? null,
    auto_renew: Number(first.autoRenew) === 1 ? 1 : 0,
    billing_cycle: (first.billingCycle as string) ?? null,
    raw: JSON.stringify(first),
  };
}
