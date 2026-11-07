/**
 * 窗口呼出的「是否算从后台切回」判定（纯函数，无 electron 依赖，便于单测）。
 *
 * 背景：Alt+Tab 从别的应用切回来时，窗口始终是可见的（未最小化、未隐藏），
 * BrowserWindow 的 show / restore 都不触发，只有 focus 会。因此必须覆盖 focus。
 * 但 focus 不能无条件绑定 —— 在窗口内点击任意位置同样会让窗口获得焦点，
 * 否则「点一下按钮就全量采集一次」。故用 blur/focus 配对：
 * 记录 blur 时刻，focus 时若已离开超过 BACKGROUND_GAP_MS 才算「从后台切回」。
 */

/** 从后台切回的判定阈值：离开不足 60s 视为短暂切换或窗口内误点，不触发采集 */
export const BACKGROUND_GAP_MS = 60_000;

/**
 * @param blurredAt 上次 blur 的时间戳；0 表示从未 blur 过（冷启动后一直前置）
 * @param now 当前时间戳
 * @returns 是否应因这次 focus 触发自动刷新
 */
export function isReturnFromBackground(blurredAt: number, now: number, gapMs: number = BACKGROUND_GAP_MS): boolean {
  if (!blurredAt) return false;
  return now - blurredAt >= gapMs;
}
