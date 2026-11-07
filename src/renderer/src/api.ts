import type {
  AlertEvent,
  AlertRule,
  DashboardUsage,
  ProviderConfig,
  RefreshProgress,
  RefreshResult,
  RegionRecord,
  SyncSettings,
  TrendPoint,
  UsageSnapshot,
} from '../../shared/types';
import { IPC } from '../../shared/types';

export interface Envelope<T> {
  code: number | string;
  data?: T;
  message?: string;
}

interface LlmBridgeLike {
  invoke(channel: string, payload?: unknown): Promise<Envelope<unknown>>;
  onEvent(listener: (payload: unknown) => void): () => void;
}

function bridge(): LlmBridgeLike {
  return (window as unknown as { llm: LlmBridgeLike }).llm;
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const res = await bridge().invoke(channel, payload);
  if (res.code !== 0) {
    throw new Error(res.message || `IPC ${channel} 失败（${res.code}）`);
  }
  return res.data as T;
}

export const api = {
  systemInfo: () => call<{ version: string; dataDir: string; maxBrowserViews: number }>(IPC.systemInfo),
  providersList: () => call<ProviderConfig[]>(IPC.providersList),
  providerGet: (id: string) => call<ProviderConfig | null>(IPC.providersGet, { id }),
  providerCreate: (p: Partial<ProviderConfig> & { provider_name: string }) => call<ProviderConfig>(IPC.providersCreate, p),
  providerUpdate: (id: string, patch: Partial<ProviderConfig>) => call<ProviderConfig>(IPC.providersUpdate, { id, ...patch }),
  providerDelete: (id: string) => call<boolean>(IPC.providersDelete, { id }),
  providerSetEnabled: (id: string, enabled: boolean) => call<ProviderConfig>(IPC.providersSetEnabled, { id, enabled }),

  dashboardUsage: () => call<DashboardUsage>(IPC.dashboardUsage),
  refreshOne: (providerId: string, opts: { force?: boolean } = {}) =>
    call<RefreshResult>(IPC.refreshOne, { providerId, ...opts }),
  refreshBatch: (scope: 'all' | 'failed' | 'selected', ids: string[] = []) =>
    call<RefreshResult[]>(IPC.refreshBatch, { scope, ids }),

  trend: (q: { providerId: string; range: '24h' | '7d' | '30d' | 'custom'; from?: string; to?: string }) =>
    call<TrendPoint[]>(IPC.snapshotsHistory, q),
  snapshotsList: (opts: { providerIds?: string[]; since?: string; until?: string; limit?: number }) =>
    call<UsageSnapshot[]>(IPC.snapshotsList, opts),
  manualEntry: (providerId: string, input: { mode: 'used' | 'remaining'; amount: number; recordedAt?: string; note?: string; total?: number | null }) =>
    call<{ snapshot: UsageSnapshot }>(IPC.manualEntry, { providerId, ...input }),

  credentialTest: (input: { adapter: string; baseUrl: string; apiKey: string; template?: string }) =>
    call<{
      ok: boolean;
      message: string;
      account?: string;
      endpoint?: string;
      auth_scheme?: 'bearer' | 'x-api-key';
      adapter_id?: string;
      status?: number;
    }>(IPC.credentialsTest, input),
  credentialSet: (providerId: string, apiKey: string) => call<{ ok: boolean }>(IPC.credentialsSet, { providerId, apiKey }),

  regionSave: (providerId: string, regions: Partial<RegionRecord>[]) =>
    call<RegionRecord[]>(IPC.regionSave, { providerId, regions }),
  regionList: (providerId: string) => call<RegionRecord[]>(IPC.regionList, { providerId }),

  browserOpen: (providerId: string, sidebarWidth?: number) =>
    call<{ webContentsId: number; mode: 'ready' | 'login_required' }>(IPC.browserOpen, { providerId, sidebarWidth }),
  browserResize: (providerId: string, bounds: { x: number; y: number; width: number; height: number }) =>
    call<void>(IPC.browserResize, { providerId, bounds }),
  browserClose: (providerId: string) => call<void>(IPC.browserClose, { providerId }),
  browserRecheck: (providerId: string) =>
    call<{ mode: 'ready' | 'login_required' | 'closed' }>(IPC.regionRecheck, { providerId }),
  browserCheckAuth: (providerId: string) => call<{ loginRequired: boolean }>(IPC.browserCheckAuth, { providerId }),
  loginOpen: (providerId: string) => call<{ webContentsId: number }>(IPC.browserOpenLogin, { providerId }),
  loginComplete: (providerId: string) => call<{ authStatus: string; cookies: number }>(IPC.loginComplete, { providerId }),

  ocrRun: (providerId: string) => call<{ text: string; confidence: number }>(IPC.ocrRun, { providerId }),

  settingsGet: () => call<SyncSettings>(IPC.settingsGet),
  settingsSet: (patch: Partial<SyncSettings>) => call<SyncSettings>(IPC.settingsSet, patch),

  alertRulesList: () => call<AlertRule[]>(IPC.alertsRulesList),
  alertRuleSave: (rule: Partial<AlertRule> & { metric: AlertRule['metric']; threshold: number }) =>
    call<AlertRule>(IPC.alertsRuleSave, rule),
  alertRuleDelete: (id: string) => call<{ ok: boolean }>(IPC.alertsRuleDelete, { id }),
  alertEventsList: (limit = 30) => call<AlertEvent[]>(IPC.alertsEventsList, { limit }),
  alertEventAck: (id: string) => call<{ ok: boolean }>(IPC.alertsEventsAck, { id }),
  alertChannelSet: (type: string, enabled: boolean) => call<{ ok: boolean }>(IPC.alertsChannelSet, { type, enabled }),
  alertChannelTest: (type: string) => call<{ ok: boolean; message: string }>(IPC.alertsChannelTest, { type }),

  collectStatus: () => call<{ providerId: string; providerName: string; errorType: string; message: string | null; occurredAt: string }[]>(IPC.collectStatus),
  historyExport: (format: 'csv' | 'json') => call<string>(IPC.historyExport, { format }),
  configExport: () => call<string>(IPC.configExport),
  configImport: (json: string) => call<{ imported: number }>(IPC.configImport, { json }),
  cacheClear: () => call<{ cleared: boolean }>(IPC.cacheClear),

  // 测试钩子（LLMDASH_TEST=1）
  testSql: (sql: string, params: unknown[] = []) => call<{ columns: string[]; rows: Record<string, unknown>[] }>(IPC.testSql, { sql, params }),
  testInject: (kind: string, value?: unknown) => call<{ ok: boolean }>(IPC.testInject, { kind, value }),
  fpsProbe: (count: number, sampleMs = 2000) => call<{ fps: number; views: number }>(IPC.fpsProbe, { count, sampleMs }),
  browserViewCount: () => call<{ pool: number; max: number }>(IPC.browserViewCount),

  onEvent: (listener: (payload: unknown) => void): (() => void) => bridge().onEvent(listener),
};

export type RefreshProgressLike = RefreshProgress;
