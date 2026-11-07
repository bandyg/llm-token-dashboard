import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/main/db/database';
import { ProviderStore } from '../../src/main/db/providers';
import { SnapshotStore } from '../../src/main/db/snapshots';
import { SettingsStore, DEFAULT_SETTINGS } from '../../src/main/db/settings';
import { RegionStore } from '../../src/main/db/regions';
import { CookieStore } from '../../src/main/db/cookies';
import { AlertStore } from '../../src/main/db/alerts';
import { tmpDbFile } from './setup';

describe('SQLite 数据层（AC：CRUD 后 providers 表行数与字段对应变化）', () => {
  it('迁移创建全部核心表', () => {
    const db = createDatabase(tmpDbFile('migrations'));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['providers', 'llm_usage_snapshots', 'cookies', 'settings', 'regions', 'alert_rules', 'alert_events', 'collection_failures']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('Provider CRUD：INSERT/UPDATE/DELETE 行变化；enabled=false 不渲染但记录保留', () => {
    const db = createDatabase(tmpDbFile('crud'));
    const store = new ProviderStore(db);
    expect(store.list()).toHaveLength(0);
    const p = store.create({ provider_name: 'OpenAI', alias: '主号', mode: 'api', quota_total: 50, alert_threshold: 10 });
    expect(store.list()).toHaveLength(1);
    const u = store.update(p.id, { alias: '主号改名', ocr_threshold: 0.9 });
    expect(u?.alias).toBe('主号改名');
    expect(u?.ocr_threshold).toBe(0.9);
    const d = store.setEnabled(p.id, false);
    expect(d?.enabled).toBe(0);
    // enabled=false 仍保留记录
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].enabled).toBe(0);
    expect(store.delete(p.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    db.close();
  });

  it('唯一索引：同一 provider_name 下 ≥2 条 alias 不同记录；同 alias 冲突被拒', () => {
    const db = createDatabase(tmpDbFile('alias'));
    const store = new ProviderStore(db);
    store.create({ provider_name: 'OpenAI', alias: 'a1' });
    store.create({ provider_name: 'OpenAI', alias: 'a2' });
    expect(store.countByProviderName('OpenAI')).toBe(2);
    expect(() => store.create({ provider_name: 'OpenAI', alias: 'a1' })).toThrow();
    db.close();
  });

  it('mode/sub_mode/region/dom_script 参数落库可查询（AC：web_crawl 参数写入数据库）', () => {
    const db = createDatabase(tmpDbFile('mode'));
    const store = new ProviderStore(db);
    const p = store.create({
      provider_name: '某厂',
      mode: 'web_crawl',
      sub_mode: 'ocr',
      region: { x: 1180, y: 268, w: 264, h: 72 },
      ocr_threshold: 0.8,
    });
    const row = db.prepare('SELECT mode, sub_mode, region, ocr_threshold FROM providers WHERE id = ?').get(p.id) as {
      mode: string;
      sub_mode: string;
      region: string;
      ocr_threshold: number;
    };
    expect(['api', 'web_crawl', 'manual']).toContain(row.mode);
    expect(row.sub_mode).toBe('ocr');
    expect(JSON.parse(row.region)).toEqual({ x: 1180, y: 268, w: 264, h: 72 });
    expect(row.ocr_threshold).toBe(0.8);
    const p2 = store.create({ provider_name: '某厂2', mode: 'web_crawl', sub_mode: 'dom', dom_script: "document.querySelector('.q')?.textContent" });
    const row2 = db.prepare('SELECT dom_script FROM providers WHERE id = ?').get(p2.id) as { dom_script: string };
    expect(row2.dom_script).toContain('querySelector');
    db.close();
  });

  it('快照：插入后 remaining 非空可查；history 仅返回 status=valid（AC：invalid 不上曲线）', () => {
    const db = createDatabase(tmpDbFile('snap'));
    const snaps = new SnapshotStore(db);
    const now = new Date().toISOString();
    const s1 = snaps.insert({ provider_id: 'p1', used: 12.34, remaining: 37.66, total: 50, source: 'api', status: 'valid' });
    expect(s1.remaining).toBe(37.66);
    snaps.insert({ provider_id: 'p1', used: 20, remaining: 30, source: 'dom', status: 'invalid', error: '伪造无效行' });
    const latest = snaps.latest('p1');
    expect(latest?.id).toBe(s1.id);
    const hist = snaps.history('p1', now);
    expect(hist).toHaveLength(1);
    expect(hist[0].status).toBe('valid');
    expect(snaps.count('p1')).toBe(2);
    db.close();
  });

  it('regions 表 upsert/replace（providerId/name/x/y/w/h/mode/lastModified）', () => {
    const db = createDatabase(tmpDbFile('regions'));
    const store = new RegionStore(db);
    const r = store.upsert({ providerId: 'p1', name: '已用', x: 10, y: 20, w: 100, h: 30, mode: 'OCR', lastModified: Date.now() });
    expect(r.id).toBeTruthy();
    store.upsert({ id: r.id, providerId: 'p1', name: '已用改', x: 11, y: 21, w: 101, h: 31, mode: 'OCR', lastModified: Date.now() });
    const list = store.listByProvider('p1');
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('已用改');
    // CHECK 约束：w>0
    expect(() => store.upsert({ providerId: 'p1', name: 'bad', x: 0, y: 0, w: 0, h: 10, mode: 'OCR', lastModified: Date.now() })).toThrow();
    db.close();
  });

  it('cookies 表按 provider_id 隔离（AC）', () => {
    const db = createDatabase(tmpDbFile('cookies'));
    const store = new CookieStore(db);
    store.replaceForProvider('p1', [{ name: 'sid', domain: '.x.com', valueEncrypted: 'enc-1' }]);
    store.replaceForProvider('p2', [{ name: 'sid', domain: '.x.com', valueEncrypted: 'enc-2' }]);
    expect(store.countByProvider('p1')).toBe(1);
    expect(store.listByProvider('p1')[0].value_encrypted).toBe('enc-1');
    expect(store.listByProvider('p2')[0].value_encrypted).toBe('enc-2');
    store.replaceForProvider('p1', []);
    expect(store.countByProvider('p1')).toBe(0);
    db.close();
  });

  it('settings：batch_size 夹紧 [1,10]（AC：可调范围 [1,10]）', () => {
    const db = createDatabase(tmpDbFile('settings'));
    const store = new SettingsStore(db);
    expect(store.getSyncSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.batch_size).toBe(5);
    const s = store.setSyncSettings({ batch_size: 99, interval_seconds: -5 });
    expect(s.batch_size).toBe(10);
    expect(s.interval_seconds).toBe(0);
    expect(store.setSyncSettings({ batch_size: 0 }).batch_size).toBe(1);
    db.close();
  });

  it('告警规则与事件（30 分钟去重由调用方控制，事件持久化可查）', () => {
    const db = createDatabase(tmpDbFile('alerts'));
    const store = new AlertStore(db);
    const rule = store.saveRule({ metric: 'remaining_abs', threshold: 10, provider_id: 'p1' });
    expect(store.listRules()).toHaveLength(1);
    store.insertEvent({ rule_id: rule.id, provider_id: 'p1', provider_name: 'X', snapshot_id: null, message: '剩余不足', triggered_at: new Date().toISOString(), acknowledged: 0 });
    expect(store.listEvents()).toHaveLength(1);
    expect(store.lastEventForRule(rule.id)?.message).toBe('剩余不足');
    store.ack(store.listEvents()[0].id);
    expect(store.listEvents()[0].acknowledged).toBe(1);
    store.setChannel('webhook', true);
    expect(store.getChannel('webhook')?.enabled).toBe(1);
    db.close();
  });
});
