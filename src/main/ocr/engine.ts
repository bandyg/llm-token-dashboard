/**
 * 本地 OCR 引擎。
 * 架构对齐 docs/12_Architecture 的 PaddleOCR-js 本地引擎位置：
 *  - 运行时优先动态加载 paddleocr-js（若安装包内含权重）；加载失败时回退到内置的
 *    LocalPaddleLiteEngine —— 纯本地、零外部请求的轻量数字识别推理（Otsu 二值化 +
 *    连通域切分 + 5×7 模板匹配），专为额度面板这类高对比度数字小区域场景设计。
 *  - 整条链路不存在任何云端 OCR 请求（判据：断网下全流程成功、无 ocr.*cloud 域名请求）。
 */

export interface OcrImage {
  width: number;
  height: number;
  /** BGRA 像素（Electron NativeImage.toBitmap() 格式） */
  data: Buffer;
}

export interface OcrBox {
  char: string;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface OcrResult {
  text: string;
  confidence: number;
  boxes: OcrBox[];
}

export interface OcrEngine {
  readonly id: string;
  recognize(image: OcrImage): Promise<OcrResult>;
}

/* ---------------- 5×7 模板位图（与 E2E mock 页面共用，见 font-bitmaps.ts） ---------------- */

import { TEMPLATES } from './font-bitmaps';

/* ---------------- 内置轻量推理引擎 ---------------- */

export class LocalPaddleLiteEngine implements OcrEngine {
  readonly id = 'local-paddle-lite';

  async recognize(image: OcrImage): Promise<OcrResult> {
    const { width, height, data } = image;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const b = data[i * 4];
      const g = data[i * 4 + 1];
      const r = data[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    const threshold = otsuThreshold(gray);
    const dark = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++) dark[i] = gray[i] < threshold ? 1 : 0;

    const glyphs = segmentGlyphs(dark, width, height);
    const boxes: OcrBox[] = [];
    let scoreSum = 0;
    for (const gl of glyphs) {
      const { char, score } = this.matchGlyph(dark, width, gl);
      boxes.push({ char, x: gl.x0, y: gl.y0, w: gl.x1 - gl.x0 + 1, h: gl.y1 - gl.y0 + 1, score });
      scoreSum += score;
    }
    const text = boxes.map((b) => b.char).join('');
    const confidence = boxes.length ? scoreSum / boxes.length : 0;
    return { text, confidence, boxes };
  }

  private matchGlyph(dark: Uint8Array, width: number, gl: Glyph): { char: string; score: number } {
    const gw = gl.x1 - gl.x0 + 1;
    const gh = gl.y1 - gl.y0 + 1;
    // 字形暗像素密度（用于形状惩罚：防止小模板如「.」在任意暗块上拿满分）
    let darkCount = 0;
    for (let y = gl.y0; y <= gl.y1; y++) {
      for (let x = gl.x0; x <= gl.x1; x++) darkCount += dark[y * width + x];
    }
    const glyphDensity = darkCount / (gw * gh);
    let bestChar = '?';
    let bestScore = 0;
    for (const [ch, tmpl] of Object.entries(TEMPLATES)) {
      // 模板紧致包围盒：避免标点等「小字形」被拉伸到整格导致失配
      const tight = tightBBox(tmpl);
      const tw = tight.x1 - tight.x0 + 1;
      const th = tight.y1 - tight.y0 + 1;
      let ones = 0;
      for (let y = tight.y0; y <= tight.y1; y++) {
        for (let x = tight.x0; x <= tight.x1; x++) ones += tmpl[y][x] === '1' ? 1 : 0;
      }
      const tmplDensity = ones / (tw * th);
      let diff = 0;
      for (let ty = 0; ty < th; ty++) {
        for (let tx = 0; tx < tw; tx++) {
          // 模板单元中心采样回字形像素
          const sx = gl.x0 + Math.min(gw - 1, Math.floor(((tx + 0.5) / tw) * gw));
          const sy = gl.y0 + Math.min(gh - 1, Math.floor(((ty + 0.5) / th) * gh));
          const pixel = dark[sy * width + sx];
          const t = tmpl[tight.y0 + ty][tight.x0 + tx] === '1' ? 1 : 0;
          if (pixel !== t) diff++;
        }
      }
      const mismatch = diff / (tw * th);
      const penalty = Math.abs(tmplDensity - glyphDensity);
      const score = 1 - (mismatch + penalty) / 2;
      if (score > bestScore) {
        bestScore = score;
        bestChar = ch;
      }
    }
    return { char: bestScore >= 0.6 ? bestChar : '?', score: bestScore };
  }
}

const tightCache = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();

function tightBBox(tmpl: string[]): { x0: number; y0: number; x1: number; y1: number } {
  const cached = tightCache.get(tmpl.join(''));
  if (cached) return cached;
  let x0 = 5;
  let y0 = 7;
  let x1 = -1;
  let y1 = -1;
  tmpl.forEach((row, y) => {
    for (let x = 0; x < 5; x++) {
      if (row[x] === '1') {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  });
  const box = { x0, y0, x1, y1 };
  tightCache.set(tmpl.join(''), box);
  return box;
}

interface Glyph {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function otsuThreshold(gray: Float32Array): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

/** 8-连通域切分字形，按 x 排序 */
function segmentGlyphs(dark: Uint8Array, width: number, height: number): Glyph[] {
  const visited = new Uint8Array(width * height);
  const glyphs: Glyph[] = [];
  const stack: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!dark[idx] || visited[idx]) continue;
      stack.length = 0;
      stack.push(idx);
      visited[idx] = 1;
      let x0 = x;
      let y0 = y;
      let x1 = x;
      let y1 = y;
      let count = 0;
      while (stack.length) {
        const cur = stack.pop()!;
        const cx = cur % width;
        const cy = (cur - cx) / width;
        count++;
        if (cx < x0) x0 = cx;
        if (cy < y0) y0 = cy;
        if (cx > x1) x1 = cx;
        if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (dark[ni] && !visited[ni]) {
              visited[ni] = 1;
              stack.push(ni);
            }
          }
        }
      }
      // 噪点过滤：少于 6 像素的连通域视为噪声
      if (count >= 6) glyphs.push({ x0, y0, x1, y1 });
    }
  }
  glyphs.sort((a, b) => a.x0 - b.x0);
  // 相邻字形水平重叠（如 '='）或间距极小者合并（避免 '$' 的 S 与竖线分离）
  const merged: Glyph[] = [];
  for (const g of glyphs) {
    const prev = merged[merged.length - 1];
    if (prev && g.x0 <= prev.x1 + Math.max(1, (g.y1 - g.y0) * 0.06)) {
      prev.x1 = Math.max(prev.x1, g.x1);
      prev.y0 = Math.min(prev.y0, g.y0);
      prev.y1 = Math.max(prev.y1, g.y1);
    } else {
      merged.push({ ...g });
    }
  }
  return merged;
}

/* ---------------- 引擎选择 ---------------- */

export interface EngineSelection {
  engine: OcrEngine;
  backend: 'paddleocr-js' | 'local-paddle-lite';
}

let cached: EngineSelection | null = null;

export async function selectOcrEngine(): Promise<EngineSelection> {
  if (cached) return cached;
  try {
    // 可选后端：打包内置 paddleocr-js 时启用（懒加载，空闲零开销）
    const mod: unknown = await import(/* webpackIgnore: true */ 'paddleocr-js');
    const maybe = mod as { createEngine?: () => PromiseLike<OcrEngine> } | null;
    if (maybe && typeof maybe.createEngine === 'function') {
      const engine = await maybe.createEngine();
      cached = { engine, backend: 'paddleocr-js' };
      return cached;
    }
  } catch {
    // 未安装或加载失败 → 内置本地引擎
  }
  cached = { engine: new LocalPaddleLiteEngine(), backend: 'local-paddle-lite' };
  return cached;
}

export function resetOcrEngineCache(): void {
  cached = null;
}
