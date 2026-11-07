import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { QuotaWindow, SubscriptionInfo } from '../../shared/types';
import type { QuotaWindowOut, SubscriptionOut } from '../adapters/types';
import { genId } from './providers';

/**
 * 额度窗口与订阅存储。
 * 快照表的 used/remaining 只能表达单一数值，订阅型厂商（智谱 Coding Plan 的
 * 5 小时 / 每周 / 月度 MCP 三个窗口）用这两张表承载，按 snapshot_id 挂载到具体一次采集。
 */
export class QuotaStore {
  constructor(private db: SqliteDatabase) {}

  /** 覆盖式写入：同一 snapshot 的窗口先清后插，保证重复采集不产生重复行 */
  replaceForSnapshot(snapshotId: string, providerId: string, windows: QuotaWindowOut[], collectedAt: string): QuotaWindow[] {
    this.db.prepare('DELETE FROM quota_windows WHERE snapshot_id = ?').run(snapshotId);
    const insert = this.db.prepare(
      `INSERT INTO quota_windows (id, snapshot_id, provider_id, window_key, window_label, percent_used, used, remaining, total, unit, reset_at, collected_at)
       VALUES (@id, @snapshot_id, @provider_id, @window_key, @window_label, @percent_used, @used, @remaining, @total, @unit, @reset_at, @collected_at)`,
    );
    const tx = this.db.transaction(() => {
      for (const w of windows) {
        insert.run({
          id: genId('win'),
          snapshot_id: snapshotId,
          provider_id: providerId,
          window_key: w.window_key,
          window_label: w.window_label,
          percent_used: w.percent_used,
          used: w.used ?? null,
          remaining: w.remaining ?? null,
          total: w.total ?? null,
          unit: w.unit,
          reset_at: w.reset_at ?? null,
          collected_at: collectedAt,
        });
      }
    });
    tx();
    return this.bySnapshot(snapshotId);
  }

  bySnapshot(snapshotId: string): QuotaWindow[] {
    const rows = this.db
      .prepare('SELECT * FROM quota_windows WHERE snapshot_id = ? ORDER BY rowid ASC')
      .all(snapshotId) as QuotaWindow[];
    return rows;
  }

  /** provider 最新一次采集的全部窗口；无窗口数据返回空数组 */
  latestForProvider(providerId: string): QuotaWindow[] {
    const row = this.db
      .prepare(
        `SELECT snapshot_id FROM quota_windows WHERE provider_id = ? ORDER BY collected_at DESC, rowid DESC LIMIT 1`,
      )
      .get(providerId) as { snapshot_id: string } | undefined;
    return row ? this.bySnapshot(row.snapshot_id) : [];
  }

  upsertSubscription(providerId: string, sub: SubscriptionOut): SubscriptionInfo {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO subscriptions (provider_id, product_name, level, status, valid_from, valid_to, next_renew_at, auto_renew, billing_cycle, raw, updated_at)
         VALUES (@provider_id, @product_name, @level, @status, @valid_from, @valid_to, @next_renew_at, @auto_renew, @billing_cycle, @raw, @updated_at)
         ON CONFLICT(provider_id) DO UPDATE SET
           product_name = excluded.product_name, level = excluded.level, status = excluded.status,
           valid_from = excluded.valid_from, valid_to = excluded.valid_to,
           next_renew_at = excluded.next_renew_at, auto_renew = excluded.auto_renew,
           billing_cycle = excluded.billing_cycle, raw = excluded.raw, updated_at = excluded.updated_at`,
      )
      .run({
        provider_id: providerId,
        product_name: sub.product_name,
        level: sub.level,
        status: sub.status,
        valid_from: sub.valid_from,
        valid_to: sub.valid_to,
        next_renew_at: sub.next_renew_at,
        auto_renew: sub.auto_renew,
        billing_cycle: sub.billing_cycle,
        raw: sub.raw ?? null,
        updated_at: now,
      });
    return this.getSubscription(providerId)!;
  }

  getSubscription(providerId: string): SubscriptionInfo | null {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE provider_id = ?').get(providerId) as
      | (SubscriptionInfo & { auto_renew: number })
      | undefined;
    if (!row) return null;
    return { ...row, auto_renew: row.auto_renew === 1 ? 1 : 0 };
  }
}
