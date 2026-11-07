import { describe, expect, it } from 'vitest';
import { SIDENAV_W, SIDENAV_W_COLLAPSED, regionBrowserBounds, sidenavWidth } from '../../src/shared/layout';

describe('shared/layout 主窗口布局常量', () => {
  it('侧栏宽度：展开 240 / 折叠 64（region-overlay 历史约定不可改）', () => {
    expect(SIDENAV_W).toBe(240);
    expect(SIDENAV_W_COLLAPSED).toBe(64);
    expect(sidenavWidth(false)).toBe(240);
    expect(sidenavWidth(true)).toBe(64);
  });

  it('区域浏览器 bounds：顶栏 56 + 地址栏 48 起算，x/宽度随侧栏宽度让位', () => {
    expect(regionBrowserBounds(1360, 880, 240)).toEqual({ x: 240, y: 104, width: 1120, height: 746 });
    expect(regionBrowserBounds(1360, 880, 64)).toEqual({ x: 64, y: 104, width: 1296, height: 746 });
  });

  it('极小窗口兜底：宽高下限 300', () => {
    expect(regionBrowserBounds(400, 300, 240)).toEqual({ x: 240, y: 104, width: 300, height: 300 });
    expect(regionBrowserBounds(300, 400, 64)).toEqual({ x: 64, y: 104, width: 300, height: 300 });
  });
});
