import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { DomSelector, ProviderConfig, ProviderMode, ProviderSubMode, Region } from '../../shared/types';

export interface ProviderRow {
  id: string;
  provider_name: string;
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
  selectors: string;
  region: string | null;
  ocr_threshold: number;
  login_required_selector: string | null;
  quota_total: number | null;
  currency: string;
  alert_threshold: number;
  credential_ref: string | null;
  last_refresh_at: string | null;
  last_error: string | null;
  last_error_type: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToProvider(row: ProviderRow): ProviderConfig {
  return {
    ...row,
    selectors: JSON.parse(row.selectors || '[]') as DomSelector[],
    region: row.region ? (JSON.parse(row.region) as Region) : null,
  };
}

export class ProviderStore {
  constructor(private db: SqliteDatabase) {}

  /** 底层数据库句柄（编排器写 collection_failures 用） */
  get rawDb(): SqliteDatabase {
    return this.db;
  }

  private get stmt() {
    return this.db;
  }

  list(): ProviderConfig[] {
    const rows = this.stmt.prepare('SELECT * FROM providers ORDER BY created_at ASC').all() as ProviderRow[];
    return rows.map(rowToProvider);
  }

  get(id: string): ProviderConfig | null {
    const row = this.stmt.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined;
    return row ? rowToProvider(row) : null;
  }

  create(data: Partial<ProviderConfig> & { provider_name: string }): ProviderConfig {
    const now = new Date().toISOString();
    const id = data.id || genId('prov');
    this.stmt
      .prepare(
        `INSERT INTO providers (
          id, provider_name, alias, template, mode, sub_mode, adapter, enabled, base_url, page_url,
          dom_url, dom_script, selectors, region, ocr_threshold, login_required_selector, quota_total,
          currency, alert_threshold, credential_ref, created_at, updated_at
        ) VALUES (
          @id, @provider_name, @alias, @template, @mode, @sub_mode, @adapter, @enabled, @base_url, @page_url,
          @dom_url, @dom_script, @selectors, @region, @ocr_threshold, @login_required_selector, @quota_total,
          @currency, @alert_threshold, @credential_ref, @created_at, @updated_at
        )`,
      )
      .run({
        id,
        provider_name: data.provider_name,
        alias: data.alias ?? '',
        template: data.template ?? 'custom',
        mode: data.mode ?? 'api',
        sub_mode: data.sub_mode ?? null,
        adapter: data.adapter ?? null,
        enabled: data.enabled ?? 1,
        base_url: data.base_url ?? null,
        page_url: data.page_url ?? null,
        dom_url: data.dom_url ?? null,
        dom_script: data.dom_script ?? null,
        selectors: JSON.stringify(data.selectors ?? []),
        region: data.region ? JSON.stringify(data.region) : null,
        ocr_threshold: data.ocr_threshold ?? 0.8,
        login_required_selector: data.login_required_selector ?? null,
        quota_total: data.quota_total ?? null,
        currency: data.currency ?? 'USD',
        alert_threshold: data.alert_threshold ?? Math.round((data.quota_total ?? 0) * 0.2 * 100) / 100,
        credential_ref: data.credential_ref ?? null,
        created_at: now,
        updated_at: now,
      });
    return this.get(id)!;
  }

  update(id: string, patch: Partial<ProviderConfig>): ProviderConfig | null {
    const existing = this.get(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch, id, updated_at: new Date().toISOString() };
    this.stmt
      .prepare(
        `UPDATE providers SET
          provider_name=@provider_name, alias=@alias, template=@template, mode=@mode, sub_mode=@sub_mode,
          adapter=@adapter, enabled=@enabled, base_url=@base_url, page_url=@page_url, dom_url=@dom_url,
          dom_script=@dom_script, selectors=@selectors, region=@region, ocr_threshold=@ocr_threshold,
          login_required_selector=@login_required_selector, quota_total=@quota_total, currency=@currency,
          alert_threshold=@alert_threshold, credential_ref=@credential_ref, last_refresh_at=@last_refresh_at,
          last_error=@last_error, last_error_type=@last_error_type, updated_at=@updated_at
        WHERE id=@id`,
      )
      .run({
        ...merged,
        selectors: JSON.stringify(merged.selectors ?? []),
        region: merged.region ? JSON.stringify(merged.region) : null,
      });
    return this.get(id);
  }

  delete(id: string): boolean {
    const info = this.stmt.prepare('DELETE FROM providers WHERE id = ?').run(id);
    // 级联清理：选区、告警规则；快照保留（历史趋势完整性）
    this.stmt.prepare('DELETE FROM regions WHERE provider_id = ?').run(id);
    this.stmt.prepare('DELETE FROM cookies WHERE provider_id = ?').run(id);
    this.stmt.prepare('DELETE FROM alert_rules WHERE provider_id = ?').run(id);
    return info.changes > 0;
  }

  setEnabled(id: string, enabled: boolean): ProviderConfig | null {
    return this.update(id, { enabled: enabled ? 1 : 0 });
  }

  countByProviderName(name: string): number {
    return (this.stmt.prepare('SELECT COUNT(*) AS c FROM providers WHERE provider_name = ?').get(name) as { c: number }).c;
  }
}

export function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
