import type { DomSelector } from '../../shared/types';
import { CollectError } from './errors';

/**
 * DOM 提取：仅执行本地静态脚本片段读取页面文本，不注入任何远程脚本。
 * 安全约束（AC：无 eval / Function / <script> 注入痕迹；仅返回 textContent 文本）：
 *  - dom_script 必须为「表达式」，禁止 eval/new Function/document.write/<script>/import()
 *  - 结果统一走 JSON 序列化返回字符串
 */
const FORBIDDEN = [/\beval\s*\(/, /\bnew\s+Function\b/, /<script/i, /\bdocument\.write\b/, /\bimport\s*\(/, /\brequire\s*\(/];

export function assertDomScriptSafe(script: string): void {
  for (const re of FORBIDDEN) {
    if (re.test(script)) {
      throw new CollectError('parse_error', `dom_script 含被禁止的动态执行调用（${re}），仅允许静态表达式读取文本`);
    }
  }
}

/** 内置默认提取表达式：按 selectors 依次查找，返回 name=text 拼接文本 */
export function buildDefaultDomScript(selectors: DomSelector[]): string {
  const list = JSON.stringify(selectors.map((s) => ({ name: s.name, selector: s.selector })));
  return `(${extractByText.toString()})(${list})`;
}

// 注意：该函数会被 toString() 内联进页面执行，必须保持纯静态、无外部引用
function extractByText(pairs: { name: string; selector: string }[]): string {
  const parts: string[] = [];
  const missing: string[] = [];
  for (const p of pairs) {
    const el = document.querySelector(p.selector);
    if (el && el.textContent !== null) {
      parts.push(`${p.name}=${el.textContent.trim()}`);
    } else {
      missing.push(p.selector);
    }
  }
  if (!parts.length) {
    return `__DOM_MISS__:${missing.join(',')}`;
  }
  return parts.join(' | ');
}

export interface DomRunResult {
  text: string;
  missedSelectors: string[];
}

/** 在给定 webContents 上执行 dom_script，返回纯文本结果 */
export async function runDomScript(
  executeJs: (code: string) => Promise<unknown>,
  domScript: string,
): Promise<DomRunResult> {
  assertDomScriptSafe(domScript);
  const code = `(() => {
      let __v;
      try { __v = (${domScript}); } catch (__e) { return JSON.stringify({ __dom_error: String(__e && __e.message || __e) }); }
      return JSON.stringify({ text: __v === undefined || __v === null ? '' : String(__v) });
    })()`;
  const raw = (await executeJs(code)) as unknown;
  let parsed: { text?: string; __dom_error?: string } | null = null;
  try {
    parsed = JSON.parse(String(raw)) as { text?: string; __dom_error?: string };
  } catch {
    throw new CollectError('parse_error', 'DOM 提取返回无法解析');
  }
  if (parsed && parsed.__dom_error) {
    throw new CollectError('parse_error', `DOM 脚本执行错误：${parsed.__dom_error}`);
  }
  const text = parsed?.text ?? '';
  if (text.startsWith('__DOM_MISS__:')) {
    const missed = text.slice('__DOM_MISS__:'.length).split(',').filter(Boolean);
    return { text: '', missedSelectors: missed };
  }
  return { text, missedSelectors: [] };
}
