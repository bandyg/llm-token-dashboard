import { launchHarness, expect, test, type TestHarness } from './helpers';

let h: TestHarness;

test.describe.serial('P1-002 侧栏折叠', () => {
  test.beforeAll(async () => {
    h = await launchHarness();
  });

  test.afterAll(async () => {
    await h?.close();
  });

  test('折叠/展开切换：240 ↔ 64，标签隐藏但链接可访问名保留，aria 同步', async () => {
    const nav = h.win.locator('[data-testid="sidenav"]');
    const toggle = h.win.locator('[data-testid="sidenav-toggle"]');
    await expect(nav).toHaveCSS('width', '240px');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-label', '收起侧栏');

    await toggle.click();
    // 宽度过渡 0.18s，toHaveCSS 自动重试至稳定值
    await expect(nav).toHaveCSS('width', '64px');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-label', '展开侧栏');
    // 文本标签 display:none 后链接仍以 aria-label 暴露可访问名
    await expect(h.win.getByRole('link', { name: '提供商配置' })).toBeVisible();

    await toggle.click();
    await expect(nav).toHaveCSS('width', '240px');
  });

  test('折叠状态持久化：刷新后保持折叠，再点开恢复', async () => {
    const nav = h.win.locator('[data-testid="sidenav"]');
    const toggle = h.win.locator('[data-testid="sidenav-toggle"]');
    await toggle.click();
    await expect(nav).toHaveCSS('width', '64px');

    await h.win.reload();
    await h.win.waitForSelector('[data-testid="main-area"]');
    await expect(nav).toHaveCSS('width', '64px'); // localStorage 恢复

    await toggle.click();
    await expect(nav).toHaveCSS('width', '240px');
  });

  test('快捷键 Cmd/Ctrl+B 切换折叠', async () => {
    const nav = h.win.locator('[data-testid="sidenav"]');
    await h.win.keyboard.press('Control+b');
    await expect(nav).toHaveCSS('width', '64px');
    await h.win.keyboard.press('Control+b');
    await expect(nav).toHaveCSS('width', '240px');
  });
});
