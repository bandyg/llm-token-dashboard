import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';

/**
 * 主窗口 preload：仅暴露 llm.invoke 白名单通道与事件订阅。
 * 渲染进程 bundle 不含 sqlite3 / BrowserView / paddleocr 任何直接调用痕迹。
 */
const allowed: ReadonlySet<string> = new Set<string>(Object.values(IPC) as readonly string[]);

const bridge = {
  invoke: (channel: string, payload?: unknown): Promise<{ code: number | string; data?: unknown; message?: string }> => {
    if (!allowed.has(channel)) {
      return Promise.resolve({ code: 'FORBIDDEN_CHANNEL', message: `IPC 白名单拒绝: ${channel}` });
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onEvent: (listener: (payload: unknown) => void): (() => void) => {
    const wrapped = (_e: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on('llm:event', wrapped);
    return () => ipcRenderer.removeListener('llm:event', wrapped);
  },
};

contextBridge.exposeInMainWorld('llm', bridge);

export type LlmBridge = typeof bridge;
