import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/main/db/database';
import { ProviderStore } from '../../src/main/db/providers';
import { SnapshotStore } from '../../src/main/db/snapshots';
import { SettingsStore } from '../../src/main/db/settings';
import { AlertStore } from '../../src/main/db/alerts';
import { CookieStore } from '../../src/main/db/cookies';
import { RefreshOrchestrator, buildUsageView } from '../../src/main/collect/orchestrator';
import { WebCollector } from '../../src/main/collect/web-collector';
import { CollectError } from '../../src/main/collect/errors';
import { RunLogger, sleep } from '../../src/main/logger';
import type { BrowserViewPool } from '../../src/main/collect/browser-pool';
import { tmpDbFile, tmpDir } from './setup';

interface Ctx {
  orch: RefreshOrchestrator;
  providers: ProviderStore;
  snapshots: SnapshotStore;
  alerts: AlertStore;
  db: ReturnType<typeof createDatabase>;
  logger: RunLogger;
  sleeps: number[];
  apiCalls: { url: string }[];
  base: string;
  broadcast: unknown[];
}

function makeCtx(opts: { strategy?: 'batch' | 'parallel' | 'serial'; batch_size?: number; interval_seconds?: number } = {}): Ctx {
  const db = createDatabase(tmpDbFile('orch'));
  const providers = new ProviderStore(db);
  const snapshots = new SnapshotStore(db);
  const settings = new SettingsStore(db);
  settings.setSyncSettings({
    strategy: opts.strategy ?? 'serial',
    batch_size: opts.batch_size ?? 5,
    interval_seconds: opts.interval_seconds ?? 1,
  });
  const alerts = new AlertStore(db);
  const cookies = new CookieStore(db);
  const logger = new RunLogger();
  const sleeps: number[] = [];
  const broadcast: unknown[] = [];

  // 本地 fake BrowserView 池（离线 DOM 采集）
  const ctx: Ctx = {
    orch: null as unknown as RefreshOrchestrator,
    providers,
    snapshots,
    alerts,
    db,
    logger,
    sleeps,
    apiCalls: [],
    base: 'http://127.0.0.1',
    broadcast,
  };

  const fakePool = {
    ensureForProvider: async () => ({}),
    navigate: async () => undefined,
    executeJs: async (_id: string, code: string) => {
      // 登录检测脚本 → 未登录；DOM 脚本 → 固定文本
      if (code.includes('loginRequired')) return JSON.stringify({ loginRequired: false, url: '', title: '' });
      return JSON.stringify({ text: 'used=12.34 | remaining=37.66' });
    },
    exportCookies: async () => [] as { name: string; domain?: string; valueEncrypted: string }[],
    checkAuth: async () => ({ loginRequired: false, url: '' }),
  } as unknown as BrowserViewPool;

  const webCollector = new WebCollector(fakePool, { encryptToBlob: (v: string) => v, write: () => undefined, read: () => null, remove: () => undefined } as never, cookies, logger);

  ctx.orch = new RefreshOrchestrator({
    providers,
    snapshots,
    settings,
    alerts,
    safeStore: {
      read: (ref: string) => (ref.includes('keyed') ? 'sk-live-xyz' : null),
      write: () => undefined,
      remove: () => undefined,
    } as never,
    webCollector,
    logger,
    broadcast: (p) => broadcast.push(p),
    sleepFn: async (ms: number) => {
      sleeps.push(ms);
      await sleep(0);
    },
  });
  return ctx;
}

describe('刷新编排器（P0-001/P0-003 核心判据）', () => {
  it('串行策略：相邻 provider 之间 await sleep(N) 且 N ≥ interval_seconds（日志可查）', async () => {
    const ctx = makeCtx({ strategy: 'serial', interval_seconds: 1 });
    const p1 = ctx.providers.create({ provider_name: 'A', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console', selectors: [] });
    const p2 = ctx.providers.create({ provider_name: 'B', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console' });
    const results = await ctx.orch.refreshBatch([p1.id, p2.id]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(ctx.sleeps).toEqual([1000]);
    const logs = ctx.logger.tail(50).join('\n');
    expect(logs).toContain('await sleep(1)');
    expect(logs).toMatch(/interval_seconds=1/);
  }, 30000);

  it('分批策略（默认）：并发 ≤ batch_size，批间 sleep(interval_seconds)（AC：并发上限与 batch_size 一致）', async () => {
    const ctx = makeCtx({ strategy: 'batch', batch_size: 2, interval_seconds: 1 });
    const ids: string[] = [];
    for (const n of ['A', 'B', 'C', 'D', 'E']) {
      ids.push(ctx.providers.create({ provider_name: n, mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console' }).id);
    }
    let active = 0;
    let maxActive = 0;
    const origCollect = (ctx.orch as unknown as { collectAndStore: (p: unknown) => Promise<unknown> }).collectAndStore.bind(ctx.orch);
    (ctx.orch as unknown as { collectAndStore: (p: unknown) => Promise<unknown> }).collectAndStore = async (p: unknown) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      const r = await origCollect(p);
      active--;
      return r;
    };
    const results = await ctx.orch.refreshBatch(ids);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(ctx.sleeps).toEqual([1000, 1000]); // 3 批之间 2 次批间间隔
  }, 30000);

  it('并行策略：并发上限 = batch_size，同车道相邻 provider 间 await sleep(N) 且 N ≥ interval_seconds（日志可查，与分批/串行同形态）', async () => {
    const ctx = makeCtx({ strategy: 'parallel', batch_size: 2, interval_seconds: 1 });
    const ids: string[] = [];
    for (const n of ['A', 'B', 'C', 'D', 'E']) {
      ids.push(ctx.providers.create({ provider_name: n, mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console' }).id);
    }
    let active = 0;
    let maxActive = 0;
    const origCollect = (ctx.orch as unknown as { collectAndStore: (p: unknown) => Promise<unknown> }).collectAndStore.bind(ctx.orch);
    (ctx.orch as unknown as { collectAndStore: (p: unknown) => Promise<unknown> }).collectAndStore = async (p: unknown) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      const r = await origCollect(p);
      active--;
      return r;
    };
    const results = await ctx.orch.refreshBatch(ids);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.ok)).toBe(true);
    // 并发断言：上限不超过 batch_size，且真实发生 2 路并发
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);
    // 同车道相邻 provider 间 sleep：5 个 provider、2 条车道 → 每条车道首个不 sleep，共 5−2=3 次
    expect(ctx.sleeps).toHaveLength(3);
    expect(ctx.sleeps.every((n) => n >= 1000)).toBe(true); // N ≥ interval_seconds（1000ms）
    const logs = ctx.logger.tail(50).join('\n');
    expect(logs).toContain('strategy=parallel');
    expect(logs).toContain('await sleep(1)');
    expect(logs).toMatch(/interval_seconds=1/);
    // 进度 done 单调递增（并行完成乱序不回退）
    const progresses = ctx.broadcast.filter((b) => (b as { type: string }).type === 'refresh-progress') as { progress: { done: number } }[];
    const dones = progresses.map((p) => p.progress.done);
    for (let i = 1; i < dones.length; i++) expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1]);
  }, 30000);

  it('同一 Provider 60s 内重复刷新 → 跳过并提示「操作过于频繁」且无新快照（AC）', async () => {
    const ctx = makeCtx();
    const p = ctx.providers.create({ provider_name: 'A', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console' });
    const r1 = await ctx.orch.refreshOne(p.id);
    expect(r1.ok).toBe(true);
    expect(ctx.snapshots.count(p.id)).toBe(1);
    const r2 = await ctx.orch.refreshOne(p.id);
    expect(r2.ok).toBe(false);
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe('操作过于频繁');
    expect(ctx.snapshots.count(p.id)).toBe(1);
  }, 30000);

  it('采集失败：不写快照、last_error 记录原因、collection_failures 落库（AC：不污染历史快照）', async () => {
    const ctx = makeCtx();
    const p = ctx.providers.create({ provider_name: 'Bad', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console' });
    const before = ctx.snapshots.count(p.id);
    // 注入 DOM 未命中：fake pool 由 ctx 替换为抛错版本
    const failOrch = new RefreshOrchestrator({
      providers: ctx.providers,
      snapshots: ctx.snapshots,
      settings: new SettingsStore(ctx.db),
      alerts: ctx.alerts,
      safeStore: { read: () => null } as never,
      webCollector: {
        collect: async () => {
          throw new CollectError('selector_missing', 'DOM 选择器失效：未在页面中命中元素');
        },
      } as never,
      broadcast: () => undefined,
    });
    const r = await failOrch.refreshOne(p.id, { force: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('selector_missing');
    expect(ctx.snapshots.count(p.id)).toBe(before);
    expect(ctx.providers.get(p.id)?.last_error).toContain('DOM 选择器失效');
    const fails = ctx.db.prepare('SELECT * FROM collection_failures WHERE provider_id = ?').all(p.id) as unknown[];
    expect(fails).toHaveLength(1);
  }, 30000);

  it('成功采集：llm_usage_snapshots 新增一行 remaining 非空；Dashboard 视图计算百分比与进度档（AC）', async () => {
    const ctx = makeCtx();
    const p = ctx.providers.create({ provider_name: 'OK', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console', quota_total: 50, alert_threshold: 10 });
    await ctx.orch.refreshOne(p.id, { force: true });
    const snap = ctx.snapshots.latest(p.id);
    expect(snap).not.toBeNull();
    expect(snap?.remaining).not.toBeNull();
    expect(snap?.status).toBe('valid');
    const view = buildUsageView(ctx.providers.get(p.id)!, ctx.snapshots);
    expect(view.used).toBeCloseTo(12.34, 2);
    expect(view.percent_used).toBeCloseTo(24.7, 1);
    expect(view.progress_band).toBe('low');
  }, 30000);

  it('告警联动：remaining ≤ alert_threshold → 告警事件 + 视图 alert=true（AC：.alert-bg 红色）', async () => {
    const ctx = makeCtx();
    const p = ctx.providers.create({ provider_name: 'AlertP', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console', quota_total: 50, alert_threshold: 40 });
    await ctx.orch.refreshOne(p.id, { force: true });
    const events = ctx.db.prepare('SELECT * FROM alert_events').all() as unknown[];
    expect(events.length).toBeGreaterThanOrEqual(1);
    const view = buildUsageView(ctx.providers.get(p.id)!, ctx.snapshots);
    expect(view.alert).toBe(true);
  }, 30000);

  it('手动录入兜底：生成 status=valid 且 source=manual 快照并参与告警判断（AC）', async () => {
    const ctx = makeCtx();
    const p = ctx.providers.create({ provider_name: 'ManualP', mode: 'web_crawl', sub_mode: 'dom', quota_total: 50, alert_threshold: 20 });
    const r = ctx.orch.manualEntry(p.id, { mode: 'used', amount: 45 });
    expect('snapshot' in r).toBe(true);
    const snap = ctx.snapshots.latest(p.id);
    expect(snap?.source).toBe('manual');
    expect(snap?.status).toBe('valid');
    expect(snap?.remaining).toBeCloseTo(5, 2);
    // 参与告警：剩余 5 ≤ 20
    const events = ctx.db.prepare('SELECT * FROM alert_events').all() as unknown[];
    expect(events.length).toBeGreaterThanOrEqual(1);
    // 非法值拦截
    expect(ctx.orch.manualEntry(p.id, { mode: 'used', amount: -3 })).toMatchObject({ error: expect.stringContaining('数值异常') });
    expect(ctx.orch.manualEntry(p.id, { mode: 'used', amount: 999999, total: 50 })).toMatchObject({ error: expect.stringContaining('数值异常') });
  }, 30000);

  it('进度事件：refresh-progress 广播 done/total（AC：正在同步 N/M）', async () => {
    const ctx = makeCtx({ strategy: 'serial', interval_seconds: 0 });
    const p1 = ctx.providers.create({ provider_name: 'A', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console' });
    const p2 = ctx.providers.create({ provider_name: 'B', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/console' });
    await ctx.orch.refreshBatch([p1.id, p2.id]);
    const progresses = ctx.broadcast.filter((b) => (b as { type: string }).type === 'refresh-progress');
    expect(progresses.length).toBeGreaterThanOrEqual(4);
    expect(progresses[0]).toMatchObject({ progress: { total: 2, done: 0 } });
    const finished = progresses.at(-1) as { progress: { finished: boolean } };
    expect(finished.progress.finished).toBe(true);
  }, 30000);
});

describe('Dashboard 聚合：按 currency 分桶（P1-002）', () => {
  it('多 currency（USD/CNY/TOKEN）共存时,byCurrency 每桶独立汇总,不再跨维度相加', async () => {
    const ctx = makeCtx();
    // USD provider + CNY provider + 手动录入生成 TOKEN provider
    ctx.providers.create({ provider_name: 'OpenAI', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'used=10 | remaining=90'", dom_url: 'https://mock.local/oa', currency: 'USD', quota_total: 100, alert_threshold: 5 });
    ctx.providers.create({ provider_name: 'DeepSeek', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'used=30 | remaining=170'", dom_url: 'https://mock.local/ds', currency: 'CNY', quota_total: 200, alert_threshold: 5 });
    const z = ctx.providers.create({ provider_name: '智谱', mode: 'web_crawl', sub_mode: 'dom', dom_script: "'x'", dom_url: 'https://mock.local/zp', currency: 'TOKEN', quota_total: 40000000, alert_threshold: 1000000 });
    const r1 = await ctx.orch.refreshBatch(ctx.providers.list().filter((p) => p.enabled).map((p) => p.id));
    expect(r1.every((x) => x.ok)).toBe(true);

    // 注入 TOKEN 维度的真实读数（web_crawl 不产 TOKEN，跳过走手动录入也行）
    ctx.orch.manualEntry(z.id, { mode: 'used', amount: 21200000, total: 40000000 });

    const dash = ctx.orch.dashboardUsage();
    // summary 字段保留，但多维度时无意义，只断言其 currency 来自第一个 view
    expect(typeof dash.summary.used).toBe('number');
    expect(typeof dash.summary.currency).toBe('string');

    // byCurrency 三桶独立
    const byC = dash.byCurrency;
    expect(byC.length).toBeGreaterThanOrEqual(2); // USD + CNY 至少两桶，TOKEN 由手动录入

    const usd = byC.find((b) => b.currency === 'USD');
    const cny = byC.find((b) => b.currency === 'CNY');
    const token = byC.find((b) => b.currency === 'TOKEN');

    expect(usd).toBeDefined();
    expect(cny).toBeDefined();
    expect(token).toBeDefined();

    // USD 桶：所有 provider 都返 mock 默认 used=12.34 / remaining=37.66
    expect(usd!.used).toBe(12.34);
    expect(usd!.remaining).toBe(37.66);
    expect(usd!.provider_count).toBe(1);

    // CNY 桶：同上
    expect(cny!.used).toBe(12.34);
    expect(cny!.remaining).toBe(37.66);

    // TOKEN 桶：21200000 / 18800000（来自手动录入 remaining = total - used）
    expect(token!.used).toBe(21200000);
    expect(token!.remaining).toBe(18800000);

    // 关键断言：summary.used 仍是全维度简单相加（保留兼容字段语义，byCurrency 才是分桶真相）
    expect(dash.summary.used).toBeCloseTo(21200024.68, 1);
    // byCurrency 三桶相互独立，每桶不混入其他维度
    const usdTotal = (usd!.used ?? 0) + (usd!.remaining ?? 0);
    const tokenTotal = (token!.used ?? 0) + (token!.remaining ?? 0);
    expect(usdTotal).toBeCloseTo(50, 1); // 12.34 + 37.66
    expect(tokenTotal).toBe(40000000); // 21200000 + 18800000
    expect(usdTotal).not.toBe(tokenTotal); // USD 桶 50 ≠ TOKEN 桶 40000000，避免跨维度混淆
  }, 30000);
});
