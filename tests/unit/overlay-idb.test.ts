import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { createRegionPersist, idbLoadRegions, idbPutRegions } from '../../src/region-overlay/index';
import type { RegionRecord } from '../../src/shared/types';

const NINE_FIELDS = ['providerId', 'name', 'x', 'y', 'w', 'h', 'mode', 'selector', 'lastModified'] as const;

describe('区域选择器 IndexedDB regions 表（P0-002：9 字段落库、防抖 300ms 持久化、重启复用）', () => {
  it('写入后可按 providerId 读取，行含全部 9 字段（providerId/name/x/y/w/h/mode/selector/lastModified 逐键 in row）', async () => {
    const rec: RegionRecord = {
      id: 'rgn_a',
      providerId: 'prov_1',
      name: '已用区域',
      x: 1180,
      y: 268,
      w: 264,
      h: 72,
      mode: 'OCR',
      selector: 'body > div#__next > canvas',
      lastModified: Date.now(),
    };
    await idbPutRegions([rec]);
    const loaded = await idbLoadRegions('prov_1');
    expect(loaded).toHaveLength(1);
    const row = loaded[0] as unknown as Record<string, unknown>;
    // 9 字段逐键 in row 断言
    for (const k of NINE_FIELDS) {
      expect(k in row, `字段 ${k} 应在 regions 行中`).toBe(true);
    }
    expect(row.providerId).toBe('prov_1');
    expect(row.name).toBe('已用区域');
    expect(typeof row.x).toBe('number');
    expect(typeof row.y).toBe('number');
    expect(typeof row.w).toBe('number');
    expect(typeof row.h).toBe('number');
    expect(row.x).toBe(1180);
    expect(row.y).toBe(268);
    expect(row.w).toBe(264);
    expect(row.h).toBe(72);
    expect(row.mode).toBe('OCR');
    // selector：非空字符串（选区中心点下页面元素的 CSS 路径）
    expect(typeof row.selector).toBe('string');
    expect(row.selector as string).toContain('canvas');
  });

  it('同 id 覆盖更新（拖拽/缩放后的新坐标落库）', async () => {
    await idbPutRegions([{ id: 'rgn_b', providerId: 'p', name: 'n', x: 1, y: 2, w: 30, h: 20, mode: 'OCR', lastModified: 1 }]);
    await idbPutRegions([{ id: 'rgn_b', providerId: 'p', name: 'n', x: 9, y: 8, w: 44, h: 22, mode: 'OCR', lastModified: 2 }]);
    const loaded = await idbLoadRegions('p');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].x).toBe(9);
    expect(loaded[0].lastModified).toBe(2);
  });

  it('按 providerId 隔离', async () => {
    await idbPutRegions([
      { id: 'r1', providerId: 'pa', name: 'a', x: 1, y: 1, w: 20, h: 20, mode: 'DOM', lastModified: 1 },
      { id: 'r2', providerId: 'pb', name: 'b', x: 2, y: 2, w: 20, h: 20, mode: 'DOM', lastModified: 1 },
    ]);
    expect(await idbLoadRegions('pa')).toHaveLength(1);
    expect(await idbLoadRegions('pb')).toHaveLength(1);
    expect(await idbLoadRegions('pc')).toHaveLength(0);
  });

  it('【P0-002 判据 4】防抖 300ms 窗口：<300ms 不写入、≥300ms 落库；每次变化各触发一次写入，窗口内连续变化合并为一次', async () => {
    vi.useFakeTimers();
    try {
      const writes: { x: number; w: number }[] = [];
      const persist = createRegionPersist(
        async (rs) => {
          writes.push({ x: rs[0].x, w: rs[0].w });
        },
        300,
      );
      const base = { id: 'rgn_d', providerId: 'p', name: 'n', y: 2, h: 20, mode: 'OCR' as const, selector: 'body > canvas', lastModified: 1 };
      // 拖拽结束（第 1 次变化）→ 防抖计时开始
      persist.notify([{ ...base, x: 10, w: 100 }]);
      expect(persist.pending()).toBe(true);
      await vi.advanceTimersByTimeAsync(299); // 防抖窗口内（<300ms）
      expect(writes).toHaveLength(0); // 尚未写入
      expect(persist.pending()).toBe(true);
      await vi.advanceTimersByTimeAsync(1); // 累计恰好 300ms
      expect(writes).toHaveLength(1); // 落库
      expect(writes[0]).toEqual({ x: 10, w: 100 });
      expect(persist.pending()).toBe(false);
      // 缩放（第 2 次变化）→ 再次各触发一次写入，值为最新坐标
      persist.notify([{ ...base, x: 12, w: 112 }]);
      await vi.advanceTimersByTimeAsync(300);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual({ x: 12, w: 112 });
      // 300ms 窗口内连续两次变化 → 合并为一次写入，仅落最新值
      persist.notify([{ ...base, x: 14, w: 130 }]);
      persist.notify([{ ...base, x: 16, w: 140 }]);
      await vi.advanceTimersByTimeAsync(299);
      expect(writes).toHaveLength(2); // 窗口内仍未写入
      await vi.advanceTimersByTimeAsync(1);
      expect(writes).toHaveLength(3); // 只写一次
      expect(writes[2]).toEqual({ x: 16, w: 140 }); // 且是最新值
    } finally {
      vi.useRealTimers();
    }
  });
});
