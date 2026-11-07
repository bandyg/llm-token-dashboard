/** 采集模式：官方 API / BrowserView 网页抓取 / 仅手动录入 */
export type ProviderMode = 'api' | 'web_crawl' | 'manual';
/** web_crawl 下的提取方式 */
export type ProviderSubMode = 'dom' | 'ocr';

export interface ProviderConfig {
  id: string;
  /** 厂商名（同一厂商可多条记录） */
  provider_name: string;
  /** 记录别名（多账号区分，如「主号」「小号」） */
  alias: string;
  template: string;
  mode: ProviderMode;
  sub_mode: ProviderSubMode | null;
  adapter: string | null;
  enabled: 0 | 1;
  base_url: string | null;
  page_url: string | null;
  dom_url: string | null;
  dom_script: string | null;
  /** DOM 选择器列表 [{name, selector}] */
  selectors: DomSelector[];
  /** OCR 选区（主区域 {x,y,w,h}，页面坐标） */
  region: Region | null;
  ocr_threshold: number;
  login_required_selector: string | null;
  quota_total: number | null;
  currency: string;
  alert_threshold: number;
  /** 凭据引用（safeStorage 加密文件指针，非明文） */
  credential_ref: string | null;
  last_refresh_at: string | null;
  last_error: string | null;
  last_error_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomSelector {
  name: string;
  selector: string;
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 25_UI_UX IndexedDB regions 表字段 */
export interface RegionRecord {
  id: string;
  providerId: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mode: 'DOM' | 'OCR';
  selector?: string;
  lastModified: number;
}

/** 额度窗口：订阅型厂商的一个限额维度（如 5 小时 / 每周 / 月度 MCP）。
 *  快照表的 used/remaining 只能表达单一数值，多窗口场景（智谱 Coding Plan）走独立表。 */
export interface QuotaWindow {
  id: string;
  snapshot_id: string;
  provider_id: string;
  /** 稳定标识：five_hour | weekly | monthly_mcp | fallback_0..n */
  window_key: string;
  /** 展示名：5 小时剩余 / 每周剩余 / ZCode MCP */
  window_label: string;
  /** 已用百分比（0-100），API 只给百分比的窗口用它 */
  percent_used: number | null;
  used: number | null;
  remaining: number | null;
  total: number | null;
  /** '%' 表示百分比口径，'次'/'tokens' 表示绝对值口径 */
  unit: string;
  reset_at: string | null;
  collected_at: string;
}

/** 订阅信息（智谱 /api/biz/subscription/list），用于展示套餐名与续费日期 */
export interface SubscriptionInfo {
  provider_id: string;
  product_name: string | null;
  level: string | null;
  status: string | null;
  valid_from: string | null;
  valid_to: string | null;
  next_renew_at: string | null;
  auto_renew: 0 | 1;
  billing_cycle: string | null;
  updated_at: string;
}

export type SnapshotStatus = 'valid' | 'invalid';
export type SnapshotSource = 'api' | 'dom' | 'ocr' | 'manual';

/** 刷新编排器单条结果；renderer 用 snapshot 字段在 toast 上报数字 */
export interface RefreshResult {
  providerId: string;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  code?: string;
  snapshot?: UsageSnapshot;
}

export interface UsageSnapshot {
  id: string;
  provider_id: string;
  used: number | null;
  remaining: number | null;
  total: number | null;
  used_input: number | null;
  used_output: number | null;
  quota_type: 'usd' | 'token' | 'credit' | 'message';
  currency: string;
  source: SnapshotSource;
  status: SnapshotStatus;
  error: string | null;
  reset_at: string | null;
  collected_at: string;
  created_at: string;
}

/** Dashboard 卡片聚合数据 */
export interface ProviderUsageView {
  id: string;
  provider_name: string;
  alias: string;
  mode: ProviderMode;
  sub_mode: ProviderSubMode | null;
  enabled: 0 | 1;
  used: number | null;
  remaining: number | null;
  total: number | null;
  percent_used: number | null;
  currency: string;
  source: SnapshotSource | null;
  collected_at: string | null;
  /** ok | failed | never | manual-override */
  status: 'ok' | 'failed' | 'never' | 'manual-override';
  fail_reason: string | null;
  fail_action: 'manual-entry' | 'reselect-region' | 'login' | 'test-credential' | null;
  auth_required: boolean;
  alert: boolean;
  alert_threshold: number;
  progress_band: 'low' | 'mid' | 'high';
  /** 该 provider 最新快照下的多额度窗口（订阅型厂商才有，普通厂商为空数组） */
  windows: QuotaWindow[];
  /** 订阅信息（套餐名 / 续费日期），无订阅概念的厂商为 null */
  subscription: SubscriptionInfo | null;
}

export interface DashboardUsage {
  updated_at: string;
  /** 单一汇总（保留字段，默认显示「全维度」汇总，仅在所有 provider 同 currency 时数值才有意义） */
  summary: { used: number; remaining: number; currency: string };
  /** 按 currency 分桶的真实汇总（多维度 provider 共存时使用，避免 token + USD 直接相加的语义错误） */
  byCurrency: Array<{ currency: string; used: number; remaining: number; total: number; provider_count: number }>;
  providers: ProviderUsageView[];
}

export type RefreshScope = 'all' | 'failed' | 'selected';

export interface SyncSettings {
  strategy: 'batch' | 'parallel' | 'serial';
  batch_size: number;
  interval_seconds: number;
  min_refresh_seconds: number;
  default_alert_threshold: number;
  ocr_threshold_default: number;
  theme: 'light' | 'dark';
  sync_all_cooldown_ms: number;
}

export interface RefreshProgress {
  total: number;
  done: number;
  currentProviderId: string | null;
  currentProviderName: string | null;
  finished: boolean;
}

export type FailReasonCode =
  | 'network'
  | 'auth_expired'
  | 'login_expired'
  | 'selector_missing'
  | 'ocr_low_confidence'
  | 'ocr_engine_unavailable'
  | 'parse_error'
  | 'rate_limited'
  | 'adapter_upstream_error'
  | 'browserview_unavailable'
  | 'unknown';

export const FAIL_REASON_TEXT: Record<FailReasonCode, string> = {
  network: '网络异常，无法连接采集目标',
  auth_expired: '凭据无效，请检查 API Key',
  login_expired: '登录态已失效，请重新登录',
  selector_missing: 'DOM 选择器失效：未在页面中命中元素',
  ocr_low_confidence: 'OCR 置信度低于阈值，请重新框选或手动录入',
  ocr_engine_unavailable: '本地 OCR 引擎不可用',
  parse_error: '响应解析失败：未找到可用额度数字',
  rate_limited: '操作过于频繁，请稍后再试',
  adapter_upstream_error: '厂商接口返回错误',
  browserview_unavailable: '页面加载失败或被拦截',
  unknown: '未知错误',
};

export interface TrendPoint {
  collected_at: string;
  used: number | null;
  remaining: number | null;
  source: SnapshotSource;
}

export interface AlertRule {
  id: string;
  provider_id: string | null;
  metric: 'remaining_pct' | 'remaining_abs' | 'daily_used';
  threshold: number;
  enabled: 0 | 1;
  dedupe_minutes: number;
  created_at: string;
}

export interface AlertEvent {
  id: string;
  rule_id: string;
  provider_id: string;
  provider_name: string;
  snapshot_id: string | null;
  message: string;
  triggered_at: string;
  acknowledged: 0 | 1;
}

export const IPC = {
  systemInfo: 'llm:system:info',
  appVersion: 'llm:system:version',
  providersList: 'llm:providers:list',
  providersGet: 'llm:providers:get',
  providersCreate: 'llm:providers:create',
  providersUpdate: 'llm:providers:update',
  providersDelete: 'llm:providers:delete',
  providersSetEnabled: 'llm:providers:set-enabled',
  dashboardUsage: 'llm:dashboard:usage',
  refreshOne: 'llm:refresh:one',
  refreshBatch: 'llm:refresh:batch',
  snapshotsHistory: 'llm:snapshots:history',
  snapshotsList: 'llm:snapshots:list',
  manualEntry: 'llm:usage:manual',
  credentialsTest: 'llm:credentials:test',
  credentialsSet: 'llm:credentials:set',
  regionSave: 'llm:region:save',
  regionList: 'llm:region:list',
  /** overlay→主进程：登录墙复核（我已完成登录） */
  regionRecheck: 'llm:region:recheck',
  /** overlay→主进程：取消并关闭区域浏览器（退出采集会话） */
  regionExit: 'llm:region:exit',
  browserOpen: 'llm:browser:open',
  browserResize: 'llm:browser:resize',
  browserClose: 'llm:browser:close',
  browserCheckAuth: 'llm:browser:check-auth',
  browserOpenLogin: 'llm:browser:open-login',
  loginComplete: 'llm:browser:login-complete',
  ocrRun: 'llm:ocr:run',
  settingsGet: 'llm:settings:get',
  settingsSet: 'llm:settings:set',
  alertsRulesList: 'llm:alerts:rules:list',
  alertsRuleSave: 'llm:alerts:rules:save',
  alertsRuleDelete: 'llm:alerts:rules:delete',
  alertsEventsList: 'llm:alerts:events:list',
  alertsEventsAck: 'llm:alerts:events:ack',
  alertsChannelSet: 'llm:alerts:channel:set',
  alertsChannelTest: 'llm:alerts:channel:test',
  collectStatus: 'llm:collect:status',
  historyExport: 'llm:history:export',
  configExport: 'llm:config:export',
  configImport: 'llm:config:import',
  cacheClear: 'llm:cache:clear',
  testSql: 'llm:test:sql',
  testInject: 'llm:test:inject',
  fpsProbe: 'llm:test:fps-probe',
  browserViewCount: 'llm:test:browserview-count',
} as const;

/** 渲染进程主窗口 push 事件通道（webContents.send） */
export const PUSH_EVENT = 'llm:event';

export type PushPayload =
  | { type: 'refresh-progress'; progress: RefreshProgress }
  | { type: 'refresh-finished'; results: { providerId: string; ok: boolean; reason?: string }[] }
  | { type: 'provider-updated'; providerId: string }
  | { type: 'region-browser-closed'; providerId: string }
  | { type: 'alert-triggered'; event: AlertEvent };

export const TESTIDS = {
  topbarSearch: 'topbar-search',
  topbarSyncAll: 'topbar-sync-all',
  topbarProgress: 'topbar-progress',
  topbarAlerts: 'topbar-alerts',
  bannerOffline: 'banner-offline',
  emptyAddProvider: 'empty-add-provider',
  cardRefresh: (id: string) => `card-refresh-${id}`,
  cardEdit: (id: string) => `card-edit-${id}`,
  cardError: (id: string) => `card-error-msg-${id}`,
  cardManualEntry: (id: string) => `card-manual-entry-${id}`,
  cardCheck: (id: string) => `card-check-${id}`,
  manualMode: 'manual-mode',
  manualAmount: 'manual-amount',
  manualTime: 'manual-time',
  manualSave: 'manual-save',
  captureMode: 'capture-mode',
  credApikey: 'cred-apikey',
  credTest: 'cred-test',
  domUrl: 'dom-url',
  regionOpenBrowser: 'region-open-browser',
  regionSave: 'region-save',
  regionNameInput: 'region-name-input',
  regionHandle: (n: number) => `region-handle-${n}`,
  regionRowActions: (id: string) => `region-row-actions-${id}`,
  overlayCoord: 'overlay-coord',
  overlayCount: 'overlay-count',
  overlayHint: 'overlay-hint',
  providerAdd: 'provider-add',
  alertChannel: (type: string) => `alert-channel-${type}`,
  toastUndo: 'toast-undo',
} as const;
