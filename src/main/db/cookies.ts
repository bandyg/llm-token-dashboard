import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface CookieRow {
  id: number;
  provider_id: string;
  name: string;
  domain: string | null;
  value_encrypted: string;
  updated_at: string;
}

/**
 * cookies 表按 provider_id 隔离；value 经 safeStorage 加密（见 credentials/safe-store）。
 */
export class CookieStore {
  constructor(private db: SqliteDatabase) {}

  replaceForProvider(providerId: string, cookies: { name: string; domain?: string; valueEncrypted: string }[]): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM cookies WHERE provider_id = ?').run(providerId);
      const ins = this.db.prepare(
        'INSERT INTO cookies (provider_id, name, domain, value_encrypted, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const c of cookies) ins.run(providerId, c.name, c.domain ?? null, c.valueEncrypted, now);
    });
    tx();
  }

  listByProvider(providerId: string): CookieRow[] {
    return this.db.prepare('SELECT * FROM cookies WHERE provider_id = ?').all(providerId) as CookieRow[];
  }

  countByProvider(providerId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM cookies WHERE provider_id = ?').get(providerId) as { c: number }).c;
  }
}
