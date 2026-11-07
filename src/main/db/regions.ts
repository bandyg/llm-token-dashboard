import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { RegionRecord } from '../../shared/types';
import { genId } from './providers';

export interface RegionRow {
  id: string;
  provider_id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mode: 'DOM' | 'OCR';
  selector: string | null;
  last_modified: string;
}

export function rowToRegion(r: RegionRow): RegionRecord {
  return {
    id: r.id,
    providerId: r.provider_id,
    name: r.name,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    mode: r.mode,
    selector: r.selector ?? undefined,
    lastModified: new Date(r.last_modified).getTime(),
  };
}

export class RegionStore {
  constructor(private db: SqliteDatabase) {}

  listByProvider(providerId: string): RegionRecord[] {
    return (this.db.prepare('SELECT * FROM regions WHERE provider_id = ? ORDER BY last_modified ASC').all(providerId) as RegionRow[]).map(
      rowToRegion,
    );
  }

  upsert(rec: Omit<RegionRecord, 'id'> & { id?: string }): RegionRecord {
    const id = rec.id || genId('rgn');
    const lastModified = new Date(rec.lastModified || Date.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO regions (id, provider_id, name, x, y, w, h, mode, selector, last_modified)
         VALUES (@id, @providerId, @name, @x, @y, @w, @h, @mode, @selector, @last_modified)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h,
           mode=excluded.mode, selector=excluded.selector, last_modified=excluded.last_modified`,
      )
      .run({
        id,
        providerId: rec.providerId,
        name: rec.name,
        x: Math.round(rec.x),
        y: Math.round(rec.y),
        w: Math.round(rec.w),
        h: Math.round(rec.h),
        mode: rec.mode,
        selector: rec.selector ?? null,
        last_modified: lastModified,
      });
    return rowToRegion(this.db.prepare('SELECT * FROM regions WHERE id = ?').get(id) as RegionRow);
  }

  replaceForProvider(providerId: string, records: (Omit<RegionRecord, 'id' | 'providerId'> & { id?: string })[]): RegionRecord[] {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM regions WHERE provider_id = ?').run(providerId);
      return records.map((r) => this.upsert({ ...r, providerId }));
    });
    return tx();
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM regions WHERE id = ?').run(id);
  }
}
