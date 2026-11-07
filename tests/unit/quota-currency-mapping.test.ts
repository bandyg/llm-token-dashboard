import { describe, expect, it, vi, afterEach } from 'vitest';
import { createDatabase } from '../../src/main/db/database';
import { ProviderStore } from '../../src/main/db/providers';
import { SnapshotStore } from '../../src/main/db/snapshots';
import { SettingsStore } from '../../src/main/db/settings';
import { AlertStore } from '../../src/main/db/alerts';
import { CookieStore } from '../../src/main/db/cookies';
import { RefreshOrchestrator } from '../../src/main/collect/orchestrator';
import { WebCollector } from '../../src/main/collect/web-collector';
import { RunLogger } from '../../src/main/logger';
import type { BrowserViewPool } from '../../src/main/collect/browser-pool';
import { tmpDbFile } from './setup';

function ctxWithStubbedFetch(stub: (url: string) => Response): {
  orch: RefreshOrchestrator;
  providers: ProviderStore;
  snapshots: SnapshotStore;
} {
  const db = createDatabase(tmpDbFile('qtmap'));
  const providers = new ProviderStore(db);
  const snapshots = new SnapshotStore(db);
  new SettingsStore(db).setSyncSettings({ strategy: 'serial', batch_size: 1, interval_seconds: 0 });
  const alerts = new AlertStore(db);
  const cookies = new CookieStore(db);
  const logger = new RunLogger();

  // 默认 stub：兜底 200
  const realFetch = globalThis.fetch;
  const stubFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return stub(url);
  });
  globalThis.fetch = stubFn as unknown as typeof fetch;

  const fakePool = {
    ensureForProvider: async () => ({}),
    navigate: async () => undefined,
    executeJs: async () => JSON.stringify({ loginRequired: false, url: '', title: '' }),
    exportCookies: async () => [],
    checkAuth: async () => ({ loginRequired: false, url: '' }),
  } as unknown as BrowserViewPool;

  const webCollector = new WebCollector(fakePool, { encryptToBlob: (v: string) => v, write: () => undefined, read: () => null, remove: () => undefined } as never, cookies, logger);

  const orch = new RefreshOrchestrator({
    providers,
    snapshots,
    settings: new SettingsStore(db),
    alerts,
    safeStore: { read: () => 'k', write: () => undefined, remove: () => undefined } as never,
    webCollector,
    logger,
    broadcast: () => undefined,
  });

  return {
    orch,
    providers,
    snapshots,
    restore: () => { globalThis.fetch = realFetch; },
  } as { orch: RefreshOrchestrator; providers: ProviderStore; snapshots: SnapshotStore };
}

describe('quota_type ↔ currency 映射（orchestrator 写入层）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('TOKEN（智谱）→ quota_type=token', async () => {
    const c = ctxWithStubbedFetch((url) => {
      if (url.includes('/api/monitor/usage/quota/limit')) {
        return new Response(JSON.stringify({
          success: true,
          code: 200,
          data: {
            level: 'pro',
            limits: [{ type: 'TOKENS_LIMIT', usage: 40000000, percentage: 53 }],
          },
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const p = c.providers.create({
      provider_name: '智谱主号',
      mode: 'api',
      adapter: 'zhipu',
      template: 'zhipu',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      credential_ref: 'keyed_zhipu',
    });
    const r = await c.orch.refreshOne(p.id);
    expect(r.ok).toBe(true);
    const latest = c.snapshots.latest(p.id);
    expect(latest?.quota_type).toBe('token');
    expect(latest?.currency).toBe('TOKEN');
    expect(latest?.total).toBe(40000000);
    expect(latest?.used).toBe(21200000); // round(40000000 * 53 / 100)
  });

  it('CNY（DeepSeek）→ quota_type=credit', async () => {
    const c = ctxWithStubbedFetch((url) => {
      if (url.includes('/user/balance')) {
        return new Response(JSON.stringify({
          balance_infos: [{ currency: 'CNY', total_balance: 128.4, granted_balance: 500 }],
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const p = c.providers.create({
      provider_name: 'DeepSeek',
      mode: 'api',
      adapter: 'deepseek',
      template: 'deepseek',
      base_url: 'https://api.deepseek.com',
      credential_ref: 'keyed_ds',
    });
    const r = await c.orch.refreshOne(p.id);
    expect(r.ok).toBe(true);
    const latest = c.snapshots.latest(p.id);
    expect(latest?.quota_type).toBe('credit');
    expect(latest?.currency).toBe('CNY');
  });

  it('USD（OpenAI）→ quota_type=usd', async () => {
    const c = ctxWithStubbedFetch((url) => {
      if (url.includes('/v1/dashboard/billing/subscription')) {
        return new Response(JSON.stringify({
          total_granted: 50,
          total_used: 12.34,
          total_available: 37.66,
          plan: 'payg',
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    const p = c.providers.create({
      provider_name: 'OpenAI',
      mode: 'api',
      adapter: 'openai',
      template: 'openai',
      base_url: 'https://api.openai.com',
      credential_ref: 'keyed_oa',
    });
    const r = await c.orch.refreshOne(p.id);
    expect(r.ok).toBe(true);
    const latest = c.snapshots.latest(p.id);
    expect(latest?.quota_type).toBe('usd');
    expect(latest?.currency).toBe('USD');
  });
});