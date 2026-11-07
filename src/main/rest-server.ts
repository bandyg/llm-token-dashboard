import http from 'node:http';
import crypto from 'node:crypto';
import type { AppService } from './service';
import type { Server } from 'node:http';

/**
 * 14_API_Spec：主进程在 http://127.0.0.1:{port}/api/v1 提供本地 REST 服务。
 *  - 仅绑定 127.0.0.1，无外网暴露面；
 *  - 所有请求须携带 X-Local-Token（首次启动生成随机 token，存 userData/local-token）；
 *  - 校验 Origin/Host 必须为本应用（防 CSRF）；
 *  - 全局限流 20 req/s，刷新类端点同一 Provider 最小间隔 30s（AC 采用 60s，见设置 min_refresh_seconds）；
 *  - 统一信封 { code, message, data }。
 */
export class LocalApiServer {
  private server: Server | null = null;
  private token: string;
  private windowStart = Date.now();
  private windowCount = 0;
  private lastRefreshByProvider = new Map<string, number>();

  constructor(private service: AppService, private port = 47321, private dataDir = service.dataDir) {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tokenFile = path.join(this.dataDir, 'local-token');
    if (fs.existsSync(tokenFile)) {
      this.token = fs.readFileSync(tokenFile, 'utf8').trim();
    } else {
      this.token = crypto.randomBytes(24).toString('hex');
      fs.writeFileSync(tokenFile, this.token, { mode: 0o600 });
    }
  }

  get address(): string {
    return `http://127.0.0.1:${this.port}/api/v1`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.server.on('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private rateLimited(): boolean {
    const now = Date.now();
    if (now - this.windowStart > 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount++;
    return this.windowCount > 20;
  }

  private envelope(res: http.ServerResponse, status: number, code: string | number, message: string, data?: unknown): void {
    const body = JSON.stringify({ code, message, data: data ?? null });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? '';
      const origin = req.headers.origin ?? '';
      if (!host.startsWith('127.0.0.1')) {
        return this.envelope(res, 403, 'UNAUTHORIZED', 'Host 非本机');
      }
      if (origin && !origin.startsWith('http://127.0.0.1')) {
        return this.envelope(res, 403, 'UNAUTHORIZED', 'Origin 非本应用');
      }
      if ((req.headers['x-local-token'] ?? '') !== this.token) {
        return this.envelope(res, 401, 'UNAUTHORIZED', '缺少或错误的 X-Local-Token');
      }
      if (this.rateLimited()) {
        res.setHeader('Retry-After', '1');
        return this.envelope(res, 429, 'RATE_LIMITED', '请求超过 20 req/s');
      }
      const url = new URL(req.url ?? '/', this.address);
      const path = url.pathname.replace(/\/+$/, '');
      const method = (req.method ?? 'GET').toUpperCase();
      const body = await readBody(req);

      // 路由
      const providerMatch = path.match(/^\/api\/v1\/providers\/([^/]+)(\/refresh)?$/);
      if (method === 'GET' && path === '/api/v1/providers') {
        return this.envelope(res, 200, 0, 'ok', { providers: this.service.listProviders() });
      }
      if (method === 'POST' && path === '/api/v1/providers') {
        const created = this.service.createProvider(body as never);
        return this.envelope(res, 200, 0, 'ok', { provider: created });
      }
      if (providerMatch && method === 'PATCH') {
        const { id, ...patch } = body as { id: string } & Record<string, unknown>;
        const updated = this.service.updateProvider(decodeURIComponent(providerMatch[1]), patch as never);
        if (!updated) return this.envelope(res, 404, 'PROVIDER_NOT_FOUND', 'providerId 不存在');
        return this.envelope(res, 200, 0, 'ok', { provider: updated });
      }
      if (providerMatch && method === 'DELETE' && !providerMatch[2]) {
        const ok = this.service.deleteProvider(decodeURIComponent(providerMatch[1]));
        if (!ok) return this.envelope(res, 404, 'PROVIDER_NOT_FOUND', 'providerId 不存在');
        return this.envelope(res, 200, 0, 'ok', { deleted: true });
      }
      if (providerMatch?.[2] === '/refresh' && method === 'POST') {
        const pid = decodeURIComponent(providerMatch[1]);
        // 刷新类端点限流：同一 Provider 最小间隔 30s（REST 面）
        const last = this.lastRefreshByProvider.get(pid) ?? 0;
        if (Date.now() - last < 30_000) {
          return this.envelope(res, 429, 'REFRESH_TOO_FREQUENT', '同一 Provider 刷新间隔小于 30s');
        }
        this.lastRefreshByProvider.set(pid, Date.now());
        const result = await this.service.refreshOne(pid);
        return this.envelope(res, 200, 0, 'ok', { result });
      }
      if (method === 'POST' && path === '/api/v1/refresh/batch') {
        const { providerIds = [], concurrency } = body as { providerIds?: string[]; concurrency?: number };
        void concurrency; // 并发上限走设置（batch_size）
        const results = await this.service.refreshBatch(providerIds);
        return this.envelope(res, 200, 0, 'ok', {
          batchId: `bat_${Date.now().toString(36)}`,
          accepted: providerIds.length,
          results,
        });
      }
      if (method === 'GET' && path === '/api/v1/dashboard/usage') {
        const usage = this.service.dashboardUsage();
        return this.envelope(res, 200, 0, 'ok', {
          updatedAt: usage.updated_at,
          summary: usage.summary,
          providers: usage.providers.map((v) => ({
            id: v.id,
            name: v.provider_name,
            source: v.mode === 'api' ? 'adapter' : v.sub_mode === 'ocr' ? 'browser-ocr' : v.sub_mode === 'dom' ? 'browser-dom' : 'manual',
            used: v.used,
            remaining: v.remaining,
            percentUsed: v.percent_used,
            status: v.status === 'failed' ? 'failed' : 'ok',
            failReason: v.fail_reason,
            failAction: v.fail_action === 'reselect-region' ? '/api/v1/capture/selection/start' : '/api/v1/usage/manual',
            lastRefreshAt: v.collected_at,
          })),
        });
      }
      if (method === 'GET' && path === '/api/v1/dashboard/history') {
        const q = url.searchParams;
        const points = this.service.trend({
          providerId: q.get('providerId') ?? '',
          range: (q.get('range') as '24h' | '7d' | '30d' | 'custom') ?? '7d',
          from: q.get('from') ?? undefined,
          to: q.get('to') ?? undefined,
        });
        return this.envelope(res, 200, 0, 'ok', { points });
      }
      if (method === 'GET' && path === '/api/v1/collect/status') {
        return this.envelope(res, 200, 0, 'ok', { items: this.service.collectStatus() });
      }
      if (method === 'POST' && path === '/api/v1/capture/selection/start') {
        const { providerId } = body as { providerId: string };
        const sessionId = `sel_${crypto.randomBytes(4).toString('hex')}`;
        await this.service.openRegionBrowser(providerId);
        return this.envelope(res, 200, 0, 'ok', { sessionId, providerId });
      }
      if (method === 'POST' && path === '/api/v1/capture/regions') {
        const { providerId, regions } = body as { providerId: string; regions: never[] };
        const saved = this.service.saveRegions(providerId, regions ?? []);
        return this.envelope(res, 200, 0, 'ok', {
          regionId: saved[0]?.id,
          providerId,
          persisted: true,
          message: '坐标已自动回填并持久化，后续手动刷新直接复用该选区',
        });
      }
      if (method === 'POST' && path === '/api/v1/capture/ocr') {
        const { providerId } = body as { providerId: string };
        const r = await this.service.runOcr(providerId);
        return this.envelope(res, 200, 0, 'ok', r);
      }
      if (method === 'POST' && path === '/api/v1/usage/manual') {
        const { providerId, mode = 'remaining', remaining, used, recordedAt, note } = body as {
          providerId: string;
          mode?: 'used' | 'remaining';
          remaining?: number;
          used?: number;
          recordedAt?: string;
          note?: string;
        };
        const amount = mode === 'remaining' ? remaining : used;
        const r = this.service.manualEntry(providerId, { mode, amount: amount ?? NaN, recordedAt, note });
        if ('error' in r) return this.envelope(res, 400, 'INVALID_VALUE', r.error);
        return this.envelope(res, 200, 0, 'ok', { snapshot: r.snapshot });
      }
      if (method === 'PUT' && /^\/api\/v1\/alerts\/[^/]+$/.test(path)) {
        const providerId = decodeURIComponent(path.split('/').pop()!);
        const { threshold, metric = 'remaining_abs' } = body as { threshold: number; metric?: 'remaining_abs' | 'remaining_pct' };
        this.service.saveAlertRule({ provider_id: providerId, metric, threshold });
        this.service.updateProvider(providerId, { alert_threshold: metric === 'remaining_abs' ? threshold : 0 });
        return this.envelope(res, 200, 0, 'ok', { providerId, threshold });
      }
      return this.envelope(res, 404, 'NOT_FOUND', `未知端点 ${method} ${path}`);
    } catch (e) {
      return this.envelope(res, 500, 'ERROR', (e as Error).message);
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });
}
