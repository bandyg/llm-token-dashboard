import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { Database as SqliteDatabase } from 'better-sqlite3';

// better-sqlite3 的动态加载：Electron 运行时用 vendor 内 electron-ABI 二进制，
// Node（vitest）运行时用 node_modules 内 node-ABI 二进制，二者并存。
type BetterSqlite3Constructor = new (
  filename: string,
  options?: { nativeBinding?: string },
) => SqliteDatabase;

let Ctor: BetterSqlite3Constructor | null = null;

function loadSqlite(): BetterSqlite3Constructor {
  if (Ctor) return Ctor;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('better-sqlite3');
  Ctor = (mod.default ?? mod) as BetterSqlite3Constructor;
  return Ctor;
}

function electronNativeBinding(): string | undefined {
  if (!process.versions.electron) return undefined;
  const file = `better_sqlite3-electron-v130-${process.platform}-${process.arch}.node`;
  // 开发态：app.getAppPath() = 项目根 vendor/；打包态：extraResources 落在 process.resourcesPath/vendor/
  const candidates = [
    path.join(app.getAppPath(), 'vendor', file),
    path.join(process.resourcesPath, 'vendor', file),
  ];
  for (const full of candidates) {
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

export const MIGRATIONS: string[] = [
  // v1: 核心表
  `
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    provider_name TEXT NOT NULL,
    alias TEXT NOT NULL DEFAULT '',
    template TEXT NOT NULL DEFAULT 'custom',
    mode TEXT NOT NULL DEFAULT 'api' CHECK (mode IN ('api','web_crawl','manual')),
    sub_mode TEXT CHECK (sub_mode IN ('dom','ocr')),
    adapter TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
    base_url TEXT,
    page_url TEXT,
    dom_url TEXT,
    dom_script TEXT,
    selectors TEXT NOT NULL DEFAULT '[]',
    region TEXT,
    ocr_threshold REAL NOT NULL DEFAULT 0.8,
    login_required_selector TEXT,
    quota_total REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    alert_threshold REAL NOT NULL DEFAULT 0,
    credential_ref TEXT,
    last_refresh_at TEXT,
    last_error TEXT,
    last_error_type TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_providers_name_alias ON providers(provider_name, alias);

  CREATE TABLE IF NOT EXISTS llm_usage_snapshots (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    used REAL,
    remaining REAL,
    total REAL,
    used_input REAL,
    used_output REAL,
    quota_type TEXT NOT NULL DEFAULT 'usd' CHECK (quota_type IN ('usd','token','credit','message')),
    currency TEXT NOT NULL DEFAULT 'USD',
    source TEXT NOT NULL CHECK (source IN ('api','dom','ocr','manual')),
    status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid')),
    error TEXT,
    reset_at TEXT,
    collected_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_provider_time ON llm_usage_snapshots(provider_id, collected_at DESC);
  CREATE INDEX IF NOT EXISTS idx_snapshots_source ON llm_usage_snapshots(source);

  CREATE TABLE IF NOT EXISTS cookies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    name TEXT NOT NULL,
    domain TEXT,
    value_encrypted TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cookies_provider ON cookies(provider_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS regions (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    name TEXT NOT NULL,
    x INTEGER NOT NULL CHECK (x >= 0),
    y INTEGER NOT NULL CHECK (y >= 0),
    w INTEGER NOT NULL CHECK (w > 0),
    h INTEGER NOT NULL CHECK (h > 0),
    mode TEXT NOT NULL DEFAULT 'OCR' CHECK (mode IN ('DOM','OCR')),
    selector TEXT,
    last_modified TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_regions_provider ON regions(provider_id);

  CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    provider_id TEXT,
    metric TEXT NOT NULL CHECK (metric IN ('remaining_pct','remaining_abs','daily_used')),
    threshold REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    dedupe_minutes INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS alert_events (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    snapshot_id TEXT,
    message TEXT NOT NULL,
    triggered_at TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_alert_events_time ON alert_events(triggered_at DESC);

  CREATE TABLE IF NOT EXISTS collection_failures (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    error_type TEXT NOT NULL CHECK (error_type IN ('login_expired','selector_missing','ocr_low_confidence','network','parse_error','adapter_upstream_error','browserview_unavailable','unknown')),
    message TEXT,
    consecutive_count INTEGER NOT NULL DEFAULT 1,
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_failures_provider ON collection_failures(provider_id, occurred_at DESC);

  CREATE TABLE IF NOT EXISTS alert_channels (
    type TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}'
  );
  INSERT OR IGNORE INTO alert_channels (type, enabled) VALUES ('system', 1), ('webhook', 0), ('email', 0);
  `,
  // v2: 订阅型厂商（智谱 GLM Coding Plan 等）的多额度窗口
  // 单一快照只能表达一个 used/remaining，无法表达「5 小时 / 每周 / 月度 MCP」三窗口，故独立成表按 snapshot 挂载。
  `
  CREATE TABLE IF NOT EXISTS quota_windows (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    window_key TEXT NOT NULL,
    window_label TEXT NOT NULL,
    percent_used REAL,
    used REAL,
    remaining REAL,
    total REAL,
    unit TEXT NOT NULL DEFAULT '%',
    reset_at TEXT,
    collected_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_windows_snapshot ON quota_windows(snapshot_id);
  CREATE INDEX IF NOT EXISTS idx_windows_provider ON quota_windows(provider_id, collected_at DESC);

  CREATE TABLE IF NOT EXISTS subscriptions (
    provider_id TEXT PRIMARY KEY,
    product_name TEXT,
    level TEXT,
    status TEXT,
    valid_from TEXT,
    valid_to TEXT,
    next_renew_at TEXT,
    auto_renew INTEGER NOT NULL DEFAULT 0,
    billing_cycle TEXT,
    raw TEXT,
    updated_at TEXT NOT NULL
  );
  `,
];

export function createDatabase(dbPath: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const Ctor2 = loadSqlite();
  const db = new Ctor2(dbPath, { nativeBinding: electronNativeBinding() });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    });
    tx();
  });
  return db;
}
