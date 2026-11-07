/**
 * 解析归一化器：从 OCR/DOM 原始文本抽取额度数字。
 */
export interface ParsedQuota {
  numbers: number[];
  /** 主数字（第一个可解析值） */
  primary: number | null;
}

export function parseQuotaText(raw: string): ParsedQuota {
  if (!raw) return { numbers: [], primary: null };
  const cleaned = raw.replace(/[，]/g, ',').replace(/\s+/g, ' ');
  const matches = cleaned.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  const numbers = matches
    .map((m) => Number(m.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
  return { numbers, primary: numbers.length ? numbers[0] : null };
}

/** 从「已用 / 剩余」双值文本（如 "$12.34 / $37.66"）抽取 used 与 remaining */
export function parseUsedRemaining(raw: string): { used: number | null; remaining: number | null } {
  const { numbers } = parseQuotaText(raw);
  if (numbers.length >= 2) return { used: numbers[0], remaining: numbers[1] };
  if (numbers.length === 1) return { used: numbers[0], remaining: null };
  return { used: null, remaining: null };
}

export function clampRegion(v: {
  x: number;
  y: number;
  w: number;
  h: number;
  viewportW: number;
  viewportH: number;
}): { x: number; y: number; w: number; h: number } | null {
  const w = Math.max(0, Math.min(v.w, v.viewportW - v.x));
  const h = Math.max(0, Math.min(v.h, v.viewportH - v.y));
  if (w < 10 || h < 10) return null; // 最小选区 10×10
  return { x: Math.round(Math.max(0, v.x)), y: Math.round(Math.max(0, v.y)), w: Math.round(w), h: Math.round(h) };
}
