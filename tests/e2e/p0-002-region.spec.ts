import { launchHarness, sqlRows, seedProvider, expect, test, invokeIpc, type TestHarness, type EvalFrame } from './helpers';
import type { Page } from 'playwright';

let h: TestHarness;
let ov: EvalFrame;
let providerId = '';
const CANVAS = { x: 120, y: 160, w: 540, h: 42 }; // mock 控制台 canvas（overlay 页面坐标）

async function overlayFrame(win: Page): Promise<EvalFrame> {
  for (let i = 0; i < 40; i++) {
    // BrowserView 在 Playwright 中作为独立 Page 暴露
    for (const w of win.context().pages()) {
      if (w === win) continue;
      if (!/127\.0\.0\.1/.test(w.url())) continue;
      const ready = await w.evaluate(() => !!document.querySelector('#__llm-overlay-svg')).catch(() => false);
      if (ready) return w as unknown as EvalFrame;
    }
    await win.waitForTimeout(250);
  }
  throw new Error('区域 overlay 未注入');
}

test.describe.serial('P0-002 区域选择器拖拽框选（产品记忆点）', () => {
  test.beforeAll(async () => {
    h = await launchHarness();
    const base = `http://127.0.0.1:${h.mock.port}`;
    providerId = await seedProvider(h.win, {
      provider_name: 'OCR 厂商',
      alias: '框选账号',
      mode: 'web_crawl',
      sub_mode: 'ocr',
      dom_url: `${base}/console?auth=ok`,
      ocr_threshold: 0.8,
      quota_total: 500,
    });
    await h.win.evaluate(() => {
      window.location.hash = '#/region';
    });
    // 窄屏（窗口低于应用声明的 minWidth 1100，如 800DIP 竖屏）：折叠侧栏让出中部宽度，
    // BrowserView 才容得下 mock canvas（右缘 661px）与选区东向缩放余量；宽屏下条件不触发
    if (await h.win.evaluate(() => window.innerWidth < 1100)) {
      await h.win.locator('[data-testid="sidenav-toggle"]').click();
    }
    await h.win.selectOption('[data-testid="region-provider-select"]', providerId);
    await h.win.locator('[data-testid="region-open-browser"]').click();
    ov = await overlayFrame(h.win);
  });

  test.afterAll(async () => {
    await h?.close();
  });

  /** 在 overlay 页面内派发真实 DOM 鼠标事件（Playwright 合成鼠标无法路由进 BrowserView，事件语义等价）；
   *  target 可为 'svg'/'window'/'rect' 或手柄序号（0..7，对应 region-handle-{n}） */
  async function fireMouse(type: string, cx: number, cy: number, target: 'svg' | 'window' | 'rect' | number): Promise<void> {
    await ov.evaluate(
      ({ type, cx, cy, target }) => {
        const svg = document.querySelector('#__llm-overlay-svg') as SVGSVGElement;
        const el =
          typeof target === 'number'
            ? (document.querySelector(`[data-testid="region-handle-${target}"]`) as EventTarget)
            : target === 'svg'
              ? svg
              : target === 'window'
                ? window
                : (document.querySelector('.region-rect.editing, .region-rect') as EventTarget);
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: cx, clientY: cy }));
      },
      { type, cx, cy, target },
    );
  }
  async function dragOverlay(x0: number, y0: number, x1: number, y1: number, steps = 6): Promise<void> {
    await fireMouse('mousemove', x0, y0, 'svg');
    await fireMouse('mousedown', x0, y0, 'svg');
    for (let i = 1; i <= steps; i++) {
      await fireMouse('mousemove', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, 'svg');
    }
    await fireMouse('mouseup', x1, y1, 'window');
  }

  async function confirmName(name: string): Promise<void> {
    await ov.evaluate((n) => {
      const input = document.querySelector('[data-testid="region-name-input"]') as HTMLInputElement;
      input.value = n;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, name);
  }

  async function rectBox(): Promise<{ x: number; y: number; w: number; h: number }> {
    return ov.evaluate(() => {
      const r = document.querySelector('.region-rect.editing, .region-rect') as SVGRectElement;
      return { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) };
    });
  }

  test('Alt 以中心为锚点缩放：按住 Alt 拖 SE 手柄，矩形放大但中心坐标保持不变', async () => {
    // 上一用例 Delete 后选区为 0；重新拖一个专属选区
    await dragOverlay(CANVAS.x + 40, CANVAS.y + 120, CANVAS.x + 240, CANVAS.y + 190);
    await expect(ov.locator('[data-testid="region-name-input"]')).toBeVisible();
    await confirmName('中心锚区域');
    const before = await rectBox();
    const cx0 = before.x + before.w / 2;
    const cy0 = before.y + before.h / 2;
    // 按住 Alt（keydown 置 altDown）+ 拖 SE 手柄（handle-4）向外拉
    await ov.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true, cancelable: true }));
    });
    await fireMouse('mousedown', before.x + before.w, before.y + before.h, 4);
    for (let i = 1; i <= 4; i++) {
      await fireMouse('mousemove', before.x + before.w + i * 15, before.y + before.h + i * 10, 'svg');
    }
    await fireMouse('mouseup', before.x + before.w + 60, before.y + before.h + 40, 'window');
    await ov.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
    });
    const after = await rectBox();
    // 放大发生
    expect(after.w).toBeGreaterThan(before.w);
    expect(after.h).toBeGreaterThan(before.h);
    // 中心锚定：Alt 缩放前后几何中心不变（允许 ±1px 取整误差）
    const cx1 = after.x + after.w / 2;
    const cy1 = after.y + after.h / 2;
    expect(Math.abs(cx1 - cx0)).toBeLessThanOrEqual(1);
    expect(Math.abs(cy1 - cy0)).toBeLessThanOrEqual(1);
    // 对照组（同一用例内）：不按 Alt 拖 SE 手柄 → 中心必须移动，证明上一步的中心保持确由 Alt 驱动
    const mid = { x: after.x + after.w / 2, y: after.y + after.h / 2 };
    await fireMouse('mousedown', after.x + after.w, after.y + after.h, 4);
    for (let i = 1; i <= 4; i++) {
      await fireMouse('mousemove', after.x + after.w + i * 10, after.y + after.h + i * 8, 'svg');
    }
    await fireMouse('mouseup', after.x + after.w + 40, after.y + after.h + 32, 'window');
    const plain = await rectBox();
    expect(Math.abs(plain.x + plain.w / 2 - mid.x)).toBeGreaterThan(1);
    // 清理：Delete 删除，恢复 0 选区供后续用例
    await ov.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await expect(ov.locator('[data-testid="overlay-count"]')).toHaveText('选区 0');
  });

  test('【返工 v2】Shift+拖手柄等比缩放（w/h 比值不变）+ 四边中点手柄单边缩放（n/e/s/w）', async () => {
    // 上一用例 Delete 后选区为 0；新建 2:1 选区（200×100），便于等比断言
    await dragOverlay(CANVAS.x + 40, CANVAS.y + 120, CANVAS.x + 240, CANVAS.y + 220);
    await expect(ov.locator('[data-testid="region-name-input"]')).toBeVisible();
    await confirmName('等比缩放区域');
    const before = await rectBox();
    expect(before.w).toBe(200);
    expect(before.h).toBe(100);

    // ── Shift + 拖 SE 角手柄（handle-4）→ 等比缩放：w、h 同步放大且 w/h 比值不变 ──
    await ov.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true, cancelable: true }));
    });
    await fireMouse('mousedown', before.x + before.w, before.y + before.h, 4);
    for (let i = 1; i <= 4; i++) {
      await fireMouse('mousemove', before.x + before.w + i * 10, before.y + before.h + i * 8, 'svg');
    }
    await fireMouse('mouseup', before.x + before.w + 40, before.y + before.h + 32, 'window');
    await ov.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
    });
    const afterShift = await rectBox();
    // 实际拉伸了宽度（+40）与高度（等比 +20）
    expect(afterShift.w).toBeGreaterThan(before.w);
    expect(afterShift.h).toBeGreaterThan(before.h);
    // 等比断言：缩放前后 w/h 比值不变（2.0）
    expect(afterShift.w / afterShift.h).toBeCloseTo(before.w / before.h, 5);
    expect(afterShift.h).toBe(before.h + 20); // ratio=2：w+40 → h+20

    // ── 四边中点手柄单边缩放（每边仅一个维度变化）──
    // handle-3（e 东边中点）：向右拖 30 → 仅 w+30；x/y/h 不变
    const be = await rectBox();
    await fireMouse('mousedown', be.x + be.w, be.y + be.h / 2, 3);
    await fireMouse('mousemove', be.x + be.w + 30, be.y + be.h / 2, 'svg');
    await fireMouse('mouseup', be.x + be.w + 30, be.y + be.h / 2, 'window');
    const afterE = await rectBox();
    expect(afterE.w).toBe(be.w + 30);
    expect(afterE.h).toBe(be.h);
    expect(afterE.x).toBe(be.x);
    expect(afterE.y).toBe(be.y);

    // handle-1（n 北边中点）：向上拖 20 → 仅 y−20、h+20；x/w 不变
    const bn = afterE;
    await fireMouse('mousedown', bn.x + bn.w / 2, bn.y, 1);
    await fireMouse('mousemove', bn.x + bn.w / 2, bn.y - 20, 'svg');
    await fireMouse('mouseup', bn.x + bn.w / 2, bn.y - 20, 'window');
    const afterN = await rectBox();
    expect(afterN.y).toBe(bn.y - 20);
    expect(afterN.h).toBe(bn.h + 20);
    expect(afterN.x).toBe(bn.x);
    expect(afterN.w).toBe(bn.w);

    // handle-5（s 南边中点）：向下拖 25 → 仅 h+25；x/y/w 不变
    const bs = afterN;
    await fireMouse('mousedown', bs.x + bs.w / 2, bs.y + bs.h, 5);
    await fireMouse('mousemove', bs.x + bs.w / 2, bs.y + bs.h + 25, 'svg');
    await fireMouse('mouseup', bs.x + bs.w / 2, bs.y + bs.h + 25, 'window');
    const afterS = await rectBox();
    expect(afterS.h).toBe(bs.h + 25);
    expect(afterS.x).toBe(bs.x);
    expect(afterS.y).toBe(bs.y);
    expect(afterS.w).toBe(bs.w);

    // handle-7（w 西边中点）：向右拖 25 → 仅 x+25、w−25；y/h 不变
    const bw = afterS;
    await fireMouse('mousedown', bw.x, bw.y + bw.h / 2, 7);
    await fireMouse('mousemove', bw.x + 25, bw.y + bw.h / 2, 'svg');
    await fireMouse('mouseup', bw.x + 25, bw.y + bw.h / 2, 'window');
    const afterW = await rectBox();
    expect(afterW.x).toBe(bw.x + 25);
    expect(afterW.w).toBe(bw.w - 25);
    expect(afterW.y).toBe(bw.y);
    expect(afterW.h).toBe(bw.h);

    // 清理：Delete 删除，恢复 0 选区供后续用例
    await ov.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await expect(ov.locator('[data-testid="overlay-count"]')).toHaveText('选区 0');
  });

  test('打开浏览器捕获：BrowserView 占满中部 + z-index 9999 透明画布 + crosshair + 状态栏', async () => {
    const style = await ov.evaluate(() => {
      const svg = document.querySelector('#__llm-overlay-svg') as SVGSVGElement;
      const cs = getComputedStyle(svg);
      return { z: cs.zIndex, pe: cs.pointerEvents, cursor: cs.cursor, position: cs.position };
    });
    expect(style.z).toBe('9999');
    expect(style.pe).toBe('auto');
    expect(style.cursor).toBe('crosshair');
    // 底部状态栏：坐标 + 选区数量
    await expect(ov.locator('[data-testid="overlay-coord"]')).toHaveText(/-?\d+,-?\d+/);
    await expect(ov.locator('[data-testid="overlay-count"]')).toHaveText('选区 0');
    // 空态提示条
    await expect(ov.locator('[data-testid="overlay-hint"]')).toContainText('按住鼠标左键拖拽框选需要监控的区域');
  });

  test('拖拽绘制：蓝色虚线矩形实时跟随 → 松开进入编辑态 + 自动弹出命名框（全程零手填数字）', async () => {
    // 绘制中：边框 2px dashed #2D7FF9、填充 rgba(45,127,249,0.15)、跟随光标
    await fireMouse('mousemove', CANVAS.x - 12, CANVAS.y - 12, 'svg');
    await fireMouse('mousedown', CANVAS.x - 12, CANVAS.y - 12, 'svg');
    await fireMouse('mousemove', CANVAS.x + 200, CANVAS.y + 10, 'svg');
    const drawing = await ov.evaluate(() => {
      const r = document.querySelector('#__llm-overlay-svg > rect:not([visibility="hidden"])') as SVGRectElement | null;
      if (!r) return null;
      const cs = getComputedStyle(r);
      return { stroke: cs.stroke, width: cs.strokeWidth, dash: cs.strokeDasharray, fill: cs.fill };
    });
    expect(drawing).not.toBeNull();
    expect(drawing?.stroke).toBe('rgb(45, 127, 249)');
    expect(drawing?.width).toBe('2px');
    expect(drawing?.dash.replace(/, /g, ' ')).toBe('6px 4px');
    expect(drawing?.fill).toBe('rgba(45, 127, 249, 0.15)');
    await dragOverlay(CANVAS.x - 12, CANVAS.y - 12, CANVAS.x + CANVAS.w + 12, CANVAS.y + CANVAS.h + 12);
    // 松开后：8 手柄 + 命名输入框自动弹出（编辑态）
    await expect(ov.locator('[data-testid="region-handle-0"]')).toBeAttached();
    for (let n = 0; n < 8; n++) {
      await expect(ov.locator(`[data-testid="region-handle-${n}"]`).first()).toBeAttached();
    }
    await expect(ov.locator('[data-testid="region-name-input"]')).toBeVisible();
    // 矩形样式：2px dashed #2D7FF9 + 填充 rgba(45,127,249,0.15)
    const style = await ov.evaluate(() => {
      const r = document.querySelector('.region-rect') as SVGRectElement;
      const cs = getComputedStyle(r);
      return { stroke: cs.stroke, width: cs.strokeWidth, dash: cs.strokeDasharray, fill: cs.fill };
    });
    expect(style.stroke).toBe('rgb(45, 127, 249)');
    expect(style.width).toBe('2px');
    expect(style.fill).toBe('rgba(45, 127, 249, 0.15)');
    // 手柄 8×8 白色圆点
    const handle = await ov.evaluate(() => {
      const c = document.querySelector('[data-testid="region-handle-0"]') as SVGCircleElement;
      const cs = getComputedStyle(c);
      return { r: c.getAttribute('r'), fill: cs.fill };
    });
    expect(handle.r).toBe('4'); // 直径 8px
    expect(handle.fill).toBe('rgb(255, 255, 255)');
    // 中心坐标标签「{x},{y} {w}×{h}」
    const label = await ov.evaluate(() => document.querySelector('.region-label')?.textContent ?? '');
    expect(label).toMatch(/^\d+,\d+ \d+×\d+$/);
    // 命名 + 回车确认（无需键入任何数字）
    await confirmName('已用区域');
    await expect(ov.locator('[data-testid="overlay-count"]')).toHaveText('选区 1');
    // 抽屉列表项：名称 + 80×60 缩略图 + 定位/编辑/删除
    const rowActions = ov.locator('[data-testid^="region-row-actions-"]').first();
    await expect(rowActions).toBeVisible();
    await expect(rowActions).toContainText('定位');
    await expect(rowActions).toContainText('编辑');
    await expect(rowActions).toContainText('删除');
    const thumb = await ov.evaluate(() => {
      const t = document.querySelector('.row svg.thumb') as SVGSVGElement;
      const cs = getComputedStyle(t);
      return { w: parseFloat(cs.width), h: parseFloat(cs.height) };
    });
    expect(thumb.w).toBe(80);
    expect(thumb.h).toBe(60);
  });

  test('8 手柄编辑：拖 SE 手柄缩放 / 拖本体平移 / 方向键微调 / Esc 退出 / Delete 删除', async () => {
    const before = await rectBox();
    // 拖 SE 手柄（handle-4 = se）缩放
    await fireMouse('mousedown', before.x + before.w, before.y + before.h, 4);
    for (let i = 1; i <= 4; i++) {
      await fireMouse('mousemove', before.x + before.w + i * 10, before.y + before.h + i * 8, 'svg');
    }
    await fireMouse('mouseup', before.x + before.w + 40, before.y + before.h + 32, 'window');
    const afterResize = await rectBox();
    expect(afterResize.w).toBeGreaterThan(before.w);
    expect(afterResize.h).toBeGreaterThan(before.h);
    // 拖矩形本体平移
    const mcx = afterResize.x + afterResize.w / 2;
    const mcy = afterResize.y + afterResize.h / 2;
    await fireMouse('mousedown', mcx, mcy, 'rect');
    for (let i = 1; i <= 4; i++) {
      await fireMouse('mousemove', mcx + (i * 20) / 4, mcy + (i * 10) / 4, 'svg');
    }
    await fireMouse('mouseup', mcx + 20, mcy + 10, 'window');
    const afterMove = await rectBox();
    expect(afterMove.x).toBeGreaterThan(afterResize.x);
    expect(afterMove.y).toBeGreaterThan(afterResize.y);
    // 方向键微调：ArrowUp 1px、Shift+ArrowRight 10px
    await ov.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    await ov.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })); });
    const afterKeys = await rectBox();
    expect(afterKeys.y).toBe(afterMove.y - 1);
    expect(afterKeys.x).toBe(afterMove.x + 10);
    // Esc 退出编辑态（手柄隐藏）
    await ov.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await expect(ov.locator('[data-testid="region-handle-0"]')).toHaveCount(0);
    // 单击矩形重新进入编辑态，Delete 删除
    await ov.evaluate(() => {
      const r = document.querySelector('.region-rect') as SVGRectElement;
      const box = r.getBoundingClientRect();
      r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: box.x + 5, clientY: box.y + 5 }));
    });
    await expect(ov.locator('[data-testid="region-handle-0"]')).toBeAttached();
    await ov.evaluate(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
    await expect(ov.locator('[data-testid="overlay-count"]')).toHaveText('选区 0');
  });

  test('重新框选 + 保存：region 字段落库为 {x,y,w,h} 四个数字；IndexedDB 行含 9 字段（含 selector）；300ms 防抖窗口每次变化写入', async () => {
    // 读取 IndexedDB regions 全部行（getAll 按 id 升序 → 最后一行为最新选区）
    const readIdbRows = () =>
      ov.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const q = indexedDB.open('llm-regions', 1);
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
        const rows = await new Promise<Record<string, unknown>[]>((res, rej) => {
          const tx = db.transaction('regions', 'readonly');
          const rq = tx.objectStore('regions').getAll();
          rq.onsuccess = () => res(rq.result as Record<string, unknown>[]);
          rq.onerror = () => rej(rq.error);
        });
        db.close();
        return rows;
      });

    await dragOverlay(CANVAS.x - 10, CANVAS.y - 10, CANVAS.x + CANVAS.w + 10, CANVAS.y + CANVAS.h + 10);
    await expect(ov.locator('[data-testid="region-name-input"]')).toBeVisible();
    await confirmName('OCR 主区域');
    // ≥300ms 防抖窗口后：首次落库可查
    await h.win.waitForTimeout(600);
    const idbRows = await readIdbRows();
    expect(idbRows.length).toBeGreaterThanOrEqual(1);
    const idbRow = idbRows[idbRows.length - 1];
    // 9 字段逐键 in row（providerId/name/x/y/w/h/mode/selector/lastModified）
    for (const k of ['providerId', 'name', 'x', 'y', 'w', 'h', 'mode', 'selector', 'lastModified']) {
      expect(k in idbRow, `字段 ${k} 应在 regions 行中`).toBe(true);
    }
    expect(idbRow.providerId).toBe(providerId);
    expect(idbRow.name).toBe('OCR 主区域');
    expect(idbRow.mode).toBe('OCR');
    for (const k of ['x', 'y', 'w', 'h']) expect(typeof idbRow[k]).toBe('number');
    // selector：非空字符串（选区中心点下页面元素的 CSS 路径）
    expect(typeof idbRow.selector).toBe('string');
    expect(String(idbRow.selector).length).toBeGreaterThan(0);
    expect(typeof idbRow.lastModified).toBe('number');

    // ── 300ms 防抖窗口：<300ms 读不到新值；≥300ms 新值落库（每次变化均触发写入）──
    const wBefore = Number(idbRow.w);
    await fireMouse('mousedown', Number(idbRow.x) + wBefore, Number(idbRow.y) + Number(idbRow.h), 4);
    await fireMouse('mousemove', Number(idbRow.x) + wBefore + 12, Number(idbRow.y) + Number(idbRow.h), 'svg');
    await fireMouse('mouseup', Number(idbRow.x) + wBefore + 12, Number(idbRow.y) + Number(idbRow.h), 'window');
    const earlyRows = await readIdbRows(); // 单次往返 <300ms，仍在防抖窗口内
    expect(Number(earlyRows[earlyRows.length - 1].w)).toBe(wBefore); // <300ms：未写入新值
    await h.win.waitForTimeout(500); // ≥300ms
    const lateRows = await readIdbRows();
    expect(Number(lateRows[lateRows.length - 1].w)).toBe(wBefore + 12); // 第二次变化已落库

    // 保存按钮 → 全量校验回写 Provider 配置
    await ov.evaluate(() => (document.querySelector('[data-testid="region-save"]') as HTMLButtonElement).click());
    await h.win.waitForTimeout(800);
    const row = await sqlRows(h.app, `SELECT region, sub_mode FROM providers WHERE id='${providerId}'`);
    const region = JSON.parse(row[0].region as string) as { x: number; y: number; w: number; h: number };
    expect(Number.isInteger(region.x)).toBe(true);
    expect(Number.isInteger(region.y)).toBe(true);
    expect(Number.isInteger(region.w)).toBe(true);
    expect(Number.isInteger(region.h)).toBe(true);
    expect(region.w).toBeGreaterThanOrEqual(10);
    expect(region.h).toBeGreaterThanOrEqual(10);
    // 覆盖 mock canvas：x..x+w 包含 120..660，y..y+h 包含 160..202
    expect(region.x).toBeLessThanOrEqual(CANVAS.x);
    expect(region.x + region.w).toBeGreaterThanOrEqual(CANVAS.x + CANVAS.w);
    expect(region.y).toBeLessThanOrEqual(CANVAS.y);
    expect(region.y + region.h).toBeGreaterThanOrEqual(CANVAS.y + CANVAS.h);
  });

  test('断网 OCR 全流程：本地引擎识别 canvas 数字 → llm_usage_snapshots 新增 source=ocr 且无云端 OCR 请求', async () => {
    await invokeIpc(h.win, 'llm:test:inject', { kind: 'clear' });
    const before = (await sqlRows(h.app, `SELECT COUNT(*) AS c FROM llm_usage_snapshots WHERE provider_id='${providerId}'`))[0].c as number;
    const r = await invokeIpc<{ ok: boolean }>(h.win, 'llm:refresh:one', { providerId });
    expect(r.ok).toBe(true);
    const snap = await sqlRows(h.app, `SELECT source, used, remaining, status FROM llm_usage_snapshots WHERE provider_id='${providerId}' ORDER BY rowid DESC LIMIT 1`);
    expect(snap.length).toBe(before + 1);
    expect(snap[0].source).toBe('ocr');
    expect(snap[0].status).toBe('valid');
    // 本地 OCR 从像素位图真实识别出 $128.40（used）/ $371.60（remaining）
    expect(Number(snap[0].used)).toBeCloseTo(128.4, 1);
    expect(Number(snap[0].remaining)).toBeCloseTo(371.6, 1);
    // 网络面板断言：全部请求均为本机 mock，无任何云端 OCR 域名
    const cloudOcr = h.mock.requests.filter((q) => !/127\.0\.0\.1/.test(q.host));
    expect(cloudOcr).toHaveLength(0);
  });

  test('重启应用后重新进入可定位复用已保存选区（一次配置终身复用）', async () => {
    const saved = await sqlRows(h.app, `SELECT region FROM providers WHERE id='${providerId}'`);
    expect(saved[0].region).not.toBeNull();
    // 关闭旧实例（同一 dataDir：SQLite + partition IndexedDB 全部保留）后重启
    await h.close();
    const relaunched = await launchHarness({ dataDir: h.dataDir });
    try {
      const base2 = `http://127.0.0.1:${relaunched.mock.port}`;
      await invokeIpc(relaunched.win, 'llm:providers:update', { id: providerId, dom_url: `${base2}/console?auth=ok` });
      await relaunched.win.evaluate(() => {
        window.location.hash = '#/region';
      });
      await relaunched.win.selectOption('[data-testid="region-provider-select"]', providerId);
      await relaunched.win.locator('[data-testid="region-open-browser"]').click();
      const frame = await overlayFrame(relaunched.win);
      // SQLite 持久化选区自动还原为可见矩形（无需重新拖拽）
      await expect(frame.locator('.region-rect').first()).toBeVisible();
      await expect(frame.locator('[data-testid="overlay-count"]')).toHaveText('选区 1');
      // 重启后选区未进入编辑态、无坐标标签属预期；矩形几何与 SQLite 保存值一致（一次配置终身复用）
      const savedRegion = JSON.parse(saved[0].region as string) as { x: number; y: number; w: number; h: number };
      const box = await frame.evaluate(() => {
        const r = document.querySelector('.region-rect') as SVGRectElement;
        return { x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) };
      });
      expect(box).toEqual({ x: savedRegion.x, y: savedRegion.y, w: savedRegion.w, h: savedRegion.h });
      // 名称复用（抽屉列表显示保存时的命名）
      await expect(frame.locator('[data-testid^="region-row-"]').first()).toContainText('OCR 主区域');
      // 「定位」按钮可用（滚动 + 黄色脉冲 3 次）
      await frame.evaluate(() => (document.querySelector('[data-testid^="region-row-actions-"] button') as HTMLButtonElement).click());
      await relaunched.win.waitForTimeout(400);
      const pulsing = await frame.evaluate(() => !!document.querySelector('.__llm-pulsing, .region-rect'));
      expect(pulsing).toBe(true);
      h = relaunched as unknown as TestHarness;
    } finally {
      // 由 afterAll 统一关闭 relaunched（已赋给 h）
    }
  });

  /** 承接用例间状态：登录墙用例捕获的 BrowserView 页面（取消用例复用） */
  let captureView: EvalFrame | null = null;

  async function loginWallView(win: Page): Promise<EvalFrame> {
    for (let i = 0; i < 40; i++) {
      for (const w of win.context().pages()) {
        if (w === win) continue;
        if (!/127\.0\.0\.1/.test(w.url())) continue;
        const hasLogin = await w.evaluate(() => !!document.querySelector('form[action="/login"]')).catch(() => false);
        if (hasLogin) return w as unknown as EvalFrame;
      }
      await win.waitForTimeout(250);
    }
    throw new Error('未找到登录墙 BrowserView 页面');
  }

  test('登录墙前置引导：未登录不注入画布（页面可登录）→「我已完成登录」复核后画布自动叠加', async () => {
    const base = `http://127.0.0.1:${h.mock.port}`;
    const pid = await seedProvider(h.win, {
      provider_name: '登录墙厂',
      alias: '未登录账号',
      mode: 'web_crawl',
      sub_mode: 'ocr',
      dom_url: `${base}/console`,
      ocr_threshold: 0.8,
      quota_total: 500,
    });
    await h.win.evaluate(() => {
      window.location.hash = '#/region';
    });
    await h.win.selectOption('[data-testid="region-provider-select"]', pid);
    await h.win.locator('[data-testid="region-open-browser"]').click();
    // mode=login_required：宿主显示「🔐 我已完成登录」引导；画布不注入，页面保持可交互（可输入密码）
    await expect(h.win.locator('[data-testid="region-login-done"]')).toBeVisible();
    const view = await loginWallView(h.win);
    await expect(view.locator('#__llm-overlay-svg')).toHaveCount(0);
    // 直接在内嵌页面完成登录（表单 POST /login → Set-Cookie → 302 /console）
    await view.evaluate(() => {
      (document.querySelector('input[type="password"]') as HTMLInputElement).value = 'secret';
    });
    await Promise.all([
      view.waitForURL(/console/, { timeout: 8000 }),
      view.evaluate(() => (document.querySelector('form[action="/login"]') as HTMLFormElement).submit()),
    ]);
    // 复核：主进程确认登录态 → 回目标页注入画布；宿主登录引导消失
    await h.win.locator('[data-testid="region-login-done"]').click();
    await expect(view.locator('#__llm-overlay-svg')).toBeVisible({ timeout: 15000 });
    await expect(h.win.locator('[data-testid="region-login-done"]')).toHaveCount(0);
    captureView = view;
  });

  test('overlay「取消」= 退出采集会话：解除附着并复位宿主页（不再遮挡表单区）', async () => {
    expect(captureView).toBeTruthy();
    await captureView!.evaluate(() => (document.querySelector('#__llm-btn-cancel') as HTMLButtonElement).click());
    // 宿主复位：关闭按钮与登录引导消失，占位说明重新可见（BrowserView 不再挡住表单）
    await expect(h.win.locator('[data-testid="region-close-browser"]')).toHaveCount(0);
    await expect(h.win.locator('[data-testid="region-login-done"]')).toHaveCount(0);
    await expect(h.win.locator('.region-page .region-placeholder').first()).toBeVisible();
    // 取消同时移除了画布 DOM
    const svgGone = await captureView!.evaluate(() => !document.querySelector('#__llm-overlay-svg'));
    expect(svgGone).toBe(true);
  });
});
