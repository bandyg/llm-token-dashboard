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

/**
 * P0-001 判据实测：「静置 1 小时 llm_usage_snapshots 无新增行」。
 *
 * 用真实编排器 + 真实 SQLite（临时文件）+ 真实采集器装配出完整主进程栈，
 * 在虚拟时钟下先做一次成功刷新（基线 1 行），随后把系统时间与全部定时器
 * 快进 1 小时（60 步 × 60s），逐分钟对账快照行数与出站 fetch 调用：
 * 行数必须恒为基线、fetch 必须零调用（无任何周期采集触发）。
 * 配套证据：scripts/audit-no-scheduler.mjs 源码扫描（无 setInterval/cron/队列调度）。
 */
describe('P0-001 静置 1 小时实测（虚拟时钟快进，真实服务栈 + 真实 SQLite）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('刷新 1 次后静置 1 小时（3600s 虚拟时钟快进）：llm_usage_snapshots 无新增行、fetch 零调用', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const start = new Date('2026-10-09T08:00:00Z');
    vi.setSystemTime(start);

    const fetchCalls: { url: string; at: number }[] = [];
    const spyFetch = vi.fn(async (url: string | URL | Request) => {
      fetchCalls.push({ url: String(url), at: Date.now() });
      throw new Error('静置期不允许任何出站请求');
    });
    vi.stubGlobal('fetch', spyFetch);

    const db = createDatabase(tmpDbFile('idle1h'));
    const providers = new ProviderStore(db);
    const snapshots = new SnapshotStore(db);
    const settings = new SettingsStore(db);
    settings.setSyncSettings({ strategy: 'batch', batch_size: 5, interval_seconds: 60 });
    const alerts = new AlertStore(db);
    const cookies = new CookieStore(db);
    const logger = new RunLogger();

    const fakePool = {
      ensureForProvider: async () => ({}),
      navigate: async () => undefined,
      executeJs: async (_id: string, code: string) => {
        if (code.includes('loginRequired')) return JSON.stringify({ loginRequired: false, url: '', title: '' });
        return JSON.stringify({ text: 'used=12.34 | remaining=37.66' });
      },
      exportCookies: async () => [],
      checkAuth: async () => ({ loginRequired: false, url: '' }),
    } as unknown as BrowserViewPool;
    const webCollector = new WebCollector(
      fakePool,
      { encryptToBlob: (v: string) => v, write: () => undefined, read: () => null, remove: () => undefined } as never,
      cookies,
      logger,
    );
    const orch = new RefreshOrchestrator({
      providers,
      snapshots,
      settings,
      alerts,
      safeStore: { read: () => null, write: () => undefined, remove: () => undefined } as never,
      webCollector,
      logger,
      broadcast: () => undefined,
      // 不注入 sleepFn → 用真实 sleep（虚拟时钟下 setTimeout 立即被快进驱动）
    });

    // 基线：一次用户点击触发的成功刷新 → 恰好 1 行
    const p = providers.create({ provider_name: 'IdleP', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console' });
    const r = await orch.refreshOne(p.id, { force: true });
    expect(r.ok).toBe(true);
    const baseline = snapshots.count(p.id);
    expect(baseline).toBe(1);
    const baselineFetch = fetchCalls.length;

    // 静置 1 小时：60 步 × 60s，逐分钟对账（同 provider min_refresh 已过也不允许出现新行）
    for (let minute = 1; minute <= 60; minute++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(snapshots.count(p.id)).toBe(baseline);
      expect(snapshots.count()).toBe(baseline);
    }
    // 系统时间确实前进了 1 小时
    expect(Date.now() - start.getTime()).toBe(60 * 60 * 1000);
    // 静置期零出站请求（采集从未被任何时钟驱动）
    expect(fetchCalls.length).toBe(baselineFetch);
    expect(spyFetch).not.toHaveBeenCalled();

    // 对照组：用户再点一次刷新仍可正常产生新行（证明静置无新增非「采集链路坏了」）
    vi.setSystemTime(new Date(start.getTime() + 2 * 60 * 60 * 1000));
    const r2 = await orch.refreshOne(p.id, { force: true });
    expect(r2.ok).toBe(true);
    expect(snapshots.count(p.id)).toBe(baseline + 1);

    db.close();
    vi.unstubAllGlobals();
  }, 60000);
});
