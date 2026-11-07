import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { SyncSettings } from '../../shared/types';

export const DEFAULT_SETTINGS: SyncSettings = {
  strategy: 'batch',
  batch_size: 5,
  interval_seconds: 60,
  min_refresh_seconds: 60,
  default_alert_threshold: 20,
  ocr_threshold_default: 0.8,
  theme: 'light',
  sync_all_cooldown_ms: 10_000,
};

export class SettingsStore {
  constructor(private db: SqliteDatabase) {}

  get<T = string>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getSyncSettings(): SyncSettings {
    const stored = this.get<Partial<SyncSettings>>('sync');
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  }

  setSyncSettings(patch: Partial<SyncSettings>): SyncSettings {
    const merged = { ...this.getSyncSettings(), ...patch };
    // 硬约束：并发上限 ≤ 10（batch_size 1~10）
    merged.batch_size = Math.min(10, Math.max(1, Math.round(merged.batch_size)));
    merged.interval_seconds = Math.max(0, Math.round(merged.interval_seconds));
    this.set('sync', merged);
    return merged;
  }
}
