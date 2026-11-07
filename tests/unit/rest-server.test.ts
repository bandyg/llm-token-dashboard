import { describe, expect, it, afterAll } from 'vitest';
import { LocalApiServer } from '../../src/main/rest-server';
import { tmpDir } from './setup';

const fakeService = {
  dataDir: undefined,
  listProviders: () => [{ id: 'prov_1', provider_name: 'OpenAI', mode: 'api' }],
  createProvider: (input: { provider_name: string }) => ({ id: 'prov_new', provider_name: input.provider_name }),
  updateProvider: (id: string) => ({ id, updated: true }),
  deleteProvider: () => true,
  refreshOne: async () => ({ providerId: 'prov_1', ok: true }),
  refreshBatch: async () => [{ providerId: 'prov_1', ok: true }],
  dashboardUsage: () => ({ updated_at: 'now', summary: { used: 1, remaining: 2, currency: 'USD' }, providers: [] }),
  trend: () => [{ collected_at: 'now', used: 1, remaining: 2, source: 'api' }],
  collectStatus: () => [],
  openRegionBrowser: async () => ({ webContentsId: 1 }),
  saveRegions: () => [{ id: 'rgn_1' }],
  runOcr: async () => ({ text: '42.50', confidence: 0.97, used: 42.5, remaining: null }),
  manualEntry: () => ({ snapshot: { id: 'snap_1', source: 'manual', status: 'valid' } }),
  saveAlertRule: () => ({ id: 'rule_1' }),
} as never;

let server: LocalApiServer;
const dataDir = tmpDir('rest');
const tokenHeader = (): string => (server as unknown as { token: string }).token;

async function call(path: string, init: RequestInit = {}, port = 47431): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('本地 REST 服务（14_API_Spec：127.0.0.1 绑定 + X-Local-Token + 统一信封）', () => {
  it('无 token → 401；带 token → 正常', async () => {
    server = new LocalApiServer(fakeService, 47431, dataDir);
    await server.start();
    const noToken = await call('/providers');
    expect(noToken.status).toBe(401);
    expect(noToken.body.code).toBe('UNAUTHORIZED');
    const withToken = await call('/providers', { headers: { 'X-Local-Token': tokenHeader() } });
    expect(withToken.status).toBe(200);
    expect(withToken.body.code).toBe(0);
    expect((withToken.body.data as { providers: unknown[] }).providers).toHaveLength(1);
  });

  it('usage / history / refresh/batch / manual / ocr / regions / alerts 端点', async () => {
    const h = { 'X-Local-Token': tokenHeader(), 'Content-Type': 'application/json' };
    const usage = await call('/dashboard/usage', { headers: h });
    expect((usage.body.data as { summary: { used: number } }).summary.used).toBe(1);
    const batch = await call('/refresh/batch', { method: 'POST', headers: h, body: JSON.stringify({ providerIds: ['prov_1'] }) });
    expect((batch.body.data as { accepted: number }).accepted).toBe(1);
    const manual = await call('/usage/manual', { method: 'POST', headers: h, body: JSON.stringify({ providerId: 'prov_1', mode: 'remaining', remaining: 42.5 }) });
    expect((manual.body.data as { snapshot: { source: string } }).snapshot.source).toBe('manual');
    const ocr = await call('/capture/ocr', { method: 'POST', headers: h, body: JSON.stringify({ providerId: 'prov_1' }) });
    expect((ocr.body.data as { confidence: number }).confidence).toBeCloseTo(0.97, 2);
    const regions = await call('/capture/regions', { method: 'POST', headers: h, body: JSON.stringify({ providerId: 'prov_1', regions: [{ name: 'r', x: 1, y: 2, w: 30, h: 20, mode: 'OCR' }] }) });
    expect((regions.body.data as { persisted: boolean }).persisted).toBe(true);
    const alert = await call('/alerts/prov_1', { method: 'PUT', headers: h, body: JSON.stringify({ threshold: 10, metric: 'remaining_abs' }) });
    expect(alert.status).toBe(200);
  });

  it('未知端点 → 404 信封', async () => {
    const h = { 'X-Local-Token': tokenHeader() };
    const r = await call('/nope', { headers: h });
    expect(r.status).toBe(404);
  });

  it('限流：>20 req/s 返回 429 + Retry-After（AC：本地防御请求风暴）', async () => {
    const h = { 'X-Local-Token': tokenHeader() };
    const results = await Promise.all(Array.from({ length: 30 }, () => call('/collect/status', { headers: h })));
    expect(results.some((r) => r.status === 429)).toBe(true);
  });

  afterAll(async () => {
    await server?.stop();
  });
});
