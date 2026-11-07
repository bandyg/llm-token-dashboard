import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchHarness, sqlRows, seedProvider, gotoDashboard, expect, test, invokeIpc, evalService, type TestHarness } from './helpers';
import { NetAudit } from '../../src/main/net-audit';

let h: TestHarness;
/** 静置起点/终点（真实时间戳）：网络抓包测试据此断言静置期零出站 */
let soakStartedAt = 0;
let soakEndedAt = 0;

test.describe.serial('P0-003 端到端主流程', () => {
  test.beforeAll(async () => {
    h = await launchHarness();
  });

  test.afterAll(async () => {
    await h?.close();
  });

  test('完整旅程：空态 → 添加 Provider → 选模板配置 → 保存 → Dashboard 出现卡片（全程无阻断）', async () => {
    const base = `http://127.0.0.1:${h.mock.port}`;
    await gotoDashboard(h.win);
    // 空态主按钮
    await h.win.locator('[data-testid="empty-add-provider"]').click();
    // 模板列表：选 OpenAI
    await h.win.getByText('OpenAI', { exact: true }).first().click();
    // 表单自动填充
    await expect(h.win.locator('#pf-name')).toHaveValue('OpenAI');
    // 凭据
    await h.win.getByRole('tab', { name: '凭据' }).click();
    // OpenAI 模板默认 baseUrl 指向真实官方 API，保存即触发真实抓取——e2e 全程只允许出站到本机 mock
    await h.win.locator('#pf-baseurl').fill(base);
    await h.win.locator('[data-testid="cred-apikey"]').fill('sk-good');
    // 抓取方式保持官方 API
    await h.win.locator('[data-testid="provider-save"]').click();
    // 保存后立即执行一次抓取验证 → Dashboard 出现套餐卡并显示最近采集时间
    await gotoDashboard(h.win);
    await expect(h.win.locator('[data-testid="provider-grid"] .plan-card').first()).toBeVisible({ timeout: 15000 });
    await h.win.waitForTimeout(2500);
    await h.win.reload();
    const flowCard = h.win.locator('.plan-card').first();
    await flowCard.locator('.plan-toggle').click();
    await expect(flowCard).toContainText('最近采集：');
    void base;
  });

  test('API 链路：内置适配器调用 usage endpoint → 快照 remaining 非空；卡片与今日概览同步', async () => {
    const p = await seedProvider(h.win, { provider_name: 'Anthropic', alias: 'API', mode: 'api', adapter: 'anthropic', base_url: `http://127.0.0.1:${h.mock.port}`, quota_total: 100, alert_threshold: 20 });
    await invokeIpc(h.win, 'llm:credentials:set', { providerId: p, apiKey: 'ak-good' });
    const r = await invokeIpc<{ ok: boolean }>(h.win, 'llm:refresh:one', { providerId: p });
    expect(r.ok).toBe(true);
    const snap = await sqlRows(h.app, `SELECT used, remaining, total, source FROM llm_usage_snapshots WHERE provider_id='${p}' ORDER BY rowid DESC LIMIT 1`);
    expect(snap[0].source).toBe('api');
    expect(snap[0].remaining).not.toBeNull();
    expect(Number(snap[0].remaining)).toBeCloseTo(97.5, 1); // total 100 - costUSD 2.5
    await gotoDashboard(h.win);
    await h.win.reload();
    await expect(h.win.locator(`[data-testid="overview-bar-${p}"]`)).toBeVisible();
  });

  test('OCR 低置信注入：confidence 0.5 < threshold 0.8 → 红字「⚠️ 抓取失败」且 COUNT(*) 不增加', async () => {
    const base = `http://127.0.0.1:${h.mock.port}`;
    const p = await seedProvider(h.win, {
      provider_name: '低置信厂商',
      mode: 'web_crawl',
      sub_mode: 'ocr',
      dom_url: `${base}/console?auth=ok`,
      region: { x: 110, y: 150, w: 570, h: 62 },
      ocr_threshold: 0.8,
    });
    const before = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${p}'`))[0].c as number;
    await invokeIpc(h.win, 'llm:test:inject', { kind: 'ocr-confidence', value: 0.5 });
    const r = await invokeIpc<{ ok: boolean; reason?: string; code?: string }>(h.win, 'llm:refresh:one', { providerId: p });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ocr_low_confidence');
    const after = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${p}'`))[0].c as number;
    expect(after).toBe(before);
    await gotoDashboard(h.win);
    await h.win.reload();
    await expect(h.win.locator(`[data-testid="card-error-msg-${p}"]`)).toContainText('⚠️ 抓取失败');
    await expect(h.win.locator(`[data-testid="card-error-msg-${p}"]`)).toContainText('置信度');
    await invokeIpc(h.win, 'llm:test:inject', { kind: 'clear' });
  });

  test('网络异常注入：红字「⚠️ 抓取失败」且该 provider 最新快照时间戳不变', async () => {
    const base = `http://127.0.0.1:${h.mock.port}`;
    const p = await seedProvider(h.win, { provider_name: '断网厂商', mode: 'web_crawl', sub_mode: 'dom', dom_url: `${base}/console?auth=ok` });
    await invokeIpc(h.win, 'llm:refresh:one', { providerId: p });
    const good = await sqlRows(h.app, `SELECT created_at FROM llm_usage_snapshots WHERE provider_id='${p}' ORDER BY rowid DESC LIMIT 1`);
    await invokeIpc(h.win, 'llm:test:inject', { kind: 'network-fail', value: true });
    const r = await invokeIpc<{ ok: boolean; code?: string }>(h.win, 'llm:refresh:one', { providerId: p, force: true });
    expect(r.ok).toBe(false);
    const still = await sqlRows(h.app, `SELECT created_at FROM llm_usage_snapshots WHERE provider_id='${p}' ORDER BY rowid DESC LIMIT 1`);
    expect(still[0].created_at).toBe(good[0].created_at);
    const invalidRows = await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${p}' AND (status='invalid' OR remaining IS NULL)`);
    expect(Number(invalidRows[0].c)).toBe(0);
    // 卡片错误态：红字「⚠️ 抓取失败」+ 具体网络原因 + 手动录入按钮可见（展开卡片，按钮在底部操作区）
    await gotoDashboard(h.win);
    await h.win.reload();
    const failCard = h.win.locator(`[data-testid="provider-card-${p}"]`);
    await failCard.locator('.plan-toggle').click();
    await expect(h.win.locator(`[data-testid="card-error-msg-${p}"]`)).toContainText('⚠️ 抓取失败');
    await expect(h.win.locator(`[data-testid="card-manual-entry-${p}"]`)).toBeVisible();
    await invokeIpc(h.win, 'llm:test:inject', { kind: 'clear' });
  });

  test('未登录：.auth-required +「🔐 请手动登录」→ 弹窗登录（真实 Cookie）→ 重启免登录', async () => {
    const base = `http://127.0.0.1:${h.mock.port}`;
    const p = await seedProvider(h.win, { provider_name: '登录厂商', mode: 'web_crawl', sub_mode: 'dom', dom_url: `${base}/console` });
    // 首次刷新：/console 无 cookie → 登录墙 → loginRequired
    const r = await invokeIpc<{ ok: boolean; code?: string }>(h.win, 'llm:refresh:one', { providerId: p });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('login_expired');
    await gotoDashboard(h.win);
    await h.win.reload();
    // 登录墙命中后 auth_required=true；卡片同时呈现失败原因，card-auth 提示仅在非失败态渲染，
    // 「🔐 登录」按钮固定在标题行可见（点它进入弹窗登录流程）
    const loginCard = h.win.locator(`[data-testid="provider-card-${p}"]`);
    await expect(loginCard).toContainText('抓取失败');
    await expect(h.win.locator(`[data-testid="card-login-${p}"]`)).toBeVisible();
    // 点击「🔐 登录」→ 登录弹窗 BrowserWindow（独立会话）；按「新增页面」差集定位（池内 BrowserView 同 URL 不可混淆）
    await h.win.locator(`[data-testid="card-login-${p}"]`).click();
    await h.win.locator('[data-testid="login-open"]').click();
    const known = new Set(h.app.windows());
    let loginWin: import('playwright').Page | undefined;
    for (let i = 0; i < 40 && !loginWin; i++) {
      loginWin = h.app.windows().find((w) => !known.has(w) && /127\.0\.0\.1/.test(w.url()));
      if (!loginWin) await h.win.waitForTimeout(300);
    }
    expect(loginWin).toBeTruthy();
    await loginWin!.waitForSelector('form[action="/login"] input[type="password"]', { timeout: 10000 });
    await loginWin!.fill('input[type="password"]', 'secret');
    await Promise.all([
      loginWin!.waitForURL(/console/, { timeout: 8000 }).catch(() => undefined),
      loginWin!.click('button[type="submit"]'),
    ]);
    // 关闭登录窗口 → onLoginWindowClosed → Cookie 导出 + 复查
    await loginWin!.close();
    await h.win.waitForTimeout(1200);
    const cookies = await sqlRows(h.app, `SELECT provider_id, name FROM cookies WHERE provider_id='${p}'`);
    expect(cookies.length).toBeGreaterThanOrEqual(1);
    expect(cookies.every((c) => c.provider_id === p)).toBe(true);
    // 登录后刷新成功
    const r2 = await invokeIpc<{ ok: boolean; code?: string }>(h.win, 'llm:refresh:one', { providerId: p, force: true });
    expect(r2.ok).toBe(true);
    // 重启前必须关闭旧实例（同 userData 下分区库被锁会丢 Cookie 命中）
    const dataDir = h.dataDir;
    await h.close();
    const relaunched = await launchHarness({ dataDir });
    h = relaunched;
    try {
      const base2 = `http://127.0.0.1:${relaunched.mock.port}`;
      await invokeIpc(relaunched.win, 'llm:providers:update', { id: p, dom_url: `${base2}/console` });
      const r3 = await invokeIpc<{ ok: boolean; code?: string; reason?: string }>(relaunched.win, 'llm:refresh:one', { providerId: p, force: true });
      expect(r3.ok).toBe(true);
      expect(r3.code).not.toBe('login_expired');
    } finally {
      // h 已指向 relaunched，由 afterAll 统一关闭
    }
  });

  test('未登录改走手动录入：status=valid 快照参与告警与趋势，3 次点击内完成', async () => {
    const base = `http://127.0.0.1:${h.mock.port}`;
    const p = await seedProvider(h.win, { provider_name: '登录兜底厂商', mode: 'web_crawl', sub_mode: 'dom', dom_url: `${base}/console?auth=required`, quota_total: 80, alert_threshold: 30 });
    await invokeIpc(h.win, 'llm:refresh:one', { providerId: p });
    await gotoDashboard(h.win);
    await h.win.reload();
    await invokeIpc(h.win, 'llm:test:inject', { kind: 'clear' });
    // 3 击：点击行（失败→手动录入弹窗）→ 提交
    await h.win.locator(`[data-testid="provider-card-${p}"]`).click({ position: { x: 40, y: 20 } });
    await h.win.locator('[data-testid="manual-amount"]').fill('60');
    await h.win.locator('[data-testid="manual-save"]').click();
    const snap = await sqlRows(h.app, `SELECT status, source, used, remaining FROM llm_usage_snapshots WHERE provider_id='${p}' ORDER BY rowid DESC LIMIT 1`);
    expect(snap[0].status).toBe('valid');
    expect(Number(snap[0].used)).toBe(60);
    expect(Number(snap[0].remaining)).toBe(20); // 80-60 ≤ 30 → 触发告警
    const events = await sqlRows(h.app, `SELECT COUNT(*) AS c FROM alert_events WHERE provider_id='${p}'`);
    expect(Number(events[0].c)).toBeGreaterThanOrEqual(1);
    await h.win.reload();
    await expect(h.win.locator(`[data-testid="provider-card-${p}"]`)).toHaveClass(/alert-bg/);
  });

  test('安全边界：渲染层 bundle 无 sqlite3/BrowserView/paddleocr 痕迹；DOM 提取仅返回文本', async () => {
    const assetsDir = path.join(__dirname, '..', '..', 'dist', 'renderer', 'assets');
    const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = fs.readFileSync(path.join(assetsDir, f), 'utf8');
      expect(content).not.toMatch(/better_sqlite3|new Database\(|paddleocr|executeJavaScript|webContents\.|BrowserView\(/);
      expect(content).not.toMatch(/\beval\s*\(/);
    }
    // 渲染层只有经 preload 暴露的 window.llm 桥（不出现任何 llm.invoke 之外的直连）
    const mainEntry = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'renderer', 'assets', files[0]), 'utf8');
    expect(mainEntry).toMatch(/window\.llm/);
    // DOM 提取仅文本：runDomScript 返回 JSON { text }，无脚本注入面（unit 已证）；此处证 IPC 白名单拒绝越权
    const nope = await h.win.evaluate(() =>
      (window as unknown as { llm: { invoke(c: string): Promise<{ code: number | string }> } }).llm.invoke('llm:evil:channel'),
    );
    expect(nope.code).not.toBe(0);
  });

  test('性能边界：20 个 BrowserView 帧率 ≥30fps；第 31 个被「已达硬上限 30」阻止', async () => {
    // 帧率采样两次取最大（避免合成器调度抖动导致的偶发低值）
    const r1 = await invokeIpc<{ fps: number; views: number }>(h.win, 'llm:test:fps-probe', { count: 20, sampleMs: 2000 });
    const r2 = r1.fps >= 30 ? r1 : await invokeIpc<{ fps: number; views: number }>(h.win, 'llm:test:fps-probe', { count: 20, sampleMs: 2000 });
    const fps = Math.max(r1.fps, r2.fps);
    expect(r1.views).toBe(20);
    expect(fps).toBeGreaterThanOrEqual(30);
    // 硬上限：直接在主进程池上创建到 30，第 31 个必须抛「已达硬上限 30」
    const r = await evalService<{ created: number; errorOn31: string | null; count: number }>(
      h.app,
      `(async (s) => {
        for (const e of s.pool.list()) s.pool.destroy(e.providerId);
        const ids = [];
        for (let i = 0; i < 31; i++) ids.push('probe30_' + i + '_' + Date.now());
        let created = 0;
        let errorOn31 = null;
        for (let i = 0; i < ids.length; i++) {
          try { await s.pool.ensureForProvider(ids[i]); created++; }
          catch (e) { errorOn31 = e.message; break; }
        }
        const count = s.pool.count;
        for (const id of ids) s.pool.destroy(id);
        return { created, errorOn31, count };
      })`,
    );
    expect(r.created).toBe(30);
    expect(r.errorOn31).toBe('已达硬上限 30');
    const cnt = await invokeIpc<{ pool: number; max: number }>(h.win, 'llm:test:browserview-count');
    expect(cnt.max).toBe(30);
  });

  test('采集仅手动触发：源码审计无调度器；虚拟时钟快进 1 小时快照无新增；真实静置 60s 快照无新增', async () => {
    // 1) 源码审计（与 npm run audit:no-scheduler 同一脚本，退出码非 0 即失败）：
    //    node-cron/BullMQ/非白名单 setInterval/setTimeout 采集语义全部禁止
    const auditOut = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'audit-no-scheduler.mjs')], { encoding: 'utf8' });
    expect(auditOut).toContain('PASS');
    // 2) 先产生基线快照（用户主动刷新 1 次）
    const p = await seedProvider(h.win, { provider_name: '静置厂商', mode: 'web_crawl', sub_mode: 'dom', dom_url: `http://127.0.0.1:${h.mock.port}/console?auth=ok` });
    await invokeIpc(h.win, 'llm:refresh:one', { providerId: p, force: true });
    const baseline = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${p}'`))[0].c as number;
    expect(baseline).toBe(1);
    // 3) 虚拟时钟快进 1 小时：渲染层所有新调度的定时器被真实触发一遍——
    //    若存在「定时采集」，这里会写出新快照；随后主进程 SQLite 对账必须零新增
    await h.win.clock.install();
    await h.win.clock.fastForward('01:00:00');
    await h.win.waitForTimeout(500);
    const afterVirtual1h = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${p}'`))[0].c as number;
    expect(afterVirtual1h).toBe(baseline);
    // （clock 保持安装：本文件后续仅剩网络审计测试，不依赖渲染层墙钟）
    // 4) 真实静置 60s（真实墙钟，主进程无任何定时器可被唤醒；审计脚本已证无调度器）
    // 先关掉「窗口呼出采集」（产品特性，index.ts refreshAllOnShow）：测试桌面上的杂散
    // show/focus 事件（如登录用例 relaunch 的余波）会在静置窗内触发合法全量采集，
    // 污染「零出站」取证。置位后静置窗内任何出站只能是调度器/定时器 = 真违规。
    await evalService(h.app, `(s) => { process.env.LLMDASH_DISABLE_AUTO_REFRESH = '1'; return true; }`);
    soakStartedAt = Date.now();
    await h.win.waitForTimeout(60_000);
    soakEndedAt = Date.now();
    const afterRealSoak = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${p}'`))[0].c as number;
    expect(afterRealSoak).toBe(baseline);
    // 对照组：手动刷新仍正常写快照（证明静置零新增不是采集链路失效）
    const r = await invokeIpc<{ ok: boolean }>(h.win, 'llm:refresh:one', { providerId: p, force: true });
    expect(r.ok).toBe(true);
    expect((await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${p}'`))[0].c).toBe(baseline + 1);
  });

  test('安全抓包（全程审计）：仅本机/provider 官方域名；上传请求仅本机 mock；静置期零出站', async () => {
    // netAudit 于应用启动即挂双面钩子（Chromium webRequest + 主进程 fetch）。
    // 抓包权威面 = dataDir/logs/net-audit.jsonl：跨实例（登录用例中途重启过 app）逐行累计，
    // 覆盖本轮 e2e 全部真实流量与静置期；内存快照用于交叉核对当前实例在案。
    const file = path.join(h.dataDir, 'logs', 'net-audit.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const fileEntries = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { at: string; face: string; method: string; url: string; host: string; isUpload: boolean });
    expect(fileEntries.length).toBeGreaterThan(0);
    const snapshot = await evalService<{ at: string; host: string; isUpload: boolean }[]>(h.app, `(s => s.netAudit.snapshot())`);
    expect(snapshot.length).toBeGreaterThan(0);

    // 1) 全程（文件累计）无任何指向非 provider 官方域名的请求——含上传
    const offenders = fileEntries.filter((e) => !NetAudit.isAllowedHost(e.host));
    expect(offenders).toEqual([]);
    // 2) 上传（POST/PUT/PATCH）请求存在（登录 POST /login），且全部只指向本机 mock
    const uploads = fileEntries.filter((e) => e.isUpload);
    expect(uploads.length).toBeGreaterThanOrEqual(1);
    expect(uploads.every((e) => e.host === '127.0.0.1')).toBe(true);
    // 3) 静置期（60s 真实墙钟窗口内）零出站请求
    const duringSoak = fileEntries.filter((e) => {
      const t = new Date(e.at).getTime();
      return t >= soakStartedAt && t < soakEndedAt;
    });
    expect(duringSoak).toEqual([]);
  });
});
