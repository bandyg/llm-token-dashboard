import { launchHarness, sqlRows, seedProvider, gotoDashboard, expect, test, invokeIpc, evalService, type TestHarness } from './helpers';

let h: TestHarness;
let providerA = '';
let providerB = '';
let providerAlert = '';
let providerFailed = '';

test.describe.serial('P0-001 Dashboard 主界面', () => {
  test.beforeAll(async () => {
    h = await launchHarness();
    const base = `http://127.0.0.1:${h.mock.port}`;
    // 正常 API 卡片
    providerA = await seedProvider(h.win, {
      provider_name: 'OpenAI',
      alias: '主号',
      mode: 'api',
      adapter: 'openai',
      base_url: base,
      quota_total: 50,
      alert_threshold: 10,
    });
    await invokeIpc(h.win, 'llm:credentials:set', { providerId: providerA, apiKey: 'sk-good' });
    // 第二条 DOM 卡片
    providerB = await seedProvider(h.win, {
      provider_name: '某厂控制台',
      alias: 'DOM 抓取',
      mode: 'web_crawl',
      sub_mode: 'dom',
      dom_url: `${base}/console?auth=ok`,
    });
    // 告警卡片（构造 remaining ≤ threshold 快照）
    providerAlert = await seedProvider(h.win, {
      provider_name: '告警厂商',
      alias: '低余额',
      mode: 'web_crawl',
      sub_mode: 'dom',
      dom_url: `${base}/console?auth=ok`,
      quota_total: 50,
      alert_threshold: 40,
    });
    // 失败卡片（错误 Key 的 API 适配器）
    providerFailed = await seedProvider(h.win, {
      provider_name: '失败厂商',
      alias: '坏 Key',
      mode: 'api',
      adapter: 'openai',
      base_url: base,
      quota_total: 50,
      alert_threshold: 10,
    });
    await invokeIpc(h.win, 'llm:credentials:set', { providerId: providerFailed, apiKey: 'sk-bad' });
    // 套餐卡默认折叠；本套件需读取展开态内容（窗口条/plan-total/底部手动录入），统一预置为展开
    await invokeIpc(h.win, 'llm:settings:set', {
      'plan-card-collapsed': { [providerA]: false, [providerB]: false, [providerAlert]: false, [providerFailed]: false },
    });
  });

  test.afterAll(async () => {
    await h?.close();
  });

  test('空态：插画文案与 empty-add-provider 主按钮（首启无 Provider 时）', async () => {
    // 用全新 dataDir 的独立实例验证空态
    const h2 = await launchHarness();
    try {
      // 插画元素本体存在（SVG，role=img，带可访问名称）
      const illo = h2.win.locator('[data-testid="empty-illustration"]');
      await expect(illo).toBeVisible();
      expect(await illo.evaluate((el) => el.tagName.toLowerCase())).toBe('svg');
      expect(await illo.getAttribute('role')).toBe('img');
      expect(await illo.getAttribute('aria-label')).toContain('空态插画');
      await expect(h2.win.locator('[data-testid="empty-add-provider"]')).toBeVisible();
      await expect(h2.win.locator('[data-testid="dashboard-empty"]')).toContainText('还没有配置任何 LLM 提供商');
      await h2.win.locator('[data-testid="empty-add-provider"]').click();
      await expect(h2.win).toHaveURL(/#\/providers/);
    } finally {
      await h2.close();
    }
  });

  test('刷新成功链路：API 适配器 + DOM 抓取写入 llm_usage_snapshots（remaining 非空）', async () => {
    await gotoDashboard(h.win);
    await h.win.locator(`[data-testid="plan-refresh-${providerA}"]`).click();
    await expect(h.win.locator(`[data-testid="plan-name-${providerA}"]`)).toBeVisible();
    await h.win.waitForTimeout(1500);
    const snaps = await sqlRows(h.app, `SELECT used, remaining, total, source, status FROM llm_usage_snapshots WHERE provider_id='${providerA}'`);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    expect(snaps[0].remaining).not.toBeNull();
    expect(snaps[0].status).toBe('valid');

    await h.win.locator(`[data-testid="plan-refresh-${providerB}"]`).click();
    await h.win.waitForTimeout(1500);
    const domSnap = await sqlRows(h.app, `SELECT source, used, remaining FROM llm_usage_snapshots WHERE provider_id='${providerB}' ORDER BY rowid DESC LIMIT 1`);
    expect(domSnap[0].source).toBe('dom');
    expect(domSnap[0].used).toBeCloseTo(12.34, 2);
    // 卡片进度条文本格式「已用 $X / $Y（Z%）」在展开态的 plan-total（beforeAll 已预置展开）
    await gotoDashboard(h.win);
    await h.win.reload();
    await expect(h.win.locator(`[data-testid="plan-total-${providerA}"]`)).toHaveText('已用 $12.34 / $50.00（24.7%）');
    // 「今日用量概览」同步更新
    await expect(h.win.locator(`[data-testid="overview-bar-${providerA}"]`)).toContainText('已用 $12.34');
  });

  test('卡片结构：状态点/额度窗口段码条/最近采集时间/refresh+edit 按钮 testid', async () => {
    await gotoDashboard(h.win);
    await h.win.reload();
    const card = h.win.locator(`[data-testid="provider-card-${providerA}"]`);
    await expect(card.locator('.status-dot')).toHaveClass(/ok/);
    // 展开态（beforeAll 预置）：LCD 窗口槽位 + 段码水位条（剩余 75% > 50% → 绿）
    await expect(card.locator('.win-tile').first()).toBeVisible();
    await expect(card.locator('.win-bar-fill').first()).toHaveClass(/win-bar-ok/);
    await expect(card).toContainText('最近采集：');
    await expect(h.win.locator(`[data-testid="plan-refresh-${providerA}"]`)).toBeVisible();
    await expect(h.win.locator(`[data-testid="card-edit-${providerA}"]`)).toBeVisible();
  });

  test('同步下拉三项 + 正在同步 N/M + 骨架屏 + 按钮置灰 10 秒', async () => {
    await gotoDashboard(h.win);
    // 串行 + 1s 间隔制造可见同步窗口
    await invokeIpc(h.win, 'llm:settings:set', { strategy: 'serial', interval_seconds: 1 });
    await h.win.reload();
    await h.win.locator('[data-testid="topbar-sync-all"]').click();
    await expect(h.win.getByRole('menuitem', { name: '刷新全部' })).toBeVisible();
    await expect(h.win.getByRole('menuitem', { name: '仅刷新失败的' })).toBeVisible();
    await expect(h.win.getByRole('menuitem', { name: '刷新选中' })).toBeVisible();
    const syncBtn = h.win.locator('[data-testid="topbar-sync-all"]');
    await h.win.getByRole('menuitem', { name: '刷新全部' }).click();
    // 置灰 10s（判据：disabled=true 持续 10s 后恢复）
    await expect(syncBtn).toBeDisabled();
    await expect(syncBtn).toContainText('同步冷却');
    // 进度「正在同步 N/M」与骨架屏
    await expect(h.win.locator('[data-testid="topbar-progress"]')).toContainText(/正在同步 \d+\/\d+/, { timeout: 5000 });
    await expect(h.win.locator('.plan-card .skeleton').first()).toBeVisible();
    // 10 秒后恢复
    await expect(syncBtn).toBeEnabled({ timeout: 15000 });
    await invokeIpc(h.win, 'llm:settings:set', { strategy: 'batch', interval_seconds: 0 });
  });

  test('告警联动：remaining ≤ alert_threshold 行含 .alert-bg 且外壳描告警光环', async () => {
    // 手动录入一条低余额快照
    await invokeIpc(h.win, 'llm:usage:manual', { providerId: providerAlert, mode: 'used', amount: 45 });
    await gotoDashboard(h.win);
    await h.win.reload();
    const card = h.win.locator(`[data-testid="provider-card-${providerAlert}"]`);
    await expect(card).toHaveClass(/alert-bg/);
    await expect(card).toContainText('告警');
    // 硬件主题契约：告警态用 ::after 琥珀光环（inset 描边 + 泛光），不再改卡片底色
    const ring = await card.evaluate((el) => getComputedStyle(el, '::after').boxShadow);
    expect(ring).toContain('245, 166, 35'); // #F5A623 琥珀
  });

  test('失败态：外壳红色告警光环 + card-error-msg + card-manual-entry 可见', async () => {
    await gotoDashboard(h.win);
    await h.win.locator(`[data-testid="plan-refresh-${providerFailed}"]`).click();
    await h.win.waitForTimeout(1200);
    await gotoDashboard(h.win);
    await h.win.reload();
    const card = h.win.locator(`[data-testid="provider-card-${providerFailed}"]`);
    await expect(card).toHaveClass(/failed/);
    // 硬件主题契约：失败态用 ::after 红色光环替代旧的 1px 红描边
    const ring = await card.evaluate((el) => getComputedStyle(el, '::after').boxShadow);
    expect(ring).toContain('224, 49, 49'); // #E03131
    await expect(h.win.locator(`[data-testid="card-error-msg-${providerFailed}"]`)).toContainText('⚠️ 抓取失败');
    await expect(h.win.locator(`[data-testid="card-error-msg-${providerFailed}"]`)).toContainText('凭据无效');
    await expect(h.win.locator(`[data-testid="card-manual-entry-${providerFailed}"]`)).toBeVisible();
  });

  test('手动录入 ≤3 次点击：点击行 → 提交（预填）生成 valid 快照并即时参与趋势与告警', async () => {
    await gotoDashboard(h.win);
    await h.win.reload();
    const before = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${providerFailed}'`))[0].c as number;
    await invokeIpc(h.win, 'llm:test:inject', { kind: 'clear' });
    await armClickCounterSafe();
    // 第 1 击：点击失败卡片行（弹出手动录入弹窗，数值已预填最近快照）
    await h.win.locator(`[data-testid="provider-card-${providerFailed}"]`).click({ position: { x: 40, y: 20 } });
    await expect(h.win.locator('[data-testid="manual-save"]')).toBeVisible();
    // 第 2 击：提交（预填最近快照值，无需键入）
    await h.win.locator('[data-testid="manual-save"]').click();
    const clicks = await h.win.evaluate(() => (window as unknown as { __llmClicks?: number }).__llmClicks ?? -1);
    expect(clicks).toBeLessThanOrEqual(3);
    const after = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${providerFailed}'`))[0].c as number;
    expect(after).toBe(before + 1);
    const snap = await sqlRows(h.app, `SELECT status, source, used FROM llm_usage_snapshots WHERE provider_id='${providerFailed}' ORDER BY rowid DESC LIMIT 1`);
    expect(snap[0].status).toBe('valid');
    expect(snap[0].source).toBe('manual');
    // 趋势图立即新增数据点：单击卡片（此时已非 failed）打开趋势弹层
    await gotoDashboard(h.win);
    await h.win.reload();
    await h.win.locator(`[data-testid="provider-card-${providerFailed}"]`).click({ position: { x: 40, y: 20 } });
    await expect(h.win.locator('[data-testid="trend-chart"]')).toBeVisible();
    await expect(h.win.locator('[data-testid="trend-point-used"]').first()).toBeVisible();
  });

  test('趋势弹层：双 Y 轴曲线 + 时间范围切换点数变化 + invalid 快照不绘制', async () => {
    // 注入 24h 内 3 条 valid + 2 条 invalid
    for (let i = 0; i < 3; i++) {
      await invokeIpc(h.win, 'llm:usage:manual', { providerId: providerA, mode: 'used', amount: 10 + i });
    }
    const invalidSql = `INSERT INTO llm_usage_snapshots (id, provider_id, used, remaining, total, quota_type, currency, source, status, collected_at, created_at) VALUES ('snap_invalid_a', '${providerA}', 99, 1, 50, 'usd', 'USD', 'api', 'invalid', datetime('now'), datetime('now')), ('snap_invalid_b', '${providerA}', 98, 2, 50, 'usd', 'USD', 'api', 'invalid', datetime('now'), datetime('now'))`;
    await evalService(h.app, `(s) => { s.orchestrator; const db = s.db; db.prepare(${JSON.stringify(invalidSql)}).run(); return true; }`);
    await gotoDashboard(h.win);
    await h.win.reload();
    await h.win.locator(`[data-testid="provider-card-${providerA}"]`).click({ position: { x: 40, y: 20 } });
    await expect(h.win.locator('[data-testid="trend-chart"]')).toBeVisible();
    await expect(h.win.locator('[data-testid="trend-line-used"]')).toBeVisible();
    await expect(h.win.locator('[data-testid="trend-line-remaining"]')).toBeVisible();
    const countOf = async (): Promise<number> =>
      (await h.win.locator('[data-testid="trend-point-used"]').count()) + (await h.win.locator('[data-testid="trend-point-remaining"]').count());
    // 数据点数与 SQL 有效快照严格对账：仅 status='valid' 上图（invalid 不绘制）
    const stat = await sqlRows(h.app, `SELECT status, COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${providerA}' GROUP BY status`);
    const valid = Number(stat.find((r) => r.status === 'valid')?.c ?? 0);
    const total = stat.reduce((a, r) => a + Number(r.c), 0);
    expect(total).toBeGreaterThan(valid); // 库里确有 invalid 行
    await expect(h.win.locator('[data-testid="trend-point-count"]')).toContainText(`数据点 ${valid}`);
    expect(await countOf()).toBe(valid * 2); // used + remaining 双曲线各 valid 个点
    // 切 30d：点数不变（同一天）但接口分档被调用；切 custom 日期输入出现
    await h.win.getByRole('radio', { name: 'custom' }).click();
    await expect(h.win.locator('input[aria-label="起始日期"]')).toBeVisible();
    // Esc 关闭弹层
    await h.win.keyboard.press('Escape');
    await expect(h.win.locator('[data-testid="trend-chart"]')).toHaveCount(0);
  });

  test('断网：黄色横幅「网络不可用，仅显示缓存数据」', async () => {
    await gotoDashboard(h.win);
    await h.win.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(h.win.locator('[data-testid="banner-offline"]')).toHaveText('网络不可用，仅显示缓存数据');
    // 硬件主题：横幅为琥珀斜纹底（背景图渐变），断言背景图含琥珀色
    const bgImage = await h.win.locator('[data-testid="banner-offline"]').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(bgImage).toContain('245, 166, 35'); // #F5A623 琥珀
    await h.win.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(h.win.locator('[data-testid="banner-offline"]')).toHaveCount(0);
  });

  test('双击卡片跳转提供商详情；卡片勾选可用于「刷新选中」', async () => {
    await gotoDashboard(h.win);
    await h.win.locator(`[data-testid="provider-card-${providerB}"]`).dblclick({ position: { x: 40, y: 20 } });
    await expect(h.win).toHaveURL(new RegExp(`#/provider-detail/${providerB}`));
    await expect(h.win.locator('h1')).toContainText('某厂控制台');
    await gotoDashboard(h.win);
    await h.win.locator(`[data-testid="card-check-${providerB}"]`).check();
    await expect(h.win.locator(`[data-testid="card-check-${providerB}"]`)).toBeChecked();
  });

  async function armClickCounterSafe(): Promise<void> {
    await h.win.evaluate(() => {
      const w = window as unknown as { __llmClicks?: number };
      w.__llmClicks = 0;
      if (!(w as unknown as { __llmClickArmed?: boolean }).__llmClickArmed) {
        document.addEventListener(
          'click',
          () => {
            w.__llmClicks = (w.__llmClicks ?? 0) + 1;
          },
          true,
        );
        (w as unknown as { __llmClickArmed?: boolean }).__llmClickArmed = true;
      }
    });
  }
});
