import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/types';

/**
 * 采集 BrowserView（区域选择器 overlay 宿主页面）的 preload。
 * 仅暴露极小的 llm:region:* 白名单子集，overlay 通过它把选区回写主进程。
 */
const allowed: ReadonlySet<string> = new Set<string>([
  IPC.regionSave,
  IPC.regionList,
  IPC.regionRecheck,
  IPC.regionExit,
  IPC.systemInfo,
]);

contextBridge.exposeInMainWorld('__LLM_REGION_BRIDGE__', {
  invoke: (channel: string, payload?: unknown): Promise<{ code: number | string; data?: unknown; message?: string }> => {
    if (!allowed.has(channel)) {
      return Promise.resolve({ code: 'FORBIDDEN_CHANNEL', message: `IPC 白名单拒绝: ${channel}` });
    }
    return ipcRenderer.invoke(channel, payload);
  },
});
