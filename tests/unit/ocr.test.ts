import { describe, expect, it } from 'vitest';
import { LocalPaddleLiteEngine, selectOcrEngine, type OcrImage } from '../../src/main/ocr/engine';
import { clampRegion, parseQuotaText, parseUsedRemaining } from '../../src/main/ocr/number-parser';
import { TEMPLATES } from '../../src/main/ocr/font-bitmaps';

/** 用内置 5×7 位图字体把文本渲染为 BGRA 位图（与 mock 控制台页面同源字形） */
export function renderDigitsToBitmap(text: string, scale = 6): OcrImage {
  const glyphs = [...text];
  const gw = 5;
  const gh = 7;
  const spacing = 1; // 字符间隔（位图列）
  const totalCols = glyphs.length * (gw + spacing) - spacing;
  const width = totalCols * scale;
  const height = gh * scale;
  const data = Buffer.alloc(width * height * 4, 0xff); // 白底 BGRA
  const setPx = (cx: number, cy: number): void => {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const x = cx * scale + dx;
        const y = cy * scale + dy;
        const i = (y * width + x) * 4;
        data[i] = 0x11;
        data[i + 1] = 0x18;
        data[i + 2] = 0x27;
        data[i + 3] = 0xff;
      }
    }
  };
  glyphs.forEach((ch, gi) => {
    const rows = TEMPLATES[ch];
    if (!rows) return;
    for (let ty = 0; ty < gh; ty++) {
      for (let tx = 0; tx < gw; tx++) {
        if (rows[ty][tx] === '1') setPx(gi * (gw + spacing) + tx, ty);
      }
    }
  });
  return { width, height, data };
}

describe('本地 OCR 引擎（AC：断网本地识别全流程；置信度阈值判定）', () => {
  const engine = new LocalPaddleLiteEngine();

  it('识别 "$128.40 / $371.60" 全串且高置信度', async () => {
    const img = renderDigitsToBitmap('$128.40/$371.60');
    const r = await engine.recognize(img);
    expect(r.text).toBe('$128.40/$371.60');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('识别纯数字 "¥42.50" 与 "0.00"', async () => {
    expect((await engine.recognize(renderDigitsToBitmap('42.50'))).text).toBe('42.50');
    expect((await engine.recognize(renderDigitsToBitmap('0.00'))).text).toBe('0.00');
  });

  it('selectOcrEngine 返回本地引擎（无外部请求）', async () => {
    const sel = await selectOcrEngine();
    expect(['local-paddle-lite', 'paddleocr-js']).toContain(sel.backend);
    expect(typeof sel.engine.recognize).toBe('function');
  });
});

describe('解析归一化器', () => {
  it('parseUsedRemaining：双值文本 → used/remaining', () => {
    expect(parseUsedRemaining('used=$128.40 | remaining=$371.60')).toEqual({ used: 128.4, remaining: 371.6 });
    expect(parseUsedRemaining('42.50')).toEqual({ used: 42.5, remaining: null });
    expect(parseUsedRemaining('没有数字')).toEqual({ used: null, remaining: null });
    expect(parseUsedRemaining('1,280.50 / 5,000.00')).toEqual({ used: 1280.5, remaining: 5000 });
  });

  it('parseQuotaText：千分位与中文逗号', () => {
    expect(parseQuotaText('余额 1，234.56 元').primary).toBe(1234.56);
    expect(parseQuotaText('剩余 42.50').numbers).toEqual([42.5]);
  });

  it('clampRegion：最小 10×10、视口夹紧（AC：选区过小/越界拒绝保存）', () => {
    expect(clampRegion({ x: 0, y: 0, w: 5, h: 5, viewportW: 800, viewportH: 600 })).toBeNull();
    expect(clampRegion({ x: 790, y: 10, w: 50, h: 50, viewportW: 800, viewportH: 600 })).toEqual({ x: 790, y: 10, w: 10, h: 50 });
    expect(clampRegion({ x: 10, y: 10, w: 100, h: 80, viewportW: 800, viewportH: 600 })).toEqual({ x: 10, y: 10, w: 100, h: 80 });
  });
});
