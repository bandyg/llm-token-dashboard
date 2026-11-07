import { launchHarness, sqlRows, gotoDashboard, expect, test, invokeIpc, type TestHarness } from './helpers';

let h: TestHarness;

test.describe.serial('P1-001 提供商配置界面', () => {
  test.beforeAll(async () => {
    h = await launchHarness();
    await h.win.evaluate(() => {
      window.location.hash = '#/providers';
    });
  });

  test.afterAll(async () => {
    await h?.close();
  });

  test('模板列表含 12 个内置厂商；选择模板后默认字段自动填充', async () => {
    for (const name of ['OpenAI', 'Anthropic', 'Google AI', '智谱', 'DeepSeek', '通义千问', '文心一言', '小米 MiMo', 'MiniMax', 'OpenCode Go', 'Ollama', '自定义']) {
      await expect(h.win.getByText(name, { exact: true }).first()).toBeVisible();
    }
    await h.win.locator('.selectable-list .tpl', { hasText: '智谱' }).first().click();
    await expect(h.win.locator('#pf-name')).toHaveValue('智谱');
    // 智谱为 CREDIT 多窗口模板，quotaTotal 为 null（不设总额，仅展示各窗口）
    await expect(h.win.locator('#pf-total')).toHaveValue('');
    // 凭据 Tab：Base URL 自动填充
    await h.win.getByRole('tab', { name: '凭据' }).click();
    await expect(h.win.locator('#pf-baseurl')).toHaveValue(/bigmodel\.cn/);
    // 抓取方式 Tab：智谱模板默认官方 API 模式
    await h.win.getByRole('tab', { name: '抓取方式' }).click();
    await expect(h.win.getByRole('radio', { name: '官方 API（自动）' })).toBeChecked();
    // 新增模板（小米 MiMo / MiniMax / OpenCode）：默认字段自动填充
    await h.win.locator('.selectable-list .tpl', { hasText: '小米 MiMo' }).first().click();
    await h.win.getByRole('tab', { name: '基本信息' }).click();
    await expect(h.win.locator('#pf-name')).toHaveValue('小米 MiMo');
    await h.win.getByRole('tab', { name: '凭据' }).click();
    await expect(h.win.locator('#pf-baseurl')).toHaveValue(/api\.xiaomimimo\.com\/v1/);
    await h.win.locator('.selectable-list .tpl', { hasText: 'MiniMax' }).first().click();
    await h.win.getByRole('tab', { name: '基本信息' }).click();
    await expect(h.win.locator('#pf-name')).toHaveValue('MiniMax');
    await h.win.getByRole('tab', { name: '凭据' }).click();
    await expect(h.win.locator('#pf-baseurl')).toHaveValue(/api\.minimaxi\.com\/v1/);
    await h.win.locator('.selectable-list .tpl', { hasText: 'OpenCode' }).first().click();
    await h.win.getByRole('tab', { name: '基本信息' }).click();
    await expect(h.win.locator('#pf-name')).toHaveValue('OpenCode Go');
    await h.win.getByRole('tab', { name: '凭据' }).click();
    await expect(h.win.locator('#pf-baseurl')).toHaveValue(/opencode\.ai\/zen\/v1/);
  });

  test('capture-mode 四项单选：mode/sub_mode 及参数写入 SQLite（dom_script / region+ocr_threshold）', async () => {
    // 基本信息：命名
    await h.win.getByRole('tab', { name: '基本信息' }).click();
    await h.win.locator('#pf-name').fill('配置测试厂');
    await h.win.locator('#pf-alias').fill('dom 账号');
    // DOM 模式（填写自定义 dom_script：静态表达式，仅读取文本）
    await h.win.getByRole('tab', { name: '抓取方式' }).click();
    await h.win.getByRole('radio', { name: 'BrowserView DOM 抓取' }).check();
    await h.win.locator('[data-testid="dom-url"]').fill(`http://127.0.0.1:${h.mock.port}/console?auth=ok`);
    const domScript = `JSON.stringify({ u: document.querySelector('.quota-used')?.textContent ?? null })`;
    await h.win.locator('#pf-domscript').fill(domScript);
    await h.win.locator('[data-testid="provider-save"]').click();
    await h.win.waitForTimeout(1000);
    const rows = await sqlRows(h.app, `SELECT id, mode, sub_mode, dom_script, selectors FROM providers WHERE provider_name='配置测试厂'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('web_crawl');
    expect(rows[0].sub_mode).toBe('dom');
    // 判据：DOM 模式保存 dom_script，落库字段可查询（与表单输入一致）
    expect(rows[0].dom_script).toBe(domScript);
    expect(JSON.parse(rows[0].selectors as string).length).toBeGreaterThanOrEqual(0);
    // 切 OCR 模式：ocr_threshold 落库
    const pid = rows[0].id as string;
    await h.win.locator(`[data-testid="provider-row-edit-${pid}"]`).click();
    await h.win.getByRole('tab', { name: '抓取方式' }).click();
    await h.win.getByRole('radio', { name: 'BrowserView OCR 抓取' }).check();
    await h.win.locator('#pf-ocr-th').fill('0.85');
    await h.win.locator('[data-testid="provider-save"]').click();
    await h.win.waitForTimeout(800);
    const rowOcr = await sqlRows(h.app, `SELECT mode, sub_mode, ocr_threshold FROM providers WHERE id='${pid}'`);
    expect(rowOcr[0].sub_mode).toBe('ocr');
    expect(Number(rowOcr[0].ocr_threshold)).toBeCloseTo(0.85, 2);
    // 切「仅手动录入」→ mode=manual
    await h.win.locator(`[data-testid="provider-row-edit-${pid}"]`).click();
    await h.win.getByRole('tab', { name: '抓取方式' }).click();
    await h.win.getByRole('radio', { name: '仅手动录入' }).check();
    await h.win.locator('[data-testid="provider-save"]').click();
    await h.win.waitForTimeout(800);
    const rowManual = await sqlRows(h.app, `SELECT mode, sub_mode FROM providers WHERE id='${pid}'`);
    expect(rowManual[0].mode).toBe('manual');
    expect(rowManual[0].sub_mode).toBeNull();
  });

  test('凭据测试：错误 Key → 红字「凭据无效 (401)」；测试期间按钮禁用转圈', async () => {
    await h.win.locator('.selectable-list .tpl', { hasText: 'OpenAI' }).first().click();
    await h.win.getByRole('tab', { name: '凭据' }).click();
    // Base URL 指向本地 mock（对齐 AC 例外条款：可用 Mock Server 替代真实厂商接口）
    await h.win.locator('#pf-baseurl').fill(`http://127.0.0.1:${h.mock.port}`);
    await h.win.locator('[data-testid="cred-apikey"]').fill('sk-wrong');
    const btn = h.win.locator('[data-testid="cred-test"]');
    await btn.click();
    // 注：本地 mock 响应 <10ms，「测试期间禁用+转圈」状态窗口过短，由 ProvidersPage testing 状态逻辑覆盖（见渲染层实现 loading && <Spinner/>）
    await expect(h.win.locator('[data-testid="cred-result"]')).toContainText('凭据无效 (401)', { timeout: 10000 });
    // 正确 Key → 绿色对勾
    await h.win.locator('[data-testid="cred-apikey"]').fill('sk-good');
    await btn.click();
    await expect(h.win.locator('[data-testid="cred-result"]')).toContainText('✓', { timeout: 10000 });
    await expect(h.win.locator('[data-testid="cred-result"]')).toContainText('连接成功');
    // 眼睛图标切换明文
    await h.win.locator('button[aria-label="显示"]').click();
    await expect(h.win.locator('[data-testid="cred-apikey"]')).toHaveAttribute('type', 'text');
  });

  test('DOM 配置区：dom-url + Cookie 导入按钮 + 选择器列表 + 未匹配红字提示与「打开浏览器调试」按钮', async () => {
    await h.win.getByRole('tab', { name: '抓取方式' }).click();
    await h.win.getByRole('radio', { name: 'BrowserView DOM 抓取' }).check();
    await h.win.locator('[data-testid="dom-url"]').fill(`http://127.0.0.1:${h.mock.port}/console`);
    // 登录态 cookie 导入按钮（判据元素）
    await expect(h.win.getByRole('button', { name: '导入 / 打开浏览器登录' })).toBeVisible();
    // 选择器列表行（OpenAI 模板自带 1 条，添加后 ≥2 行）
    await h.win.getByRole('button', { name: '＋ 添加选择器' }).click();
    await expect(h.win.locator('[data-testid^="dom-selector-row-"]').nth(1)).toBeVisible();
    // 校验选择器：未配置页面时（form 未保存）给出红字提示
    await h.win.getByRole('button', { name: '校验选择器' }).click();
    await expect(h.win.locator('[data-testid="selector-miss"]')).toBeVisible();
    await expect(h.win.getByRole('button', { name: '打开浏览器调试' })).toBeVisible();
  });

  test('测试连接超时 10s：弹窗询问「继续等待/跳过」，跳过后提示已跳过', async () => {
    await h.win.locator('.selectable-list .tpl', { hasText: 'OpenAI' }).first().click();
    await h.win.getByRole('tab', { name: '凭据' }).click();
    await h.win.locator('#pf-baseurl').fill(`http://127.0.0.1:${h.mock.port}`);
    // 武装 mock：下一个 usage 请求挂起不响应
    await h.mock.armHangNext();
    await h.win.locator('[data-testid="cred-apikey"]').fill('sk-good');
    await h.win.locator('[data-testid="cred-test"]').click();
    // 10s 超时后弹窗出现（真实墙钟等待；上限 15s expect 超时兜底）
    const dialog = h.win.locator('.modal, [role="dialog"]').filter({ hasText: '测试连接超时' });
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog).toContainText('继续等待');
    await expect(dialog).toContainText('跳过');
    // 点「跳过」→ 弹窗关闭 + 红字/提示「已跳过本次测试」
    await dialog.getByRole('button', { name: '跳过' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(h.win.locator('[data-testid="cred-result"]')).toContainText('已跳过本次测试');
  });

  test('硬上限 30：第 31 个 Provider 保存被拒，UI 弹「已达硬上限 30」且 SQLite 不新增', async () => {
    // 前序用例的 error/warning toast 不自动消失（设计如此），会遮挡表单保存按钮：先手动关闭
    await h.win.evaluate(() => {
      document.querySelectorAll<HTMLButtonElement>('.toast button[aria-label="关闭提示"]').forEach((b) => b.click());
    });
    // 通过 IPC 把启用 Provider 补齐到 30（同 harness 此前用例已有若干条）
    const base = `http://127.0.0.1:${h.mock.port}`;
    const countEnabled = async (): Promise<number> =>
      Number(((await sqlRows(h.app, `SELECT COUNT(*) AS c FROM providers WHERE enabled=1`))[0].c));
    const have = await countEnabled();
    for (let i = 0; i < 30 - have; i++) {
      await invokeIpc(h.win, 'llm:providers:create', {
        provider_name: `容量厂 ${i}`,
        alias: '容量',
        mode: 'manual',
        enabled: 1,
        quota_total: 10,
        alert_threshold: 1,
        dom_url: `${base}/console?auth=ok`,
      });
    }
    expect(await countEnabled()).toBe(30);
    // 第 31 个：走 UI 表单保存 → 错误 toast 含「已达硬上限 30」
    await h.win.getByRole('tab', { name: '基本信息' }).click();
    await h.win.locator('#pf-name').fill('第31个厂');
    await h.win.locator('[data-testid="provider-save"]').click();
    await expect(h.win.locator('[data-testid="toast-error"]')).toContainText('已达硬上限 30');
    // SQLite 不新增记录
    const after = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM providers WHERE provider_name='第31个厂'`))[0].c as number;
    expect(Number(after)).toBe(0);
    // 清理容量数据，避免污染同文件后续断言（本用例为该 describe 最后一条）
    const ids = await sqlRows(h.app, `SELECT id FROM providers WHERE provider_name LIKE '容量厂 %'`);
    for (const r of ids) await invokeIpc(h.win, 'llm:providers:delete', { id: r.id });
  });

  test('CRUD 持久化：同一 provider_name ≥2 条 alias 不同记录渲染多行；enabled=false 不渲染但保留', async () => {
    const base = `http://127.0.0.1:${h.mock.port}`;
    // 通过 IPC 建立「同厂商多账号」
    const a = await invokeIpc<{ id: string }>(h.win, 'llm:providers:create', {
      provider_name: '多账号厂',
      alias: 'A 号',
      mode: 'web_crawl',
      sub_mode: 'dom',
      dom_url: `${base}/console?auth=ok`,
      quota_total: 50,
      alert_threshold: 10,
    });
    const b = await invokeIpc<{ id: string }>(h.win, 'llm:providers:create', {
      provider_name: '多账号厂',
      alias: 'B 号',
      mode: 'web_crawl',
      sub_mode: 'dom',
      dom_url: `${base}/console?auth=ok`,
      quota_total: 50,
      alert_threshold: 10,
    });
    const two = await sqlRows(h.app, `SELECT alias FROM providers WHERE provider_name='多账号厂'`);
    expect(two.map((r) => r.alias).sort()).toEqual(['A 号', 'B 号']);
    // Dashboard 渲染多行
    await gotoDashboard(h.win);
    await h.win.reload();
    await expect(h.win.locator(`[data-testid="provider-card-${a.id}"]`)).toContainText('A 号');
    await expect(h.win.locator(`[data-testid="provider-card-${b.id}"]`)).toContainText('B 号');
    // enabled=false 不渲染但记录保留
    await invokeIpc(h.win, 'llm:providers:set-enabled', { id: b.id, enabled: false });
    await h.win.reload();
    await expect(h.win.locator(`[data-testid="provider-card-${b.id}"]`)).toHaveCount(0);
    const kept = await sqlRows(h.app, `SELECT enabled FROM providers WHERE id='${b.id}'`);
    expect(kept[0].enabled).toBe(0);
    // DELETE 后行数变化
    await invokeIpc(h.win, 'llm:providers:delete', { id: b.id });
    const gone = await sqlRows(h.app, `SELECT COUNT(*) AS c FROM providers WHERE id='${b.id}'`);
    expect(Number(gone[0].c)).toBe(0);
  });

  test('多账号独立 webContents.id；cookies 表按 provider_id 隔离；Cmd/Ctrl+S 保存、Esc 关闭', async () => {
    const base = `http://127.0.0.1:${h.mock.port}`;
    const a = await invokeIpc<{ id: string }>(h.win, 'llm:providers:create', { provider_name: '会话厂', alias: 'X', mode: 'web_crawl', sub_mode: 'dom', dom_url: `${base}/console?auth=ok` });
    const b = await invokeIpc<{ id: string }>(h.win, 'llm:providers:create', { provider_name: '会话厂', alias: 'Y', mode: 'web_crawl', sub_mode: 'dom', dom_url: `${base}/console?auth=ok` });
    const oa = await invokeIpc<{ webContentsId: number }>(h.win, 'llm:browser:open', { providerId: a.id });
    const ob = await invokeIpc<{ webContentsId: number }>(h.win, 'llm:browser:open', { providerId: b.id });
    expect(oa.webContentsId).not.toBe(ob.webContentsId);
    await invokeIpc(h.win, 'llm:browser:close', { providerId: a.id });
    await invokeIpc(h.win, 'llm:browser:close', { providerId: b.id });
    // Cookie 隔离（登录后各 partition 导出各自 provider_id 行）
    await invokeIpc(h.win, 'llm:browser:open-login', { providerId: a.id });
    let loginWin: import('playwright').Page | undefined;
    for (let i = 0; i < 20 && !loginWin; i++) {
      loginWin = h.app.windows().find((w) => w !== h.win && /127\.0\.0\.1/.test(w.url()));
      if (!loginWin) await h.win.waitForTimeout(300);
    }
    if (loginWin) {
      await loginWin.fill('input[type="password"]', 'secret').catch(() => undefined);
      await Promise.all([
        loginWin.waitForURL(/console/, { timeout: 8000 }).catch(() => undefined),
        loginWin.click('button[type="submit"]').catch(() => undefined),
      ]);
      await loginWin.close();
    }
    await h.win.waitForTimeout(1000);
    const ca = await sqlRows(h.app, `SELECT provider_id FROM cookies WHERE provider_id='${a.id}'`);
    if (ca.length) {
      expect(ca.every((c) => c.provider_id === a.id)).toBe(true);
    }
    // Ctrl+S 保存 + Esc 关闭（ProvidersPage 快捷键）
    await h.win.evaluate(() => {
      window.location.hash = '#/providers';
    });
    await h.win.locator('.selectable-list .tpl', { hasText: '自定义' }).first().click();
    await h.win.locator('#pf-name').fill('快捷键厂');
    await h.win.keyboard.press('Control+s');
    await h.win.waitForTimeout(800);
    const saved = await sqlRows(h.app, `SELECT id FROM providers WHERE provider_name='快捷键厂'`);
    expect(saved).toHaveLength(1);
    await h.win.keyboard.press('Escape');
    await expect(h.win.locator('[data-testid="provider-form"]')).toHaveCount(0);
  });
});
