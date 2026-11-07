/**
 * 主窗口布局常量与区域浏览器（BrowserView）bounds 计算。
 * 渲染端（RegionSelectorPage）与主进程（openRegionBrowser）必须共用此模块，
 * 避免两处手算 240px 导致附着位置漂移。
 */
export const TOPBAR_H = 56;
export const REGION_BAR_H = 48;
export const STATUSBAR_GAP = 30;
/** 侧栏展开宽度（region-overlay 历史约定，勿改） */
export const SIDENAV_W = 240;
/** 侧栏折叠宽度（仅图标） */
export const SIDENAV_W_COLLAPSED = 64;

export function sidenavWidth(collapsed: boolean): number {
  return collapsed ? SIDENAV_W_COLLAPSED : SIDENAV_W;
}

/** 区域浏览器附着区域：侧栏右侧、宿主地址栏下方、底部留状态栏余量 */
export function regionBrowserBounds(
  contentWidth: number,
  contentHeight: number,
  sidebarWidth: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: sidebarWidth,
    y: TOPBAR_H + REGION_BAR_H,
    width: Math.max(300, contentWidth - sidebarWidth),
    height: Math.max(300, contentHeight - TOPBAR_H - REGION_BAR_H - STATUSBAR_GAP),
  };
}
