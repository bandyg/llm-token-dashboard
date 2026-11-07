import { describe, expect, it } from 'vitest';
import { BACKGROUND_GAP_MS, isReturnFromBackground } from '../../src/main/window-focus';

/**
 * 回归锁定：Alt+Tab 从别的应用切回时，窗口始终可见（未最小化、未隐藏），
 * BrowserWindow 的 show / restore 都不触发，只有 focus 会。
 * 若这里判错，「切到应用」这个最常见场景就不会触发自动刷新；
 * 若判得太宽，窗口内随便点一下就会全量采集一次、打爆厂商接口。
 */
describe('窗口 focus 是否算「从后台切回」（自动刷新触发条件）', () => {
  it('离开超过阈值 → 算切回，应触发刷新', () => {
    const t0 = 1_000_000;
    expect(isReturnFromBackground(t0, t0 + BACKGROUND_GAP_MS)).toBe(true);
    expect(isReturnFromBackground(t0, t0 + BACKGROUND_GAP_MS + 1)).toBe(true);
    expect(isReturnFromBackground(t0, t0 + 5 * 60_000)).toBe(true);
  });

  it('离开不足阈值 → 窗口内误点/短暂切换，不应触发', () => {
    const t0 = 1_000_000;
    expect(isReturnFromBackground(t0, t0 + 1)).toBe(false);
    expect(isReturnFromBackground(t0, t0 + 5_000)).toBe(false);
    expect(isReturnFromBackground(t0, t0 + BACKGROUND_GAP_MS - 1)).toBe(false);
  });

  it('从未 blur 过（blurredAt=0）→ 不算切回，避免冷启动后立即二次采集', () => {
    expect(isReturnFromBackground(0, 10_000_000)).toBe(false);
  });

  it('阈值可注入，便于调整而不改调用点', () => {
    const t0 = 5_000;
    expect(isReturnFromBackground(t0, t0 + 3_000, 1_000)).toBe(true);
    expect(isReturnFromBackground(t0, t0 + 500, 1_000)).toBe(false);
  });
});
