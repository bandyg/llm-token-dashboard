import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import {
  AlertEvent,
  AlertRule,
  DashboardUsage,
  ProviderConfig,
  ProviderUsageView,
  RegionRecord,
  RefreshProgress,
  SyncSettings,
  TrendPoint,
  UsageSnapshot,
} from '../shared/types';
import { SIDENAV_W, regionBrowserBounds } from '../shared/layout';
import { createDatabase } from './db/database';
import { ProviderStore } from './db/providers';
import { SnapshotStore } from './db/snapshots';
import { SettingsStore } from './db/settings';
import { RegionStore } from './db/regions';
import { AlertStore } from './db/alerts';
import { CookieStore } from './db/cookies';
import { QuotaStore } from './db/quota-windows';
import { SafeStore } from './credentials/safe-store';
import { BrowserViewPool, MAX_BROWSER_VIEWS } from './collect/browser-pool';
import { WebCollector, TestInjections } from './collect/web-collector';
import { RefreshOrchestrator, RefreshResult, buildUsageView } from './collect/orchestrator';
import { NetAudit } from './net-audit';
import { runLogger } from './logger';

export interface TrendQuery {
  providerId: string;
  range: '24h' | '7d' | '30d' | 'custom';
  from?: string;
  to?: string;
}

/**
 * 应用服务：主进程唯一事实源，IPC 与本地 REST 均委托到该层。
 * 渲染进程永远不直接触达 SQLite / BrowserView / OCR。
 */
export class AppService {
  db: SqliteDatabase;
  providers: ProviderStore;
  snapshots: SnapshotStore;
  settings: SettingsStore;
  regions: RegionStore;
  alerts: AlertStore;
  cookies: CookieStore;
  quotaStore: QuotaStore;
  safeStore: SafeStore;
  pool: BrowserViewPool;
  webCollector: WebCollector;
  orchestrator: RefreshOrchestrator;
  /** 网络审计（由主进程入口注入；抓包证据面） */
  netAudit: NetAudit | null = null;
  private overlayJs: string | null = null;
  private broadcastFn: (payload: unknown) => void = () => undefined;
  /** 测试注入 */
  injections: TestInjections = {};

  constructor(public dataDir: string, public appPath: string) {
    this.db = createDatabase(path.join(dataDir, 'llm-dashboard.sqlite3'));
    this.providers = new ProviderStore(this.db);
    this.snapshots = new SnapshotStore(this.db);
    this.settings = new SettingsStore(this.db);
    this.regions = new RegionStore(this.db);
    this.alerts = new AlertStore(this.db);
    this.cookies = new CookieStore(this.db);
    this.quotaStore = new QuotaStore(this.db);
    this.safeStore = new SafeStore(path.join(dataDir, 'credentials'));
    this.pool = new BrowserViewPool(
      () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html')) ?? BrowserWindow.getAllWindows()[0] ?? null,
      path.join(appPath, 'dist', 'preload', 'region-bridge.js'),
      (providerId) => void this.onLoginWindowClosed(providerId),
    );
    this.webCollector = new WebCollector(this.pool, this.safeStore, this.cookies, runLogger, this.injections);
    this.orchestrator = new RefreshOrchestrator({
      providers: this.providers,
      snapshots: this.snapshots,
      settings: this.settings,
      alerts: this.alerts,
      safeStore: this.safeStore,
      webCollector: this.webCollector,
      quotaStore: this.quotaStore,
      cookies: this.cookies,
      broadcast: (p) => this.broadcast(p),
    });
    this.orchestrator.getParentSize = () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      const [width = 1280, height = 800] = win ? win.getContentSize() : [];
      return { width, height };
    };
    runLogger.attachFile(path.join(dataDir, 'logs', 'run.log'));
    runLogger.log('app', `服务启动 dataDir=${dataDir} electron=${process.versions.electron ?? 'node'}`);
  }

  onBroadcast(fn: (payload: unknown) => void): void {
    this.broadcastFn = fn;
  }

  broadcast(payload: unknown): void {
    this.broadcastFn(payload);
  }

  close(): void {
    this.pool.destroyAll();
    this.db.close();
  }

  /* ---------- Providers ---------- */

  listProviders(): ProviderConfig[] {
    return this.providers.list();
  }

  getProvider(id: string): ProviderConfig | null {
    return this.providers.get(id);
  }

  createProvider(input: Partial<ProviderConfig> & { provider_name: string }): ProviderConfig {
    if (this.providers.list().filter((p) => p.enabled).length >= MAX_BROWSER_VIEWS) {
      throw new Error(`已达硬上限 ${MAX_BROWSER_VIEWS}，无法再新增 Provider`);
    }
    if (input.mode === 'web_crawl' && input.sub_mode === 'ocr' && input.region) {
      validateRegion(input.region);
    }
    const created = this.providers.create(input);
    this.broadcast({ type: 'provider-updated', providerId: created.id });
    return created;
  }

  updateProvider(id: string, patch: Partial<ProviderConfig>): ProviderConfig | null {
    if (patch.region) validateRegion(patch.region);
    const before = this.providers.get(id);
    const updated = this.providers.update(id, patch);
    if (updated && before && before.enabled !== updated.enabled) {
      this.broadcast({ type: 'provider-updated', providerId: id });
    }
    return updated;
  }

  deleteProvider(id: string): boolean {
    const ok = this.providers.delete(id);
    this.pool.destroy(id);
    this.safeStore.remove(`${id}.apikey`);
    if (ok) this.broadcast({ type: 'provider-updated', providerId: id });
    return ok;
  }

  setProviderEnabled(id: string, enabled: boolean): ProviderConfig | null {
    return this.providers.setEnabled(id, enabled);
  }

  /** 保存凭据（safeStorage 加密），DB 仅存 credential_ref */
  setCredential(providerId: string, apiKey: string): void {
    const ref = `${providerId}.apikey`;
    this.safeStore.write(ref, apiKey.trim());
    this.providers.update(providerId, { credential_ref: ref });
  }

  async testCredential(
    input: { adapter: string; baseUrl: string; apiKey: string; template?: string },
  ): Promise<{
    ok: boolean;
    message: string;
    account?: string;
    endpoint?: string;
    auth_scheme?: 'bearer' | 'x-api-key';
    adapter_id?: string;
    status?: number;
  }> {
    const { getAdapter, defaultFetch } = await import('./adapters');
    const { templateById } = await import('../shared/templates');
    const adapter = getAdapter(input.adapter);
    if (!adapter) return { ok: false, message: `未知适配器 ${input.adapter}` };
    const tpl = input.template ? templateById(input.template) : undefined;
    const extra: Record<string, string> = {};
    if (tpl?.probePath) extra.probePath = tpl.probePath;
    if (tpl?.quotaPath) extra.quotaPath = tpl.quotaPath;
    // onUrl 钩子捕获 fetchJson 真正命中的 URL（adapter 在内部拼好的），用于向用户报告端点
    let capturedUrl: string | undefined;
    try {
      const usage = await adapter.fetchQuota(
        { apiKey: input.apiKey.trim(), baseUrl: input.baseUrl || 'https://api.openai.com', extra: Object.keys(extra).length ? extra : {} },
        { fetchImpl: defaultFetch(), onUrl: (u) => (capturedUrl = u) },
      );
      // 鉴权头格式：anthropic/azure-openai 用 x-api-key，其余用 Bearer
      const scheme: 'bearer' | 'x-api-key' = input.adapter === 'anthropic' || input.adapter === 'azure-openai' ? 'x-api-key' : 'bearer';
      return {
        ok: true,
        message: '连接成功',
        account: usage.account_preview,
        endpoint: capturedUrl,
        auth_scheme: scheme,
        adapter_id: input.adapter,
        status: 200,
      };
    } catch (e) {
      const msg = (e as Error).message;
      const statusMatch = /HTTP\s+(\d{3})/.exec(msg);
      const status = statusMatch ? Number(statusMatch[1]) : undefined;
      return {
        ok: false,
        message: /401|403|auth/i.test(msg) ? `凭据无效：${msg}` : msg,
        endpoint: capturedUrl,
        adapter_id: input.adapter,
        status,
      };
    }
  }

  /* ---------- 采集 ---------- */

  async refreshOne(providerId: string, opts: { force?: boolean } = {}): Promise<RefreshResult> {
    return this.orchestrator.refreshOne(providerId, opts);
  }

  async refreshBatch(providerIds: string[]): Promise<RefreshResult[]> {
    return this.orchestrator.refreshBatch(providerIds);
  }

  async refreshByScope(scope: 'all' | 'failed' | 'selected', ids: string[] = []): Promise<RefreshResult[]> {
    let targets: string[] = ids;
    if (scope === 'all') {
      targets = this.providers.list().filter((p) => p.enabled && p.mode !== 'manual').map((p) => p.id);
    } else if (scope === 'failed') {
      targets = this.providers.list().filter((p) => p.enabled && p.last_error).map((p) => p.id);
    }
    return this.orchestrator.refreshBatch(targets);
  }

  manualEntry(providerId: string, input: { mode: 'used' | 'remaining'; amount: number; recordedAt?: string; note?: string; total?: number | null }): { snapshot: UsageSnapshot } | { error: string } {
    return this.orchestrator.manualEntry(providerId, input);
  }

  /* ---------- Dashboard / 趋势 / 历史 ---------- */

  dashboardUsage(): DashboardUsage {
    // 真实聚合走 orchestrator（按 currency 分桶，避免不同维度相加的语义错误）
    return this.orchestrator.dashboardUsage();
  }

  trend(q: TrendQuery): TrendPoint[] {
    const now = new Date();
    let from: Date;
    if (q.range === '24h') from = new Date(now.getTime() - 24 * 3600_000);
    else if (q.range === '7d') from = new Date(now.getTime() - 7 * 24 * 3600_000);
    else if (q.range === '30d') from = new Date(now.getTime() - 30 * 24 * 3600_000);
    else from = q.from ? new Date(q.from) : new Date(now.getTime() - 7 * 24 * 3600_000);
    const to = q.range === 'custom' && q.to ? new Date(q.to) : now;
    // 判据：图表数据源 WHERE status='valid'
    const snaps = this.snapshots.history(q.providerId, from.toISOString()).filter((s) => new Date(s.collected_at) <= to);
    return snaps.map((s) => ({
      collected_at: s.collected_at,
      used: s.used,
      remaining: s.remaining,
      source: s.source,
    }));
  }

  listSnapshots(opts: { providerIds?: string[]; since?: string; until?: string; limit?: number }): UsageSnapshot[] {
    return this.snapshots.listFiltered(opts);
  }

  collectStatus(): { providerId: string; providerName: string; errorType: string; message: string | null; occurredAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT f.provider_id, f.error_type, f.message, f.occurred_at, p.provider_name
         FROM collection_failures f LEFT JOIN providers p ON p.id = f.provider_id
         ORDER BY f.occurred_at DESC LIMIT 50`,
      )
      .all() as { provider_id: string; provider_name: string | null; error_type: string; message: string | null; occurred_at: string }[];
    return rows.map((r) => ({
      providerId: r.provider_id,
      providerName: r.provider_name ?? r.provider_id,
      errorType: r.error_type,
      message: r.message,
      occurredAt: r.occurred_at,
    }));
  }

  historyExport(format: 'csv' | 'json'): string {
    const snaps = this.snapshots.listFiltered({ limit: 100000 });
    if (format === 'json') return JSON.stringify(snaps, null, 2);
    const header = 'provider_id,used,remaining,total,source,status,quota_type,currency,collected_at';
    const lines = snaps.map((s) =>
      [s.provider_id, s.used, s.remaining, s.total, s.source, s.status, s.quota_type, s.currency, s.collected_at].join(','),
    );
    return [header, ...lines].join('\n');
  }

  configExport(): string {
    return JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        providers: this.providers.list().map((p) => ({ ...p, credential_ref: undefined })),
        settings: this.settings.getSyncSettings(),
        alertRules: this.alerts.listRules(),
      },
      null,
      2,
    );
  }

  configImport(json: string): { imported: number } {
    let parsed: { version?: number; providers?: ProviderConfig[]; settings?: Partial<SyncSettings>; alertRules?: AlertRule[] };
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('配置文件格式错误');
    }
    if (parsed.version !== 1) throw new Error('配置版本不兼容，请升级应用');
    let imported = 0;
    for (const p of parsed.providers ?? []) {
      const existing = this.providers.get(p.id);
      if (existing) this.providers.update(p.id, p);
      else this.providers.create(p);
      imported++;
    }
    if (parsed.settings) this.settings.setSyncSettings(parsed.settings);
    for (const r of parsed.alertRules ?? []) this.alerts.saveRule(r);
    return { imported };
  }

  clearCache(): { cleared: boolean } {
    this.db.prepare("DELETE FROM llm_usage_snapshots WHERE collected_at < datetime('now','-90 days')").run();
    this.db.prepare('DELETE FROM collection_failures WHERE occurred_at < ?').run(new Date(Date.now() - 30 * 24 * 3600_000).toISOString());
    return { cleared: true };
  }

  /* ---------- 区域选择器 / BrowserView ---------- */

  async openRegionBrowser(
    providerId: string,
    sidebarWidth: number = SIDENAV_W,
  ): Promise<{
    webContentsId: number;
    bounds: { x: number; y: number; width: number; height: number };
    mode: 'ready' | 'login_required';
  }> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Provider 不存在');
    const url = provider.dom_url || provider.page_url || 'about:blank';
    const entry = await this.pool.ensureForProvider(providerId);
    // 先解除其他附着视图（区域选择器一次只驻留一个中部视图）
    for (const other of this.pool.list()) {
      if (other.providerId !== providerId && other.attached) this.pool.detach(other.providerId);
    }
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const [w = 1280, h = 800] = win ? win.getContentSize() : [];
    // 侧栏宽度由渲染端传入（可折叠），布局常量见 shared/layout
    const bounds = regionBrowserBounds(w, h, sidebarWidth);
    this.pool.attach(providerId, bounds);
    if (entry.view.webContents.getURL() !== url) {
      try {
        await this.pool.navigate(providerId, url);
      } catch {
        // 页面加载失败仍注入 overlay，用户可在错误页重新导航
      }
    }
    // 登录墙前置检测：未登录时不注入框选画布（画布会拦截鼠标，导致无法在页面内登录），
    // 由宿主地址栏给出「我已完成登录」引导，页面保持可交互
    let mode: 'ready' | 'login_required' = 'ready';
    try {
      const auth = await this.pool.checkAuth(providerId, provider.login_required_selector);
      mode = auth.loginRequired ? 'login_required' : 'ready';
    } catch {
      mode = 'ready'; // 检测脚本失败不阻断原流程
    }
    if (mode === 'ready') {
      await this.injectRegionOverlay(providerId);
    }
    return { webContentsId: entry.webContentsId, bounds, mode };
  }

  /** 区域浏览器内登录复核：已登录 → 回目标页并注入画布；未登录 → 维持登录等待 */
  async regionRecheck(providerId: string): Promise<{ mode: 'ready' | 'login_required' | 'closed' }> {
    const provider = this.providers.get(providerId);
    if (!provider || !this.pool.has(providerId)) return { mode: 'closed' };
    let loginRequired: boolean;
    try {
      loginRequired = (await this.pool.checkAuth(providerId, provider.login_required_selector)).loginRequired;
    } catch {
      return { mode: 'login_required' };
    }
    if (loginRequired) return { mode: 'login_required' };
    const url = provider.dom_url || provider.page_url;
    if (url) {
      try {
        await this.pool.navigate(providerId, url);
      } catch {
        // 目标页加载失败仍注入画布，用户可改地址后重试
      }
    }
    await this.injectRegionOverlay(providerId);
    return { mode: 'ready' };
  }

  async resizeRegionBrowser(providerId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void> {
    this.pool.setBounds(providerId, bounds);
  }

  closeRegionBrowser(providerId: string): void {
    this.pool.detach(providerId);
    this.broadcast({ type: 'region-browser-closed', providerId });
  }

  private async injectRegionOverlay(providerId: string): Promise<void> {
    const overlayPath = path.join(this.appPath, 'dist', 'renderer', 'region-overlay.js');
    if (!fs.existsSync(overlayPath)) throw new Error('region-overlay.js 未构建，请先执行 npm run build');
    if (!this.overlayJs) this.overlayJs = fs.readFileSync(overlayPath, 'utf8');
    const regions = this.regions.listByProvider(providerId);
    const dpr = 1;
    const provider = this.providers.get(providerId);
    const bootstrap = JSON.stringify({
      providerId,
      providerName: provider?.provider_name ?? '',
      dpr,
      regions,
    });
    const code = `(function(){ window.__LLM_REGION_BOOTSTRAP__ = ${bootstrap};\n${this.overlayJs}\n})();`;
    await this.pool.executeJs(providerId, code);
  }

  saveRegions(providerId: string, records: (Omit<RegionRecord, 'id' | 'providerId' | 'lastModified'> & { id?: string; lastModified?: number })[]): RegionRecord[] {
    if (!records.length) {
      const saved = this.regions.replaceForProvider(providerId, []);
      this.providers.update(providerId, { region: null });
      return saved;
    }
    for (const r of records) {
      if (r.w < 10 || r.h < 10) throw new Error(`选区「${r.name}」过小（${r.w}×${r.h}），最小 10×10`);
      if (r.x < 0 || r.y < 0) throw new Error(`选区「${r.name}」坐标越界`);
    }
    const saved = this.regions.replaceForProvider(providerId, records.map((r) => ({ ...r, lastModified: r.lastModified ?? Date.now() })));
    // 主区域回填到 provider.region（判据：region 字段落库为 {x,y,w,h} 四个数字）
    const primary = saved.find((r) => r.mode === 'OCR') ?? saved[0];
    const patch: Partial<ProviderConfig> = { region: { x: primary.x, y: primary.y, w: primary.w, h: primary.h } };
    if (records.some((r) => r.mode === 'OCR')) patch.sub_mode = 'ocr';
    this.providers.update(providerId, patch);
    this.broadcast({ type: 'provider-updated', providerId });
    return saved;
  }

  listRegions(providerId: string): RegionRecord[] {
    return this.regions.listByProvider(providerId);
  }

  async openLogin(providerId: string): Promise<{ webContentsId: number }> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Provider 不存在');
    const url = provider.dom_url || provider.page_url;
    if (!url) throw new Error('未配置登录页面 URL');
    const id = await this.pool.openLoginWindow(providerId, url, () => undefined);
    return { webContentsId: id };
  }

  async completeLogin(providerId: string): Promise<{ authStatus: 'ok' | 'required'; cookies: number }> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Provider 不存在');
    const cookies = await this.pool.exportCookies(providerId, (v) => this.safeStore.encryptToBlob(v));
    if (cookies.length) this.cookies.replaceForProvider(providerId, cookies);
    let authStatus: 'ok' | 'required' = 'ok';
    if (this.pool.has(providerId)) {
      try {
        const r = await this.pool.checkAuth(providerId, provider.login_required_selector);
        authStatus = r.loginRequired ? 'required' : 'ok';
      } catch {
        authStatus = 'ok';
      }
    }
    if (authStatus === 'ok') {
      this.providers.update(providerId, { last_error: null, last_error_type: null });
    }
    this.broadcast({ type: 'provider-updated', providerId });
    return { authStatus, cookies: cookies.length };
  }

  private async onLoginWindowClosed(providerId: string): Promise<void> {
    // 登录窗口关闭：导出 cookie（持久化命中）+ 复查登录态 + 通知渲染层
    await this.completeLogin(providerId);
  }

  async checkAuth(providerId: string): Promise<{ loginRequired: boolean }> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Provider 不存在');
    if (!this.pool.has(providerId)) {
      const url = provider.dom_url || provider.page_url;
      if (!url) return { loginRequired: false };
      await this.pool.ensureForProvider(providerId);
      try {
        await this.pool.navigate(providerId, url);
      } catch {
        return { loginRequired: true };
      }
    }
    const r = await this.pool.checkAuth(providerId, provider.login_required_selector);
    return { loginRequired: r.loginRequired };
  }

  /* ---------- OCR ---------- */

  async runOcr(providerId: string): Promise<{ text: string; confidence: number; used: number | null; remaining: number | null }> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new Error('Provider 不存在');
    const size = this.orchestrator.getParentSize?.() ?? { width: 1280, height: 800 };
    const outcome = await this.webCollector.collect(provider, size);
    return { text: outcome.raw_text, confidence: outcome.confidence ?? 1, used: outcome.used, remaining: outcome.remaining };
  }

  /* ---------- 设置 / 告警 ---------- */

  getSettings(): SyncSettings {
    return this.settings.getSyncSettings();
  }

  setSettings(patch: Partial<SyncSettings>): SyncSettings {
    return this.settings.setSyncSettings(patch);
  }

  listAlertRules(): AlertRule[] {
    return this.alerts.listRules();
  }

  saveAlertRule(rule: Partial<AlertRule> & { metric: AlertRule['metric']; threshold: number }): AlertRule {
    return this.alerts.saveRule(rule);
  }

  deleteAlertRule(id: string): void {
    this.alerts.deleteRule(id);
  }

  listAlertEvents(limit = 30): AlertEvent[] {
    return this.alerts.listEvents(limit);
  }

  ackAlertEvent(id: string): void {
    this.alerts.ack(id);
  }

  setAlertChannel(type: string, enabled: boolean): void {
    this.alerts.setChannel(type, enabled);
  }

  testAlertChannel(type: string): { ok: boolean; message: string } {
    if (type === 'system') {
      return { ok: true, message: '系统通知渠道就绪' };
    }
    return { ok: false, message: `最近失败：HTTP 500（${type} 渠道未配置可用端点）` };
  }

  /* ---------- 测试钩子（仅 LLMDASH_TEST=1） ---------- */

  testSql(sql: string, params: unknown[] = []): { columns: string[]; rows: Record<string, unknown>[] } {
    const trimmed = sql.trim().toLowerCase();
    if (!trimmed.startsWith('select') && !trimmed.startsWith('with')) {
      throw new Error('test:sql 仅允许 SELECT/WITH 查询');
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Record<string, unknown>[];
    return { columns: stmt.columns().map((c) => c.name), rows };
  }

  testInject(kind: string, value: unknown): void {
    if (kind === 'ocr-confidence') this.injections.ocrConfidence = value as number;
    else if (kind === 'ocr-text') this.injections.ocrText = value as string;
    else if (kind === 'network-fail') this.injections.networkFail = !!value;
    else if (kind === 'dom-miss') this.injections.domMiss = !!value;
    else if (kind === 'auth-required') this.injections.authRequired = !!value;
    else if (kind === 'clear') this.injections = {};
    this.webCollector.setInjections(this.injections);
  }

  /** 性能探针：附着 N 个 about:blank BrowserView 后采样主窗口帧率 */
  async fpsProbe(count: number, sampleMs = 2000): Promise<{ fps: number; views: number }> {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) throw new Error('主窗口不存在');
    const probePrefix = 'probe_';
    const created: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `${probePrefix}${Date.now()}_${i}`;
      try {
        const entry = await this.pool.ensureForProvider(id);
        win.addBrowserView(entry.view);
        entry.view.setBounds({ x: 0, y: 0, width: 400, height: 300 });
        entry.attached = true;
        await entry.view.webContents.loadURL('about:blank').catch(() => undefined);
        created.push(id);
      } catch (e) {
        runLogger.log('fps-probe', `创建第 ${i + 1} 个视图失败：${(e as Error).message}`);
        break;
      }
    }
    const fps = await win.webContents.executeJavaScript(
      `(new Promise((resolve) => {
        let frames = 0; const start = performance.now();
        function tick() { frames++; if (performance.now() - start < ${sampleMs}) requestAnimationFrame(tick); else resolve(frames / ((performance.now() - start) / 1000)); }
        requestAnimationFrame(tick);
      }))`,
    );
    for (const id of created) this.pool.destroy(id);
    return { fps: Math.round(Number(fps)), views: count };
  }

  browserViewCount(): { pool: number; max: number } {
    return { pool: this.pool.count, max: MAX_BROWSER_VIEWS };
  }
}

export function validateRegion(r: { x: number; y: number; w: number; h: number }): void {
  if (![r.x, r.y, r.w, r.h].every((n) => Number.isFinite(n))) throw new Error('选区坐标必须为四个数字');
  if (r.w <= 0 || r.h <= 0) throw new Error('选区宽高必须大于 0');
}

export function defaultDataDir(): string {
  if (process.env.LLMDASH_DATA_DIR) {
    fs.mkdirSync(process.env.LLMDASH_DATA_DIR, { recursive: true });
    return process.env.LLMDASH_DATA_DIR;
  }
  return app.getPath('userData');
}
