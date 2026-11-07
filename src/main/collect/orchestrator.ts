import type {
  DashboardUsage,
  ProviderConfig,
  ProviderUsageView,
  RefreshProgress,
  SyncSettings,
  UsageSnapshot,
  RefreshResult,
} from '../../shared/types';
import type { ProviderStore } from '../db/providers';
import type { SnapshotStore, NewSnapshot } from '../db/snapshots';
import type { SettingsStore } from '../db/settings';
import type { AlertStore } from '../db/alerts';
import type { SafeStore } from '../credentials/safe-store';
import type { CookieStore } from '../db/cookies';
import type { QuotaStore } from '../db/quota-windows';
import type { QuotaWindowOut, SubscriptionOut } from '../adapters/types';
import { getAdapter } from '../adapters';
import { AdapterError } from '../adapters/types';
import { CollectError, toCollectError } from './errors';
import type { WebCollector } from './web-collector';
import { RunLogger, runLogger, sleep } from '../logger';
import { templateById } from '../../shared/templates';

export type { RefreshResult };

export interface OrchestratorDeps {
  providers: ProviderStore;
  snapshots: SnapshotStore;
  settings: SettingsStore;
  alerts: AlertStore;
  safeStore: SafeStore;
  webCollector: WebCollector;
  /** 会话 Cookie 存储；未注入时需要 Cookie 的适配器按「未登录」处理 */
  cookies?: CookieStore;
  /** 多额度窗口 + 订阅存储；未注入时窗口数据被丢弃（兼容既有单窗口测试） */
  quotaStore?: QuotaStore;
  logger?: RunLogger;
  broadcast: (payload: unknown) => void;
  now?: () => Date;
  sleepFn?: (ms: number) => Promise<void>;
}

export class RefreshOrchestrator {
  private running = false;

  private get log(): RunLogger {
    return this.d.logger ?? runLogger;
  }

  constructor(private d: OrchestratorDeps) {}

  private now(): Date {
    return (this.d.now ?? (() => new Date()))();
  }

  private async doSleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await (this.d.sleepFn ?? sleep)(ms);
  }

  async refreshOne(providerId: string, opts: { force?: boolean } = {}): Promise<RefreshResult> {
    const provider = this.d.providers.get(providerId);
    if (!provider) return { providerId, ok: false, reason: 'Provider 不存在', code: 'PROVIDER_NOT_FOUND' };
    if (!provider.enabled) return { providerId, ok: false, skipped: true, reason: 'Provider 已禁用', code: 'DISABLED' };
    if (provider.mode === 'manual') {
      return { providerId, ok: false, skipped: true, reason: '仅手动录入模式，无自动采集', code: 'MANUAL_ONLY' };
    }
    // 同一 Provider 两次刷新间隔 < min_refresh_seconds → 跳过并提示「操作过于频繁」
    if (!opts.force && provider.last_refresh_at) {
      const elapsed = (this.now().getTime() - new Date(provider.last_refresh_at).getTime()) / 1000;
      const min = this.d.settings.getSyncSettings().min_refresh_seconds;
      if (elapsed < min) {
        return { providerId, ok: false, skipped: true, reason: '操作过于频繁', code: 'REFRESH_TOO_FREQUENT' };
      }
    }
    return this.collectAndStore(provider);
  }

  private async collectAndStore(provider: ProviderConfig): Promise<RefreshResult> {
    try {
      let usage: { used: number | null; remaining: number | null; total: number | null; source: 'api' | 'dom' | 'ocr'; used_input?: number | null; used_output?: number | null; reset_at?: string | null; currency?: string };
      let windows: QuotaWindowOut[] = [];
      let subscription: SubscriptionOut | null = null;
      if (provider.mode === 'api') {
        const r = await this.collectViaApi(provider);
        usage = r.usage;
        windows = r.windows;
        subscription = r.subscription;
      } else {
        const parent = this.getParentSize?.();
        const outcome = await this.d.webCollector.collect(provider, parent ?? { width: 1280, height: 800 });
        usage = {
          used: outcome.used,
          remaining: outcome.remaining,
          total: outcome.total,
          source: outcome.source,
          reset_at: null,
        };
      }
      const remaining = usage.remaining ?? (usage.total !== null && usage.used !== null ? usage.total - usage.used : null);
      const currency = usage.currency ?? provider.currency;
      // quota_type 由 currency 推导（受 llm_usage_snapshots.quota_type CHECK 约束，仅 4 个合法值）：
      // TOKEN → 'token'、PERCENT → 'message'（纯百分比口径不落绝对值）、CREDIT/CNY → 'credit'、USD → 'usd'
      const quotaType: 'usd' | 'token' | 'credit' | 'message' =
        currency === 'TOKEN' ? 'token'
        : currency === 'USD' ? 'usd'
        : currency === 'PERCENT' ? 'message'
        : currency === 'CREDIT' || currency === 'CNY' ? 'credit'
        : 'usd';
      const snap = this.d.snapshots.insert({
        provider_id: provider.id,
        used: usage.used,
        remaining,
        total: usage.total ?? provider.quota_total ?? null,
        used_input: usage.used_input ?? null,
        used_output: usage.used_output ?? null,
        quota_type: quotaType,
        source: usage.source,
        status: 'valid',
        reset_at: usage.reset_at ?? null,
        currency,
      });
      // 多额度窗口与订阅挂在本次快照上；quotaStore 未注入时静默跳过（单窗口厂商无此数据）
      if (this.d.quotaStore) {
        if (windows.length) this.d.quotaStore.replaceForSnapshot(snap.id, provider.id, windows, snap.collected_at);
        if (subscription) this.d.quotaStore.upsertSubscription(provider.id, subscription);
      }
      // 适配器报上来的口径与 provider 手工声明不一致时，同步回 provider：
      // 否则配置页与按 currency 分桶的汇总会一直用旧口径（如把额度点数当 CNY）
      const providerPatch: Partial<ProviderConfig> = { last_refresh_at: new Date().toISOString(), last_error: null, last_error_type: null };
      if (currency !== provider.currency) providerPatch.currency = currency;
      this.d.providers.update(provider.id, providerPatch);
      this.evaluateAlerts(provider, snap);
      this.log.log('orchestrator', `provider=${provider.id} 刷新成功 source=${usage.source} used=${usage.used} remaining=${remaining} windows=${windows.length}`);
      return { providerId: provider.id, ok: true, snapshot: snap };
    } catch (e) {
      const ce = toCollectError(e);
      // 失败不写快照，仅记录失败原因与连续失败计数
      this.d.providers.update(provider.id, { last_error: ce.message, last_error_type: ce.code });
      this.recordFailure(provider, ce.code, ce.message);
      this.log.log('orchestrator', `provider=${provider.id} 刷新失败 code=${ce.code} reason=${ce.message}`);
      return { providerId: provider.id, ok: false, reason: ce.message, code: ce.code };
    }
  }

  private async collectViaApi(provider: ProviderConfig): Promise<{ usage: { used: number | null; remaining: number | null; total: number | null; source: 'api'; reset_at: string | null; used_input?: number | null; used_output?: number | null; currency?: string }; windows: QuotaWindowOut[]; subscription: SubscriptionOut | null }> {
    const adapter = getAdapter(provider.adapter);
    if (!adapter) {
      throw new AdapterError('parse_error', `该厂商暂无内置 API 适配器（${provider.adapter ?? '未指定'}），请使用网页抓取或手动录入`);
    }
    const apiKey = provider.credential_ref ? this.d.safeStore.read(provider.credential_ref) ?? '' : '';
    // OpenAI 兼容厂商模板带 probePath 时透传到 extra，触发 openai-compatible 分支
    const tpl = provider.template ? templateById(provider.template) : undefined;
    const extra: Record<string, string> = {};
    if (tpl?.probePath) extra.probePath = tpl.probePath;
    if (tpl?.quotaPath) extra.quotaPath = tpl.quotaPath;
    const usage = await adapter.fetchQuota(
      {
        apiKey,
        baseUrl: provider.base_url || 'https://api.openai.com',
        extra: Object.keys(extra).length ? extra : {},
        cookie: this.readCookieHeader(provider.id),
      },
      { fetchImpl: (await import('../adapters')).defaultFetch() },
    );
    return {
      usage: {
        used: usage.used,
        remaining: usage.remaining,
        total: usage.total ?? provider.quota_total ?? null,
        source: 'api',
        reset_at: usage.reset_at ?? null,
        used_input: usage.used_input ?? null,
        used_output: usage.used_output ?? null,
        currency: usage.currency,
      },
      windows: usage.windows ?? [],
      subscription: usage.subscription ?? null,
    };
  }

  /**
   * 把 cookies 表里该 provider 的会话 Cookie 拼成请求头用的 Cookie 串。
   * 供「额度接口只认网页登录态」的厂商（MiniMax Token Plan）使用；
   * 未配置 Cookie 时返回 null，由适配器决定如何报错。
   */
  private readCookieHeader(providerId: string): string | null {
    const store = this.d.cookies;
    if (!store) return null;
    try {
      const rows = store.listByProvider(providerId);
      const parts = rows
        .map((r) => ({ name: r.name, value: this.d.safeStore.decryptBlob(r.value_encrypted) }))
        .filter((c) => c.value)
        .map((c) => `${c.name}=${c.value}`);
      return parts.length ? parts.join('; ') : null;
    } catch {
      // 凭据解密失败不应让整次采集崩溃，交给适配器按「无 Cookie」路径报错
      return null;
    }
  }

  private failures = new Map<string, number>();

  private recordFailure(provider: ProviderConfig, code: string, message: string): void {
    const count = (this.failures.get(provider.id) ?? 0) + 1;
    this.failures.set(provider.id, count);
    try {
      this.d.providers.rawDb
        .prepare(
          'INSERT INTO collection_failures (id, provider_id, error_type, message, consecutive_count, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(`fail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, provider.id, mapErrorType(code), message, count, new Date().toISOString());
    } catch {
      // 采集失败记录为尽力而为
    }
  }

  /**
   * 批量刷新：策略并行/串行/分批（settings.strategy / batch_size / interval_seconds）。
   * 三种策略下相邻 provider 之间均有 `await sleep(interval_seconds)`（并行=同车道两次取件之间），
   * 日志输出 `await sleep(N)`（N ≥ 配置的 interval_seconds），规避厂商风控。
   */
  async refreshBatch(
    providerIds: string[],
    opts: { progress?: (p: RefreshProgress) => void } = {},
  ): Promise<RefreshResult[]> {
    const settings: SyncSettings = this.d.settings.getSyncSettings();
    const providers = providerIds
      .map((id) => this.d.providers.get(id))
      .filter((p): p is ProviderConfig => !!p && !!p.enabled && p.mode !== 'manual');
    const results: RefreshResult[] = [];
    const progress: RefreshProgress = { total: providers.length, done: 0, currentProviderId: null, currentProviderName: null, finished: false };
    let doneCount = 0;
    this.running = true;
    const emit = () => {
      this.d.broadcast({ type: 'refresh-progress', progress: { ...progress } });
      opts.progress?.({ ...progress });
    };
    emit();

    const runOne = async (p: ProviderConfig) => {
      progress.currentProviderId = p.id;
      progress.currentProviderName = p.provider_name;
      emit();
      const r = await this.collectAndStore(p);
      doneCount += 1;
      progress.done = doneCount;
      results.push(r);
      emit();
    };

    try {
      if (settings.strategy === 'parallel') {
        // 并行：并发上限 = batch_size（worker 车道数）；同车道相邻 provider 之间仍 sleep(interval_seconds)
        const cap = Math.max(1, settings.batch_size);
        this.log.log('orchestrator', `批量刷新 strategy=parallel 并发=${Math.min(cap, providers.length)} interval=${settings.interval_seconds}s`);
        let idx = 0;
        const workers = Array.from({ length: Math.min(cap, providers.length) }, async () => {
          let lanePicked = 0;
          while (idx < providers.length) {
            const i = idx++;
            if (lanePicked > 0 && settings.interval_seconds > 0) {
              const n = settings.interval_seconds;
              this.log.log('orchestrator', `provider=${providers[i].id} 前 await sleep(${n}) (interval_seconds=${settings.interval_seconds}, strategy=parallel)`);
              await this.doSleep(n * 1000);
            }
            lanePicked += 1;
            await runOne(providers[i]);
          }
        });
        await Promise.all(workers);
      } else if (settings.strategy === 'serial') {
        this.log.log('orchestrator', `批量刷新 strategy=serial interval=${settings.interval_seconds}s`);
        for (let i = 0; i < providers.length; i++) {
          if (i > 0 && settings.interval_seconds > 0) {
            const n = settings.interval_seconds;
            this.log.log('orchestrator', `provider=${providers[i].id} 前 await sleep(${n}) (interval_seconds=${settings.interval_seconds})`);
            await this.doSleep(n * 1000);
          }
          await runOne(providers[i]);
        }
      } else {
        // batch（默认）：每批 batch_size 个并行，批间 sleep(interval_seconds)
        this.log.log('orchestrator', `批量刷新 strategy=batch batch_size=${settings.batch_size} interval=${settings.interval_seconds}s`);
        for (let start = 0; start < providers.length; start += settings.batch_size) {
          const batch = providers.slice(start, start + settings.batch_size);
          if (start > 0 && settings.interval_seconds > 0) {
            this.log.log('orchestrator', `批间 await sleep(${settings.interval_seconds}) (interval_seconds=${settings.interval_seconds})`);
            await this.doSleep(settings.interval_seconds * 1000);
          }
          await Promise.all(batch.map((p) => runOne(p)));
        }
      }
    } finally {
      progress.finished = true;
      progress.currentProviderId = null;
      progress.currentProviderName = null;
      emit();
      this.running = false;
    }
    return results;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * 告警引擎（同步：快照落库后即刻判定，返回前告警事件已持久化，手动录入链路无竞态）：
   * 剩余 ≤ provider.alert_threshold 或命中规则 → 告警事件（30 分钟去重）
   */
  private evaluateAlerts(provider: ProviderConfig, snap: UsageSnapshot): void {
    if (snap.remaining === null) return;
    if (provider.alert_threshold > 0 && snap.remaining <= provider.alert_threshold) {
      this.pushAlertEvent({
        rule_id: `provider:${provider.id}`,
        provider_id: provider.id,
        provider_name: `${provider.provider_name}（${provider.alias || '默认'}）`,
        snapshot_id: snap.id,
        message: `剩余额度 ${snap.remaining} ${snap.currency} 已低于告警阈值 ${provider.alert_threshold}`,
      });
    }
    for (const rule of this.d.alerts.listRules()) {
      if (!rule.enabled) continue;
      if (rule.provider_id && rule.provider_id !== provider.id) continue;
      const hit =
        rule.metric === 'remaining_abs'
          ? snap.remaining <= rule.threshold
          : rule.metric === 'remaining_pct'
            ? snap.total !== null && snap.total > 0 && (snap.remaining / snap.total) * 100 <= rule.threshold
            : false;
      if (!hit) continue;
      const last = this.d.alerts.lastEventForRule(rule.id);
      if (last && Date.now() - new Date(last.triggered_at).getTime() < rule.dedupe_minutes * 60_000) continue;
      this.pushAlertEvent({
        rule_id: rule.id,
        provider_id: provider.id,
        provider_name: `${provider.provider_name}（${provider.alias || '默认'}）`,
        snapshot_id: snap.id,
        message: `规则触发：${rule.metric} 阈值 ${rule.threshold}，当前剩余 ${snap.remaining}`,
      });
    }
  }

  private pushAlertEvent(e: { rule_id: string; provider_id: string; provider_name: string; snapshot_id: string | null; message: string }): void {
    const event = this.d.alerts.insertEvent({ ...e, triggered_at: new Date().toISOString(), acknowledged: 0 });
    this.d.broadcast({ type: 'alert-triggered', event });
  }

  getParentSize: (() => { width: number; height: number }) | null = null;

  /** Dashboard 聚合视图 */
  dashboardUsage(): DashboardUsage {
    const providers = this.d.providers.list().filter((p) => p.enabled);
    const views: ProviderUsageView[] = providers.map((p) => buildUsageView(p, this.d.snapshots, this.d.quotaStore));
    const used = views.reduce((a, v) => a + (v.used ?? 0), 0);
    const remaining = views.reduce((a, v) => a + (v.remaining ?? 0), 0);
    // 按 currency 分桶：避免不同维度（TOKEN/USD/CNY）直接相加的语义错误
    const buckets = new Map<string, { used: number; remaining: number; total: number; provider_count: number }>();
    for (const v of views) {
      const cur = v.currency || 'USD';
      const cur0 = buckets.get(cur) ?? { used: 0, remaining: 0, total: 0, provider_count: 0 };
      cur0.used += v.used ?? 0;
      cur0.remaining += v.remaining ?? 0;
      cur0.total += v.total ?? 0;
      cur0.provider_count += 1;
      buckets.set(cur, cur0);
    }
    return {
      updated_at: new Date().toISOString(),
      summary: { used: Math.round(used * 100) / 100, remaining: Math.round(remaining * 100) / 100, currency: views[0]?.currency ?? 'USD' },
      byCurrency: Array.from(buckets.entries())
        .map(([currency, b]) => ({
          currency,
          used: Math.round(b.used * 100) / 100,
          remaining: Math.round(b.remaining * 100) / 100,
          total: Math.round(b.total * 100) / 100,
          provider_count: b.provider_count,
        }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      providers: views,
    };
  }

  /**
   * 手动录入兜底（≤3 次点击路径的终点）：生成 status=valid、source=manual 快照。
   * 快照与自动采集同一口径：返回前同步执行告警判定（AC：手动录入参与告警判断），
   * 趋势图数据源按 status='valid' 过滤，故自动纳入趋势。
   */
  manualEntry(providerId: string, input: { mode: 'used' | 'remaining'; amount: number; recordedAt?: string; note?: string; total?: number | null }): { snapshot: UsageSnapshot } | { error: string } {
    const provider = this.d.providers.get(providerId);
    if (!provider) return { error: 'Provider 不存在' };
    if (!Number.isFinite(input.amount) || input.amount < 0) return { error: '数值异常，请确认' };
    if (input.total !== null && input.total !== undefined && input.amount > input.total * 10) {
      return { error: '数值异常，请确认' };
    }
    const total = input.total ?? provider.quota_total ?? null;
    const used = input.mode === 'used' ? input.amount : null;
    const remaining = input.mode === 'remaining' ? input.amount : total !== null && used !== null ? total - used : null;
    const snapshot = this.d.snapshots.insert({
      provider_id: providerId,
      used,
      remaining,
      total,
      source: 'manual',
      status: 'valid',
      collected_at: input.recordedAt ? new Date(input.recordedAt).toISOString() : undefined,
    });
    this.d.providers.update(providerId, { last_error: null, last_error_type: null });
    void input.note;
    // 手动快照与采集快照走同一条告警判定链路（剩余 ≤ 阈值 + 用户规则）
    if (snapshot.remaining !== null) {
      this.evaluateAlerts(provider, snapshot);
    }
    return { snapshot };
  }
}

export function buildUsageView(p: ProviderConfig, snapshots: SnapshotStore, quotaStore?: QuotaStore): ProviderUsageView {
  const latest = snapshots.latest(p.id);
  const lastFailed = !!p.last_error;
  // 额度接口只认网页会话的厂商（MiniMax Token Plan / MiMo）鉴权失败时，动作应是「登录」而非「检查 Key」
  const needsLogin = p.adapter === 'minimax' || p.adapter === 'xiaomi-mimo';
  const authRequired = p.last_error_type === 'login_expired' || (needsLogin && p.last_error_type === 'auth_expired');
  const total = latest?.total ?? p.quota_total ?? null;
  const used = latest?.used ?? null;
  const remaining = latest?.remaining ?? null;
  // 订阅型厂商（智谱）快照 total 来自 CREDIT 额度，含义与「¥500 余额」不同：
  // 有窗口数据时百分比以最紧张的窗口为准，避免顶层进度条误导
  const windows = quotaStore?.latestForProvider(p.id) ?? [];
  const subscription = quotaStore?.getSubscription(p.id) ?? null;
  const pctFromWindows = windows.length
    ? Math.max(...windows.map((w) => w.percent_used ?? 0))
    : null;
  const percent =
    pctFromWindows !== null
      ? pctFromWindows
      : total !== null && total > 0 && used !== null
        ? (used / total) * 100
        : null;
  const band: 'low' | 'mid' | 'high' = percent === null ? 'low' : percent > 85 ? 'high' : percent >= 60 ? 'mid' : 'low';
  const alert = remaining !== null && p.alert_threshold > 0 && remaining <= p.alert_threshold;
  return {
    id: p.id,
    provider_name: p.provider_name,
    alias: p.alias,
    mode: p.mode,
    sub_mode: p.sub_mode,
    enabled: p.enabled,
    used,
    remaining,
    total,
    percent_used: percent === null ? null : Math.round(percent * 10) / 10,
    // 额度维度以「实际采到的快照口径」为准：provider.currency 是建配置时的手工声明，
    // 厂商改口径后（如智谱 CNY → CREDIT 额度点数）不会自动跟着变，会把点数错渲染成 ¥。
    // 非 API 采集（web_crawl / 手动录入）没有适配器可问，才回落到 provider 声明值。
    currency: latest && latest.source === 'api' ? (latest.currency ?? p.currency) : p.currency,
    source: latest?.source ?? null,
    collected_at: latest?.collected_at ?? null,
    status: lastFailed ? 'failed' : latest ? (latest.source === 'manual' ? 'manual-override' : 'ok') : 'never',
    fail_reason: lastFailed ? p.last_error : null,
    fail_action: lastFailed ? (authRequired ? 'login' : p.sub_mode === 'ocr' ? 'reselect-region' : p.mode === 'api' ? 'test-credential' : 'manual-entry') : null,
    auth_required: authRequired,
    alert,
    alert_threshold: p.alert_threshold,
    progress_band: band,
    windows,
    subscription,
  };
}

function mapErrorType(code: string): string {
  switch (code) {
    case 'login_expired':
    case 'auth_expired':
      return 'login_expired';
    case 'selector_missing':
      return 'selector_missing';
    case 'ocr_low_confidence':
    case 'ocr_engine_unavailable':
      return 'ocr_low_confidence';
    case 'adapter_upstream_error':
      return 'adapter_upstream_error';
    case 'browserview_unavailable':
      return 'browserview_unavailable';
    case 'parse_error':
      return 'parse_error';
    default:
      return 'network';
  }
}

export type { NewSnapshot };
