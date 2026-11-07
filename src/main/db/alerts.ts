import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { AlertEvent, AlertRule } from '../../shared/types';
import { genId } from './providers';

interface RuleRow {
  id: string;
  provider_id: string | null;
  metric: 'remaining_pct' | 'remaining_abs' | 'daily_used';
  threshold: number;
  enabled: 0 | 1;
  dedupe_minutes: number;
  created_at: string;
}

function rowToRule(r: RuleRow): AlertRule {
  return r as unknown as AlertRule;
}

export class AlertStore {
  constructor(private db: SqliteDatabase) {}

  listRules(): AlertRule[] {
    return (this.db.prepare('SELECT * FROM alert_rules ORDER BY created_at ASC').all() as RuleRow[]).map(rowToRule);
  }

  saveRule(rule: Partial<AlertRule> & { metric: AlertRule['metric']; threshold: number }): AlertRule {
    const id = rule.id || genId('rule');
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO alert_rules (id, provider_id, metric, threshold, enabled, dedupe_minutes, created_at)
         VALUES (@id, @provider_id, @metric, @threshold, @enabled, @dedupe_minutes, @created_at)
         ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, metric=excluded.metric,
           threshold=excluded.threshold, enabled=excluded.enabled, dedupe_minutes=excluded.dedupe_minutes`,
      )
      .run({
        id,
        provider_id: rule.provider_id ?? null,
        metric: rule.metric,
        threshold: rule.threshold,
        enabled: rule.enabled ?? 1,
        dedupe_minutes: rule.dedupe_minutes ?? 30,
        created_at: now,
      });
    return rowToRule(this.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as RuleRow);
  }

  deleteRule(id: string): void {
    this.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  }

  listEvents(limit = 30): AlertEvent[] {
    return this.db
      .prepare('SELECT * FROM alert_events ORDER BY triggered_at DESC LIMIT ?')
      .all(limit) as unknown as AlertEvent[];
  }

  insertEvent(e: Omit<AlertEvent, 'id'>): AlertEvent {
    const id = genId('evt');
    this.db
      .prepare(
        `INSERT INTO alert_events (id, rule_id, provider_id, provider_name, snapshot_id, message, triggered_at, acknowledged)
         VALUES (@id, @rule_id, @provider_id, @provider_name, @snapshot_id, @message, @triggered_at, 0)`,
      )
      .run({
        id,
        rule_id: e.rule_id,
        provider_id: e.provider_id,
        provider_name: e.provider_name,
        snapshot_id: e.snapshot_id ?? null,
        message: e.message,
        triggered_at: e.triggered_at,
      });
    return this.db.prepare('SELECT * FROM alert_events WHERE id = ?').get(id) as unknown as AlertEvent;
  }

  lastEventForRule(ruleId: string): AlertEvent | null {
    const row = this.db
      .prepare('SELECT * FROM alert_events WHERE rule_id = ? ORDER BY triggered_at DESC LIMIT 1')
      .get(ruleId) as AlertEvent | undefined;
    return row ?? null;
  }

  ack(id: string): void {
    this.db.prepare('UPDATE alert_events SET acknowledged = 1 WHERE id = ?').run(id);
  }

  getChannel(type: string): { type: string; enabled: number; config: string } | null {
    return (this.db.prepare('SELECT * FROM alert_channels WHERE type = ?').get(type) as never) ?? null;
  }

  setChannel(type: string, enabled: boolean, config: Record<string, unknown> = {}): void {
    this.db
      .prepare(
        `INSERT INTO alert_channels (type, enabled, config) VALUES (?, ?, ?)
         ON CONFLICT(type) DO UPDATE SET enabled=excluded.enabled, config=excluded.config`,
      )
      .run(type, enabled ? 1 : 0, JSON.stringify(config));
  }

  listChannels(): { type: string; enabled: number; config: string }[] {
    return this.db.prepare('SELECT * FROM alert_channels').all() as never;
  }
}
