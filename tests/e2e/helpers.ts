import { test as base, expect, type Page, type ElectronApplication } from '@playwright/test';
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startMockConsole, type MockServer } from './mock-console';

export const REPO = path.resolve(__dirname, '..', '..');

export interface TestHarness {
  mock: MockServer;
  dataDir: string;
  app: ElectronApplication;
  win: Page;
  close(): Promise<void>;
}

export async function launchHarness(opts: { dataDir?: string } = {}): Promise<TestHarness> {
  const mock = await startMockConsole();
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'llmdash-e2e-'));
  const app = await electron.launch({
    args: [REPO],
    env: {
      ...process.env,
      LLMDASH_DATA_DIR: dataDir,
      LLMDASH_API_PORT: '47881',
      LLMDASH_TEST: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    timeout: 60000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // 等待 React 挂载
  await win.waitForSelector('[data-testid="main-area"]', { timeout: 20000 });
  // 静音刷新间隔（e2e 加速）；min_refresh 1s 以便同 provider 重复操作
  await win.evaluate(() => (window as unknown as { llm: { invoke(c: string, p?: unknown): Promise<unknown> } }).llm.invoke('llm:settings:set', { interval_seconds: 0, min_refresh_seconds: 1 }));
  const harness: TestHarness = {
    mock,
    dataDir,
    app,
    win,
    close: async () => {
      await app.close().catch(() => undefined);
      await mock.close();
    },
  };
  return harness;
}

export async function relaunchHarness(h: TestHarness): Promise<TestHarness> {
  await h.app.close().catch(() => undefined);
  await h.mock.close();
  return launchHarness({ dataDir: h.dataDir });
}

/* ---------- 主进程驱动工具（LLMDASH_TEST=1 时 globalThis.__llmService） ---------- */

export async function evalService<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ }: any, source: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = (globalThis as any).__llmService;
      if (!service) throw new Error('__llmService 不存在（需要 LLMDASH_TEST=1）');
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      return new Function('service', `"use strict"; return (${source})(service);`)(service) as T;
    },
    expr,
  ) as Promise<T>;
}

/** SQL 取证：SELECT-only，真实执行在主进程 SQLite */
export async function sqlRows(app: ElectronApplication, sql: string): Promise<Record<string, unknown>[]> {
  const win = await app.firstWindow();
  const res = (await win.evaluate(async (q: string) => {
    const r = await (window as unknown as { llm: { invoke(c: string, p?: unknown): Promise<{ code: number | string; data?: { rows: Record<string, unknown>[] }; message?: string }> } }).llm.invoke('llm:test:sql', { sql: q });
    return r;
  }, sql)) as { code: number | string; data?: { rows: Record<string, unknown>[] }; message?: string };
  if (res.code !== 0) throw new Error(`test:sql 失败: ${res.message}`);
  return res.data?.rows ?? [];
}

export async function invokeIpc<T>(win: Page, channel: string, payload?: unknown): Promise<T> {
  const res = (await win.evaluate(async (args: { channel: string; payload?: unknown }) => {
    const r = await (window as unknown as { llm: { invoke(c: string, p?: unknown): Promise<{ code: number | string; data?: unknown; message?: string }> } }).llm.invoke(args.channel, args.payload);
    return r;
  }, { channel, payload })) as { code: number | string; data?: T; message?: string };
  if (res.code !== 0) throw new Error(`IPC ${channel} 失败: ${res.message}`);
  return res.data as T;
}

/** 点击事件计数（≤3 次点击判据） */
export async function armClickCounter(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as unknown as { __llmClicks?: number };
    w.__llmClicks = 0;
    document.addEventListener(
      'click',
      () => {
        w.__llmClicks = (w.__llmClicks ?? 0) + 1;
      },
      true,
    );
  });
}

export async function readClickCount(win: Page): Promise<number> {
  return win.evaluate(() => (window as unknown as { __llmClicks?: number }).__llmClicks ?? -1);
}

/* ---------- 数据注入工具 ---------- */

export async function seedProvider(
  win: Page,
  patch: {
    provider_name?: string;
    alias?: string;
    mode?: 'api' | 'web_crawl' | 'manual';
    sub_mode?: 'dom' | 'ocr' | null;
    adapter?: string | null;
    base_url?: string | null;
    dom_url?: string | null;
    dom_script?: string | null;
    selectors?: { name: string; selector: string }[];
    region?: { x: number; y: number; w: number; h: number } | null;
    ocr_threshold?: number;
    quota_total?: number | null;
    currency?: string;
    alert_threshold?: number;
    enabled?: 0 | 1;
    template?: string;
  },
): Promise<string> {
  const p = (await invokeIpc<{ id: string }>(win, 'llm:providers:create', {
    provider_name: patch.provider_name ?? 'Mock 厂商',
    alias: patch.alias ?? '主号',
    template: patch.template ?? 'custom',
    mode: patch.mode ?? 'web_crawl',
    sub_mode: patch.sub_mode ?? 'dom',
    adapter: patch.adapter ?? null,
    enabled: patch.enabled ?? 1,
    base_url: patch.base_url ?? null,
    dom_url: patch.dom_url ?? null,
    dom_script: patch.dom_script ?? null,
    selectors: patch.selectors ?? [{ name: '已用', selector: '.quota-used' }, { name: '剩余', selector: '.quota-remaining' }],
    region: patch.region ?? null,
    ocr_threshold: patch.ocr_threshold ?? 0.8,
    quota_total: patch.quota_total ?? 50,
    currency: patch.currency ?? 'USD',
    alert_threshold: patch.alert_threshold ?? 10,
  })) as { id: string };
  return p.id;
}

export function gotoDashboard(win: Page): Promise<void> {
  return win.evaluate(() => {
    window.location.hash = '#/dashboard';
  });
}

export { expect };
export const test = base;
export type EvalFrame = import('playwright').Frame;
