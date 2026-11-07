import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { SnapshotSource, UsageSnapshot } from '../../shared/types';
import { genId } from './providers';

export interface SnapshotRow {
  id: string;
  provider_id: string;
  used: number | null;
  remaining: number | null;
  total: number | null;
  used_input: number | null;
  used_output: number | null;
  quota_type: string;
  currency: string;
  source: string;
  status: string;
  error: string | null;
  reset_at: string | null;
  collected_at: string;
  created_at: string;
}

export interface NewSnapshot {
  provider_id: string;
  used?: number | null;
  remaining?: number | null;
  total?: number | null;
  used_input?: number | null;
  used_output?: number | null;
  quota_type?: 'usd' | 'token' | 'credit' | 'message';
  currency?: string;
  source: SnapshotSource;
  status?: 'valid' | 'invalid';
  error?: string | null;
  reset_at?: string | null;
  collected_at?: string;
}

function rowToSnapshot(r: SnapshotRow): UsageSnapshot {
  return r as unknown as UsageSnapshot;
}

export class SnapshotStore {
  constructor(private db: SqliteDatabase) {}

  insert(data: NewSnapshot): UsageSnapshot {
    const now = new Date().toISOString();
    const id = genId('snap');
    this.db
      .prepare(
        `INSERT INTO llm_usage_snapshots (
          id, provider_id, used, remaining, total, used_input, used_output, quota_type, currency,
          source, status, error, reset_at, collected_at, created_at
        ) VALUES (@id, @provider_id, @used, @remaining, @total, @used_input, @used_output, @quota_type, @currency,
          @source, @status, @error, @reset_at, @collected_at, @created_at)`,
      )
      .run({
        id,
        provider_id: data.provider_id,
        used: data.used ?? null,
        remaining: data.remaining ?? null,
        total: data.total ?? null,
        used_input: data.used_input ?? null,
        used_output: data.used_output ?? null,
        quota_type: data.quota_type ?? 'usd',
        currency: data.currency ?? 'USD',
        source: data.source,
        status: data.status ?? 'valid',
        error: data.error ?? null,
        reset_at: data.reset_at ?? null,
        collected_at: data.collected_at ?? now,
        created_at: now,
      });
    return this.get(id)!;
  }

  get(id: string): UsageSnapshot | null {
    const row = this.db.prepare('SELECT * FROM llm_usage_snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  latest(providerId: string): UsageSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT * FROM llm_usage_snapshots WHERE provider_id = ? AND status = 'valid' ORDER BY collected_at DESC, created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(providerId) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
}

  history(providerId: string, sinceIso: string): UsageSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM llm_usage_snapshots
         WHERE provider_id = ? AND status = 'valid' AND collected_at >= ?
         ORDER BY collected_at ASC`,
      )
      .all(providerId, sinceIso) as SnapshotRow[];
    return rows.map(rowToSnapshot);
  }

  listFiltered(opts: { providerIds?: string[]; since?: string; until?: string; limit?: number }): UsageSnapshot[] {
    const where: string[] = ["status = 'valid'"];
    const params: Record<string, unknown> = {};
    if (opts.providerIds && opts.providerIds.length) {
      where.push(
        `provider_id IN (${opts.providerIds.map((_, i) => `@pid${i}`).join(',')})`,
      );
      opts.providerIds.forEach((p, i) => (params[`pid${i}`] = p));
    }
    if (opts.since) {
      where.push('collected_at >= @since');
      params.since = opts.since;
    }
    if (opts.until) {
      where.push('collected_at <= @until');
      params.until = opts.until;
    }
    const sql = `SELECT * FROM llm_usage_snapshots WHERE ${where.join(' AND ')} ORDER BY collected_at DESC LIMIT @limit`;
    params.limit = opts.limit ?? 10000;
    return (this.db.prepare(sql).all(params) as SnapshotRow[]).map(rowToSnapshot);
  }

  count(providerId?: string): number {
    if (providerId) {
      return (this.db.prepare('SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id = ?').get(providerId) as { c: number }).c;
    }
    return (this.db.prepare('SELECT COUNT(*) AS c FROM llm_usage_snapshots').get() as { c: number }).c;
  }
}
