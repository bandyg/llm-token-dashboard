import { describe, expect, it } from 'vitest';
import { isAllowedChannel } from '../../src/main/ipc';
import { IPC } from '../../src/shared/types';

describe('IPC 白名单（AC：所有 DB/BrowserView/OCR 调用经 ipcRenderer.invoke("llm:*") 白名单校验）', () => {
  it('白名单内的 llm:* 通道被允许', () => {
    for (const ch of Object.values(IPC)) {
      expect(isAllowedChannel(ch)).toBe(true);
    }
  });

  it('非 llm: 前缀 / 未知通道被拒绝', () => {
    expect(isAllowedChannel('db:query')).toBe(false);
    expect(isAllowedChannel('llm:not-in-whitelist')).toBe(false);
    expect(isAllowedChannel('sqlite3:exec')).toBe(false);
    expect(isAllowedChannel(42 as unknown as string)).toBe(false);
    expect(isAllowedChannel(undefined)).toBe(false);
  });

  it('全部通道以 llm: 开头（命名约定）', () => {
    for (const ch of Object.values(IPC)) {
      expect(ch.startsWith('llm:')).toBe(true);
    }
  });
});
