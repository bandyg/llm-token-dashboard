import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC, ProviderConfig } from '../shared/types';
import type { AppService } from './service';

/**
 * IPC 白名单：渲染进程只允许 invoke 命中本表的 llm:* 通道（AC：全部 DB/BrowserView/OCR
 * 操作经 ipcRenderer.invoke('llm:*') 主进程白名单校验）。
 */
const WHITELIST: ReadonlySet<string> = new Set<string>(Object.values(IPC) as readonly string[]);

/** 区域选择器 overlay（跑在采集 BrowserView 的 prov-* 分区里）允许的通道子集 */
const OVERLAY_ALLOWED: ReadonlySet<string> = new Set<string>([
  IPC.regionSave,
  IPC.regionList,
  IPC.regionRecheck,
  IPC.regionExit,
  IPC.systemInfo,
]);

export function isAllowedChannel(channel: unknown): boolean {
  return typeof channel === 'string' && channel.startsWith('llm:') && WHITELIST.has(channel);
}

function senderPartition(event: IpcMainInvokeEvent): string {
  try {
    return (event.sender.session as { storagePath?: string; isPersistent(): boolean })?.storagePath ?? '';
  } catch {
    return '';
  }
}

type Handler = (payload: unknown, event: IpcMainInvokeEvent) => unknown | Promise<unknown>;

export function registerIpcHandlers(service: AppService): void {
  const handlers: Record<string, Handler> = {
    [IPC.systemInfo]: () => ({
      version: '1.0.0',
      electron: process.versions.electron,
      dataDir: service.dataDir,
      appPath: service.appPath,
      maxBrowserViews: 30,
    }),

    [IPC.providersList]: () => service.listProviders(),
    [IPC.providersGet]: (p) => service.getProvider((p as { id: string }).id),
    [IPC.providersCreate]: (p) => service.createProvider(p as Parameters<AppService['createProvider']>[0]),
    [IPC.providersUpdate]: (p) => {
      const { id, ...patch } = p as { id: string } & Record<string, unknown>;
      return service.updateProvider(id, patch as Partial<ProviderConfig>);
    },
    [IPC.providersDelete]: (p) => service.deleteProvider((p as { id: string }).id),
    [IPC.providersSetEnabled]: (p) => {
      const { id, enabled } = p as { id: string; enabled: boolean };
      return service.setProviderEnabled(id, enabled);
    },

    [IPC.dashboardUsage]: () => service.dashboardUsage(),
    [IPC.refreshOne]: (p) => service.refreshOne((p as { providerId: string }).providerId, (p as { force?: boolean }) ?? {}),
    [IPC.refreshBatch]: (p) => {
      const { scope = 'all', ids = [] } = (p ?? {}) as { scope?: 'all' | 'failed' | 'selected'; ids?: string[] };
      return service.refreshByScope(scope, ids);
    },
    [IPC.snapshotsHistory]: (p) => service.trend(p as Parameters<AppService['trend']>[0]),
    [IPC.snapshotsList]: (p) => service.listSnapshots((p ?? {}) as Parameters<AppService['listSnapshots']>[0]),
    [IPC.manualEntry]: (p) => {
      const { providerId, ...rest } = p as { providerId: string } & Parameters<AppService['manualEntry']>[1];
      return service.manualEntry(providerId, rest);
    },

    [IPC.credentialsTest]: (p) => service.testCredential(p as Parameters<AppService['testCredential']>[0]),
    [IPC.credentialsSet]: (p) => {
      const { providerId, apiKey } = p as { providerId: string; apiKey: string };
      service.setCredential(providerId, apiKey);
      return { ok: true };
    },

    [IPC.regionSave]: (p) => {
      const { providerId, regions } = p as { providerId: string; regions: Parameters<AppService['saveRegions']>[1] };
      return service.saveRegions(providerId, regions ?? []);
    },
    [IPC.regionList]: (p) => service.listRegions((p as { providerId: string }).providerId),
    [IPC.regionRecheck]: (p) => service.regionRecheck((p as { providerId: string }).providerId),
    [IPC.regionExit]: (p) => {
      service.closeRegionBrowser((p as { providerId: string }).providerId);
      return { ok: true };
    },

    [IPC.browserOpen]: (p) =>
      service.openRegionBrowser(
        (p as { providerId: string }).providerId,
        (p as { sidebarWidth?: number }).sidebarWidth,
      ),
    [IPC.browserResize]: (p) => service.resizeRegionBrowser((p as { providerId: string }).providerId, (p as { bounds: { x: number; y: number; width: number; height: number } }).bounds),
    [IPC.browserClose]: (p) => service.closeRegionBrowser((p as { providerId: string }).providerId),
    [IPC.browserCheckAuth]: (p) => service.checkAuth((p as { providerId: string }).providerId),
    [IPC.browserOpenLogin]: (p) => service.openLogin((p as { providerId: string }).providerId),
    [IPC.loginComplete]: (p) => service.completeLogin((p as { providerId: string }).providerId),

    [IPC.ocrRun]: (p) => service.runOcr((p as { providerId: string }).providerId),

    [IPC.settingsGet]: () => service.getSettings(),
    [IPC.settingsSet]: (p) => service.setSettings(p as Parameters<AppService['setSettings']>[0]),

    [IPC.alertsRulesList]: () => service.listAlertRules(),
    [IPC.alertsRuleSave]: (p) => service.saveAlertRule(p as Parameters<AppService['saveAlertRule']>[0]),
    [IPC.alertsRuleDelete]: (p) => {
      service.deleteAlertRule((p as { id: string }).id);
      return { ok: true };
    },
    [IPC.alertsEventsList]: (p) => service.listAlertEvents((p as { limit?: number })?.limit ?? 30),
    [IPC.alertsEventsAck]: (p) => {
      service.ackAlertEvent((p as { id: string }).id);
      return { ok: true };
    },
    [IPC.alertsChannelSet]: (p) => {
      const { type, enabled } = p as { type: string; enabled: boolean };
      service.setAlertChannel(type, enabled);
      return { ok: true };
    },
    [IPC.alertsChannelTest]: (p) => service.testAlertChannel((p as { type: string }).type),

    [IPC.collectStatus]: () => service.collectStatus(),
    [IPC.historyExport]: (p) => service.historyExport((p as { format?: 'csv' | 'json' }).format ?? 'csv'),
    [IPC.configExport]: () => service.configExport(),
    [IPC.configImport]: (p) => service.configImport((p as { json: string }).json),
    [IPC.cacheClear]: () => service.clearCache(),

    [IPC.testSql]: (p) => service.testSql((p as { sql: string }).sql, (p as { params?: unknown[] }).params ?? []),
    [IPC.testInject]: (p) => {
      const { kind, value } = p as { kind: string; value?: unknown };
      service.testInject(kind, value);
      return { ok: true };
    },
    [IPC.fpsProbe]: (p) => service.fpsProbe((p as { count: number }).count, (p as { sampleMs?: number }).sampleMs ?? 2000),
    [IPC.browserViewCount]: () => service.browserViewCount(),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    if (!isAllowedChannel(channel)) {
      throw new Error(`IPC 通道不在白名单内: ${channel}`);
    }
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
      // 发送方校验：主窗口（renderer 会话）或区域 overlay（prov-* 分区，仅限 overlay 白名单子集）
      const partition = senderPartition(event);
      const isOverlaySender = /prov-/.test(partition);
      if (isOverlaySender && !OVERLAY_ALLOWED.has(channel)) {
        throw new Error(`IPC 白名单拒绝：overlay 会话不允许调用 ${channel}`);
      }
      try {
        return { code: 0, data: await handler(payload, event) };
      } catch (e) {
        return { code: (e as Error & { code?: string }).code ?? 'ERROR', message: (e as Error).message };
      }
    });
  }

  // 未注册通道统一拒绝（防御渲染层越权调用）
  ipcMain.handle('llm:unknown', () => {
    throw new Error('IPC 白名单拒绝');
  });
}

/** 推送事件到主窗口 */
export function broadcastToWindow(payload: unknown): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win) {
    win.webContents.send('llm:event', payload);
  }
}

export function safeUnregisterAll(): void {
  for (const ch of Object.values(IPC) as readonly string[]) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      // ignore
    }
  }
}
