import { describe, expect, it } from 'vitest';
import { openaiAdapter } from '../../src/main/adapters/openai';
import { anthropicAdapter } from '../../src/main/adapters/anthropic';
import { azureOpenAiAdapter } from '../../src/main/adapters/azure-openai';
import { deepseekAdapter } from '../../src/main/adapters/deepseek';
import { zhipuAdapter } from '../../src/main/adapters/zhipu';
import { minimaxAdapter } from '../../src/main/adapters/minimax';
import { mimoAdapter } from '../../src/main/adapters/xiaomi-mimo';
import { opencodeGoAdapter } from '../../src/main/adapters/opencode-go';
import { AdapterError, type FetchLike, type ResponseLike } from '../../src/main/adapters/types';

function mockFetch(routes: Record<string, { status?: number; body: unknown }>): { fetchImpl: FetchLike; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    for (const [pattern, resp] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return {
          status: resp.status ?? 200,
          ok: (resp.status ?? 200) >= 200 && (resp.status ?? 200) < 300,
          json: async () => resp.body,
          text: async () => JSON.stringify(resp.body),
        } as ResponseLike;
      }
    }
    return { status: 404, ok: false, json: async () => ({}), text: async () => '{}' } as ResponseLike;
  };
  return { fetchImpl, calls };
}

describe('API 适配器（AC：调用对应 usage endpoint 且响应写入快照字段）', () => {
  it('openai：/v1/dashboard/billing/subscription → used/remaining/total', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/v1/dashboard/billing/subscription': {
        body: { total_granted: 50.0, total_used: 12.34, total_available: 37.66, plan: 'pay-as-you-go' },
      },
    });
    const usage = await openaiAdapter.fetchQuota({ apiKey: 'sk-test', baseUrl: 'https://api.openai.com' }, { fetchImpl });
    expect(calls[0].url).toContain('/v1/dashboard/billing/subscription');
    expect(calls[0].init?.headers).toEqual({ Authorization: 'Bearer sk-test' });
    expect(usage.used).toBe(12.34);
    expect(usage.remaining).toBe(37.66);
    expect(usage.total).toBe(50.0);
  });

  it('openai：订阅端点 404 时降级 /v1/organization/costs', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/v1/dashboard/billing/subscription': { status: 404, body: {} },
      '/v1/organization/costs': { body: { data: [{ amount: { value: 3.5 } }, { amount: { value: 1.5 } }] } },
    });
    const usage = await openaiAdapter.fetchQuota({ apiKey: 'sk', baseUrl: 'https://api.openai.com' }, { fetchImpl });
    expect(calls[1].url).toContain('/v1/organization/costs');
    expect(usage.used).toBe(5);
  });

  it('anthropic：/v1/organizations/usage_report/messages → Σ costUSD 与 token 分列', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/v1/organizations/usage_report/messages': {
        body: {
          data: [
            { usage: { input: 100, output: 50 }, costUSD: 1.25 },
            { usage: { input: 200, output: 80 }, costUSD: 2.75 },
          ],
        },
      },
    });
    const usage = await anthropicAdapter.fetchQuota({ apiKey: 'ak', baseUrl: 'https://api.anthropic.com' }, { fetchImpl });
    expect(calls[0].url).toContain('/v1/organizations/usage_report/messages');
    expect(calls[0].init?.headers).toMatchObject({ 'x-api-key': 'ak', 'anthropic-version': '2023-06-01' });
    expect(usage.used).toBe(4);
    expect(usage.used_input).toBe(300);
    expect(usage.used_output).toBe(130);
  });

  it('azure-openai：ARM usages 端点 → currentValue/limit 汇总；缺参数报错', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/usages': { body: { value: [{ currentValue: 30, limit: 100 }, { currentValue: 10, limit: 50 }] } },
    });
    const usage = await azureOpenAiAdapter.fetchQuota(
      { apiKey: 'arm-token', baseUrl: 'https://management.azure.com', extra: { subscriptionId: 'sub-1', location: 'eastus' } },
      { fetchImpl },
    );
    expect(calls[0].url).toContain('/subscriptions/sub-1/providers/Microsoft.CognitiveServices/locations/eastus/usages');
    expect(usage.used).toBe(40);
    expect(usage.total).toBe(150);
    expect(usage.remaining).toBe(110);
    await expect(
      azureOpenAiAdapter.fetchQuota({ apiKey: 't', baseUrl: 'x' }, { fetchImpl }),
    ).rejects.toThrow(/subscriptionId/);
  });

  it('deepseek：/user/balance → remaining=total_balance', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/user/balance': { body: { balance_infos: [{ currency: 'CNY', total_balance: 110.5, granted_balance: 200 }] } },
    });
    const usage = await deepseekAdapter.fetchQuota({ apiKey: 'dk', baseUrl: 'https://api.deepseek.com' }, { fetchImpl });
    expect(calls[0].url).toContain('/user/balance');
    expect(usage.remaining).toBe(110.5);
    expect(usage.currency).toBe('CNY');
  });

  it('401 → AdapterError(auth_expired)「凭据无效 (401)」（AC/P1-001：注入错误 Key 显示红字）', async () => {
    const { fetchImpl } = mockFetch({ '/v1/dashboard/billing/subscription': { status: 401, body: { error: 'invalid key' } } });
    await expect(openaiAdapter.fetchQuota({ apiKey: 'bad', baseUrl: 'https://api.openai.com' }, { fetchImpl })).rejects.toMatchObject({
      code: 'auth_expired',
      message: '凭据无效 (401)',
    });
  });

  it('openai-compatible：cred.extra.probePath 时 POST probePath 探活；401 → auth_expired', async () => {
    // 模拟智谱：POST /chat/completions 返 401
    const { fetchImpl, calls } = mockFetch({
      '/chat/completions': { status: 401, body: { error: 'invalid api key' } },
    });
    await expect(
      openaiAdapter.fetchQuota(
        { apiKey: 'wrong-key', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', extra: { probePath: '/chat/completions' } },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'auth_expired', message: '凭据无效 (401)' });
    // 应打到 probePath 而不是 OpenAI billing
    expect(calls[0].url).toContain('/chat/completions');
    expect(calls[0].url).not.toContain('/v1/dashboard/billing');
    expect(calls[0].init?.method).toBe('POST');
    const auth = (calls[0].init?.headers as Record<string, string>)?.Authorization ?? (calls[0].init?.headers as Record<string, string>)?.authorization;
    expect(auth).toBe('Bearer wrong-key');
  });

  it('openai-compatible：cred.extra.probePath 时 POST probePath 探活；2xx → 返回兼容层 NormalizedUsage', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/chat/completions': { status: 200, body: { id: 'x', choices: [{ message: { content: 'pong' } }] } },
    });
    const usage = await openaiAdapter.fetchQuota(
      { apiKey: 'good-key', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', extra: { probePath: '/chat/completions' } },
      { fetchImpl },
    );
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(usage.used).toBeNull();
    expect(usage.remaining).toBeNull();
    expect(usage.total).toBeNull();
  });

  it('zhipu：/api/monitor/usage/quota/limit → 取最严 TOKENS_LIMIT 的 used/remaining/total/reset_at', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/monitor/usage/quota/limit': {
        body: {
          success: true,
          code: 200,
          data: {
            level: 'pro',
            limits: [
              { type: 'TIME_LIMIT', usage: 1000, currentValue: 72, remaining: 928, percentage: 7 },
              { type: 'TOKENS_LIMIT', usage: 5000000, currentValue: 2200000, remaining: 2800000, percentage: 44, nextResetTime: Date.now() + 5 * 3600_000 },
              { type: 'TOKENS_LIMIT', usage: 40000000, currentValue: 21000000, remaining: 19000000, percentage: 53, nextResetTime: Date.now() + 7 * 86400_000 },
            ],
          },
        },
      },
    });
    const usage = await zhipuAdapter.fetchQuota(
      { apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { fetchImpl },
    );
    // monitor 端点必须挂在 host 根路径下，不在 /api/paas/v4 子树里
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
    // 选 percentage 最大的（最严窗口）= 53% 的 weekly
    expect(usage.total).toBe(40000000);
    expect(usage.used).toBe(21200000); // round(40000000 * 53 / 100)
    expect(usage.remaining).toBe(18800000); // 40000000 - 21200000
    expect(usage.currency).toBe('TOKEN');
    expect(usage.account_preview).toBe('pro');
    expect(usage.reset_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('zhipu：monitor URL 从 baseUrl 派生 host（不挂在 /api/paas/v4 下；即使 baseUrl 缺 /v4 也走 host 根）', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/monitor/usage/quota/limit': {
        body: { success: true, code: 200, data: { level: 'pro', limits: [{ type: 'TOKENS_LIMIT', usage: 1000, currentValue: 100, remaining: 900, percentage: 10 }] } },
      },
    });
    // 用户场景：baseUrl 缺 /v4（仅 /api/paas），adapter 必须派生到 host 根
    await zhipuAdapter.fetchQuota(
      { apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas' },
      { fetchImpl },
    );
    expect(calls[0].url).toBe('https://open.bigmodel.cn/api/monitor/usage/quota/limit');
    expect(calls[0].url).not.toContain('/api/paas');
  });

  it('zhipu：CREDIT_LIMIT（现网套餐类型）按 unit 区分为 5 小时 / 每周窗口', async () => {
    // 回归：早期实现只过滤 type === 'TOKENS_LIMIT'，而智谱现网已改发 CREDIT_LIMIT，
    // 导致两个窗口都匹配不到 → 返回全 null 且不报错（用户侧表现为「刷新成功但无数据」）
    const { fetchImpl } = mockFetch({
      '/api/monitor/usage/quota/limit': {
        body: {
          success: true,
          code: 200,
          data: {
            level: 'lite',
            limits: [
              { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
              {
                type: 'CREDIT_LIMIT',
                unit: 6,
                number: 1,
                usage: 10000,
                currentValue: 8371,
                remaining: 1628,
                percentage: 83,
                nextResetTime: 1791984134998,
              },
            ],
          },
        },
      },
      '/api/biz/subscription/list': {
        body: {
          success: true,
          data: [
            {
              productName: 'GLM Coding Lite',
              status: 'VALID',
              valid: '2027-09-11 10:00:00-2028-09-11 10:00:00',
              nextRenewTime: '2027-09-11',
              autoRenew: 1,
              billingCycle: 'annually',
            },
          ],
        },
      },
    });
    const usage = await zhipuAdapter.fetchQuota(
      { apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { fetchImpl },
    );

    // 窗口按 unit 分类，标签与截图一致
    expect(usage.windows?.map((w) => w.window_key)).toEqual(['five_hour', 'weekly']);
    expect(usage.windows?.[0].window_label).toBe('5 小时剩余');
    expect(usage.windows?.[1].window_label).toBe('每周剩余');
    expect(usage.windows?.[1].percent_used).toBe(83);
    // 0% 的 5 小时窗口不得覆盖最严的每周窗口
    expect(usage.total).toBe(10000);
    expect(usage.used).toBe(8300);
    expect(usage.remaining).toBe(1700);
    expect(usage.currency).toBe('CREDIT');
    // 订阅信息：套餐名 + 续费日期
    expect(usage.subscription?.product_name).toBe('GLM Coding Lite');
    expect(usage.subscription?.next_renew_at).toBe('2027-09-11');
    expect(usage.subscription?.auto_renew).toBe(1);
  });

  it('zhipu：TIME_LIMIT → 月度 MCP 窗口（绝对值口径，不参与百分比聚合）', async () => {
    const { fetchImpl } = mockFetch({
      '/api/monitor/usage/quota/limit': {
        body: {
          success: true,
          code: 200,
          data: {
            level: 'pro',
            limits: [
              { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, percentage: 83 },
              { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 141, remaining: 859, percentage: 14 },
            ],
          },
        },
      },
    });
    const usage = await zhipuAdapter.fetchQuota(
      { apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { fetchImpl },
    );
    const mcp = usage.windows?.find((w) => w.window_key === 'monthly_mcp');
    expect(mcp?.window_label).toBe('ZCode MCP');
    expect(mcp?.unit).toBe('次');
    expect(mcp?.remaining).toBe(859);
    // 顶层聚合仍取最严的每周窗口（83%），不被 MCP 的 14% 覆盖
    expect(usage.total).toBe(10000);
    expect(usage.used).toBe(8300);
  });

  it('zhipu：业务码 401（token 过期）→ 抛 auth_expired', async () => {
    const { fetchImpl } = mockFetch({
      '/api/monitor/usage/quota/limit': { status: 200, body: { success: false, code: 401, msg: '令牌已过期' } },
    });
    await expect(
      zhipuAdapter.fetchQuota({ apiKey: 'expired', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, { fetchImpl }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('zhipu：业务码 1000/1001（Zhipu 业务鉴权码）→ 抛 auth_expired', async () => {
    for (const code of [1000, 1001]) {
      const { fetchImpl } = mockFetch({
        '/api/monitor/usage/quota/limit': { status: 200, body: { success: false, code, msg: '身份验证失败' } },
      });
      await expect(
        zhipuAdapter.fetchQuota({ apiKey: 'bad', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, { fetchImpl }),
      ).rejects.toMatchObject({ code: 'auth_expired' });
    }
  });

  it('zhipu：quota 端点 404 → 降级到 chat/completions 探活；探活 200 → 不报错返回 null', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/api/monitor/usage/quota/limit': { status: 404, body: { error: 'not found' } },
      '/chat/completions': { status: 200, body: { id: 'x', choices: [{ message: { content: 'pong' } }] } },
    });
    const usage = await zhipuAdapter.fetchQuota(
      { apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      { fetchImpl },
    );
    // 两条调用都打到了
    expect(calls.length).toBe(2);
    expect(calls[0].url).toContain('/api/monitor/usage/quota/limit');
    expect(calls[1].url).toContain('/chat/completions');
    expect(usage.used).toBeNull();
    expect(usage.remaining).toBeNull();
    expect(usage.account_preview).toBe('zhipu-quota-unavailable');
  });

  it('zhipu：quota 端点 + 探活都失败 → 透传最后错误', async () => {
    const { fetchImpl } = mockFetch({
      '/api/monitor/usage/quota/limit': { status: 500, body: { error: 'server down' } },
      '/chat/completions': { status: 500, body: { error: 'server down' } },
    });
    await expect(
      zhipuAdapter.fetchQuota({ apiKey: 'k', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, { fetchImpl }),
    ).rejects.toBeInstanceOf(AdapterError);
  });

  it('上游 500 → AdapterError(adapter_upstream_error)', async () => {
    const { fetchImpl } = mockFetch({ '/v1/dashboard/billing/subscription': { status: 500, body: {} } });
    const err = await openaiAdapter.fetchQuota({ apiKey: 'k', baseUrl: 'https://api.openai.com' }, { fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('adapter_upstream_error');
  });

  // ---------- MiniMax Token Plan（额度端点只认网页 Cookie，不认 API Key） ----------

  it('minimax：无 Cookie → 直接抛 auth_expired，提示先登录（不静默返回全 null）', async () => {
    const { fetchImpl, calls } = mockFetch({});
    const err = await minimaxAdapter
      .fetchQuota({ apiKey: 'k', baseUrl: 'https://api.minimaxi.com/v1', cookie: null }, { fetchImpl })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('auth_expired');
    expect((err as AdapterError).message).toMatch(/Cookie/);
    // 无 Cookie 时不该发出任何请求
    expect(calls.length).toBe(0);
  });

  it('minimax：HTTP 200 + status_code 1004(not login) → 抛 auth_expired', async () => {
    // 回归：该端点未登录时返回 HTTP 200，只看 HTTP 状态会误判为成功
    const { fetchImpl } = mockFetch({
      '/backend/account/token_plan/remains_percent': { status: 200, body: { base_resp: { status_code: 1004, status_msg: 'not login' } } },
    });
    const err = await minimaxAdapter
      .fetchQuota({ apiKey: 'k', baseUrl: 'https://api.minimaxi.com/v1', cookie: 'session=abc' }, { fetchImpl })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('auth_expired');
  });

  it('minimax：解析 remains_percent 的 5 小时与周窗口（实测响应结构）', async () => {
    // 真实结构：百分比是 "38%" 字符串，-1 表示该维度不适用
    const { fetchImpl, calls } = mockFetch({
      '/backend/account/token_plan/remains_percent': {
        body: {
          base_resp: { status_code: 0, status_msg: 'success' },
          model_remains: [
            {
              model_name: 'general',
              end_time: 1791788400000,
              current_interval_used_percent: '38%',
              current_interval_total_percent: '100%',
              current_weekly_used_percent: '6%',
              current_weekly_total_percent: '100%',
              weekly_end_time: 1792339200000,
              current_interval_total_count: -1,
              current_interval_used_count: -1,
            },
          ],
        },
      },
      '/backend/account/token_plan_credit': {
        body: { base_resp: { status_code: 0 }, total_credits: 0, used_credits: 0, remaining_credits: 0 },
      },
    });
    const usage = await minimaxAdapter.fetchQuota(
      { apiKey: 'k', baseUrl: 'https://api.minimaxi.com/v1', cookie: 'session=abc' },
      { fetchImpl },
    );
    expect(calls[0].url).toBe('https://www.minimaxi.com/backend/account/token_plan/remains_percent');
    expect((calls[0].init?.headers as Record<string, string>).Cookie).toBe('session=abc');

    const keys = usage.windows?.map((w) => w.window_key);
    expect(keys).toEqual(['five_hour', 'weekly']);
    const five = usage.windows?.find((w) => w.window_key === 'five_hour');
    expect(five?.window_label).toBe('5 小时限额');
    expect(five?.percent_used).toBe(38);
    // 端点只给百分比，不伪造绝对值
    expect(five?.total).toBeNull();
    expect(five?.remaining).toBeNull();
    expect(five?.reset_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(usage.windows?.find((w) => w.window_key === 'weekly')?.percent_used).toBe(6);
    // 纯百分比口径，不能落成货币或 token 数值
    expect(usage.currency).toBe('PERCENT');
    expect(usage.used).toBe(38);
    expect(usage.remaining).toBeNull();
    // 积分为 0（订阅制走限额），不应额外占一个窗口
    expect(usage.windows?.some((w) => w.window_key === 'credit')).toBe(false);
  });

  it('minimax：忽略 video 等非语言模型维度（赠送次数与额度监控无关）', async () => {
    // 实测响应含 general 与 video 两个 model_name；只展示 general 的限额，
    // 否则会出现 4 张几乎全满的卡挤占版面
    const { fetchImpl } = mockFetch({
      '/backend/account/token_plan/remains_percent': {
        body: {
          base_resp: { status_code: 0 },
          model_remains: [
            { model_name: 'general', current_interval_used_percent: '40%', current_weekly_used_percent: '8%' },
            { model_name: 'video', current_interval_used_percent: '0%', current_interval_total_count: 3, current_interval_used_count: 0 },
          ],
        },
      },
    });
    const usage = await minimaxAdapter.fetchQuota(
      { apiKey: 'k', baseUrl: 'https://api.minimaxi.com/v1', cookie: 'session=abc' },
      { fetchImpl },
    );
    expect(usage.windows?.map((w) => w.window_key)).toEqual(['five_hour', 'weekly']);
    expect(usage.windows?.some((w) => w.window_key.includes('video'))).toBe(false);
  });

  it('minimax：响应无额度窗口 → 抛 parse_error（不静默返回空）', async () => {
    const { fetchImpl } = mockFetch({
      '/backend/account/token_plan/remains_percent': { status: 200, body: { base_resp: { status_code: 0 }, model_remains: [] } },
    });
    const err = await minimaxAdapter
      .fetchQuota({ apiKey: 'k', baseUrl: 'https://api.minimaxi.com/v1', cookie: 'session=abc' }, { fetchImpl })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('parse_error');
  });

  it('minimax：国际站 baseUrl → www.minimax.io', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/backend/account/token_plan/remains_percent': {
        body: { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_used_percent: '10%', current_interval_total_percent: '100%' }] },
      },
    });
    const usage = await minimaxAdapter.fetchQuota(
      { apiKey: 'k', baseUrl: 'https://api.minimax.io/v1', cookie: 'session=abc' },
      { fetchImpl },
    );
    expect(calls[0].url).toBe('https://www.minimax.io/backend/account/token_plan/remains_percent');
    expect(usage.windows?.[0].percent_used).toBe(10);
  });

  // ---------- 小米 MiMo（TokenPlan 套餐额度 / 按量计费余额，均只认 Cookie） ----------

  it('xiaomi-mimo：无 Cookie → 抛 auth_expired，不静默返回空', async () => {
    const { fetchImpl, calls } = mockFetch({});
    const err = await mimoAdapter
      .fetchQuota({ apiKey: 'tp-abc', baseUrl: 'https://api.xiaomimimo.com/v1', cookie: null }, { fetchImpl })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('auth_expired');
    expect(calls.length).toBe(0);
  });

  it('xiaomi-mimo：同时采集套餐额度与账户余额（TokenPlan 用户也有余额，不能二选一）', async () => {
    // 回归：原实现按 API Key 前缀二选一，未填 Key 时走 /balance，
    // 导致 TokenPlan 订阅用户只看到余额、掩盖了真实的套餐额度
    const { fetchImpl, calls } = mockFetch({
      '/api/v1/tokenPlan/usage': {
        body: {
          code: 0,
          data: {
            usage: {
              percent: 0.02,
              items: [
                { name: 'plan_total_token', used: 2033872773, limit: 132000000000, percent: 0.02 },
                { name: 'compensation_total_token', used: 0, limit: 0, percent: 0 },
                { name: 'rpm', used: 1, limit: 100, percent: 0.01 },
              ],
            },
          },
        },
      },
      '/api/v1/balance': {
        body: { code: 0, data: { balance: '5.00', cashBalance: '0.00', giftBalance: '5.00', currency: 'CNY' } },
      },
    });
    const usage = await mimoAdapter.fetchQuota(
      { apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1', cookie: 'api-platform_serviceToken=x; userId=y' },
      { fetchImpl },
    );
    // 两个端点都打了，且都带 Cookie
    expect(calls.map((c) => c.url)).toEqual([
      'https://platform.xiaomimimo.com/api/v1/tokenPlan/usage',
      'https://platform.xiaomimimo.com/api/v1/balance',
    ]);
    // 套餐额度与余额同时展示；rpm 速率项不计入；limit=0 的补偿额度不占位
    expect(usage.windows?.map((w) => w.window_key)).toEqual(['plan_total_token', 'balance']);
    const plan = usage.windows?.[0];
    expect(plan?.window_label).toBe('套餐额度');
    expect(plan?.percent_used).toBe(2);
    expect(plan?.used).toBe(2033872773);
    expect(plan?.total).toBe(132000000000);
    expect(plan?.remaining).toBe(129966127227);
    // 顶部汇总跟随套餐口径
    expect(usage.currency).toBe('CREDIT');
    expect(usage.total).toBe(132000000000);
  });

  it('xiaomi-mimo：套餐端点失败时不丢余额（两端点互不影响）', async () => {
    const { fetchImpl } = mockFetch({
      '/api/v1/tokenPlan/usage': { status: 500, body: { error: 'boom' } },
      '/api/v1/balance': { status: 200, body: { code: 0, data: { balance: '12.30', currency: 'CNY' } } },
    });
    const usage = await mimoAdapter.fetchQuota(
      { apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1', cookie: 'x=1' }, { fetchImpl },
    );
    expect(usage.windows?.map((w) => w.window_key)).toEqual(['balance']);
    expect(usage.remaining).toBe(12.3);
    expect(usage.currency).toBe('CNY');
  });

  it('xiaomi-mimo：两个端点都鉴权失败 → 抛 auth_expired', async () => {
    const { fetchImpl } = mockFetch({
      '/api/v1/tokenPlan/usage': { status: 200, body: { code: 401 } },
      '/api/v1/balance': { status: 200, body: { code: 401 } },
    });
    const err = await mimoAdapter
      .fetchQuota({ apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1', cookie: 'x=1' }, { fetchImpl })
      .catch((e) => e);
    expect((err as AdapterError).code).toBe('auth_expired');
  });

  it('xiaomi-mimo：两端点均无数据 → 抛 parse_error', async () => {
    const { fetchImpl } = mockFetch({
      '/api/v1/tokenPlan/usage': { status: 200, body: { code: 0, data: {} } },
      '/api/v1/balance': { status: 200, body: { code: 0, data: {} } },
    });
    const err = await mimoAdapter
      .fetchQuota({ apiKey: '', baseUrl: 'https://api.xiaomimimo.com/v1', cookie: 'x=1' }, { fetchImpl })
      .catch((e) => e);
    expect((err as AdapterError).code).toBe('parse_error');
  });

  // ---------- OpenCode Go（认 API Key，无需 Cookie；三窗口百分比） ----------

  it('opencode-go：解析 5 小时 / 每周 / 每月三窗口（字段名已对真实接口验证）', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/zen/go/v1/usage': {
        body: {
          usage: {
            // 真实接口为 camelCase resetsAt（附 status），社区实现的 snake/短名也要兼容
            rolling: { percent: 40, resetsAt: '2026-10-12T20:00:00.000Z', status: 'ok' },
            weekly: { percent: 52, reset: '2026-10-14T00:00:00.000Z' },
            monthly: { percent: 12, reset: '2026-11-01T00:00:00.000Z' },
          },
        },
      },
      '/zen/v1/credits': { body: { balance: 25.5 } },
    });
    const usage = await opencodeGoAdapter.fetchQuota(
      { apiKey: 'sk-go', baseUrl: 'https://opencode.ai/zen/v1' },
      { fetchImpl },
    );
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-go');
    expect(usage.windows?.map((w) => w.window_key)).toEqual(['five_hour', 'weekly', 'monthly', 'zen_balance']);
    expect(usage.windows?.[0].window_label).toBe('5 小时限额');
    expect(usage.windows?.[0].percent_used).toBe(40);
    expect(usage.windows?.[0].reset_at).toBe('2026-10-12T20:00:00.000Z');
    expect(usage.windows?.[1].reset_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 纯百分比口径，不伪造绝对美元金额
    expect(usage.currency).toBe('PERCENT');
    expect(usage.total).toBeNull();
    // 最紧窗口驱动顶部汇总
    expect(usage.used).toBe(52);
  });

  it('opencode-go：credits 端点失败不影响三窗口展示', async () => {
    const { fetchImpl } = mockFetch({
      '/zen/go/v1/usage': { body: { usage: { rolling: { percent: 10 } } } },
      '/zen/v1/credits': { status: 404, body: { error: 'not subscribed' } },
    });
    const usage = await opencodeGoAdapter.fetchQuota(
      { apiKey: 'sk-go', baseUrl: 'https://opencode.ai/zen/v1' },
      { fetchImpl },
    );
    expect(usage.windows?.map((w) => w.window_key)).toEqual(['five_hour']);
  });

  it('opencode-go：usage 为空（未订阅 Go）→ 抛 parse_error 而非静默返回空', async () => {
    const { fetchImpl } = mockFetch({ '/zen/go/v1/usage': { body: { usage: {} } } });
    const err = await opencodeGoAdapter
      .fetchQuota({ apiKey: 'sk-go', baseUrl: 'https://opencode.ai/zen/v1' }, { fetchImpl })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).code).toBe('parse_error');
    expect((err as AdapterError).message).toMatch(/Go/);
  });

  it('opencode-go：401 → 抛 auth_expired（Key 无效或未订阅）', async () => {
    const { fetchImpl } = mockFetch({ '/zen/go/v1/usage': { status: 401, body: { error: 'Unauthorized' } } });
    const err = await opencodeGoAdapter
      .fetchQuota({ apiKey: 'bad', baseUrl: 'https://opencode.ai/zen/v1' }, { fetchImpl })
      .catch((e) => e);
    expect((err as AdapterError).code).toBe('auth_expired');
  });

  it('opencode-go：baseUrl 带路径时从 origin 派生端点', async () => {
    const { fetchImpl, calls } = mockFetch({
      '/zen/go/v1/usage': { body: { usage: { weekly: { percent: '78%' } } } },
    });
    const usage = await opencodeGoAdapter.fetchQuota(
      { apiKey: 'sk-go', baseUrl: 'https://opencode.ai/zen/v1/' },
      { fetchImpl },
    );
    expect(calls[0].url).toBe('https://opencode.ai/zen/go/v1/usage');
    // 字符串百分比 "78%" 也要正确解析
    expect(usage.windows?.[0].percent_used).toBe(78);
  });
});
