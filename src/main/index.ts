import { app, BrowserWindow, Menu, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AppService, defaultDataDir } from './service';
import { registerIpcHandlers, broadcastToWindow } from './ipc';
import { LocalApiServer } from './rest-server';
import { runLogger } from './logger';
import { NetAudit } from './net-audit';
import { AlertEvent } from '../shared/types';
import { isReturnFromBackground } from './window-focus';

let mainWindow: BrowserWindow | null = null;
let service: AppService | null = null;
let apiServer: LocalApiServer | null = null;
let netAudit: NetAudit | null = null;

// Windows 任务栏归属 + 系统通知身份（不用 Electron 默认 AUMID）
app.setAppUserModelId('com.llmtoken.dashboard');

// 应用图标（resources/icon.ico，多尺寸 PNG 打包；缺失时回落 Electron 默认图标）
// 开发态：app.getAppPath() = 项目根；打包态：extraResources 落在 process.resourcesPath/resources/
function resolveIconPath(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'icon.ico'),
    path.join(process.resourcesPath, 'resources', 'icon.ico'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return undefined;
}

// 单实例锁（测试模式下允许多实例并行，供 E2E 双开等场景）
const gotLock = process.env.LLMDASH_TEST === '1' ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// 隔离测试数据目录（e2e 用 LLMDASH_DATA_DIR 指向临时目录）
if (process.env.LLMDASH_DATA_DIR) {
  const userDataPath = path.join(process.env.LLMDASH_DATA_DIR, 'electron-user-data');
  fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
}

// 关闭硬件加速相关问题的兜底：保持默认，仅关闭 Chromium 后台节流
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// 安全判据（抓包无非 provider 域名出站）：关闭 Chromium 自身的后台网络（组件更新/指标/域可靠性等），
// 应用出站只剩「provider 官方域名 + 本机回环」两类的真实采集流量
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-features', 'OptimizationHints,MediaRouter,Translate,ChromeWhatsNewUI');

function createMainWindow(): void {
  // 仪表工具不需要 File/Edit/View 菜单，去掉 Electron 默认应用菜单
  Menu.setApplicationMenu(null);
  const icon = resolveIconPath();
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'LLM 额度监控台',
    backgroundColor: '#F9FAFB',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/main.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  // 菜单移除后默认的 DevTools 加速键（F12/Ctrl+Shift+I）随之失效，补一个 F12 切换
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools();
    }
  });
  bindAutoRefreshOnShow(mainWindow);

  const devUrl = process.env.LLMDASH_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 窗口呼出时自动全量刷新。
 * - 走 refreshByScope('all')，内部已过滤「禁用 / 仅手动录入」的 provider
 * - 并发去重：刷新进行中时再次触发直接跳过，避免与用户手动刷新叠加
 * - 失败只记日志，不弹窗打扰（窗口刚打开就报错会让人困惑）
 *
 * 最小间隔 10s：窗口事件（restore/show/focus）在一次「点击任务栏」里常成簇触发，
 * 不去重会在同一次点击里连打多次厂商接口触发风控；10s 足以合并抖动，
 * 又能让「切走几分钟再切回」这种真实场景正常刷新（编排器本身还有 min_refresh_seconds 60s 节流兜底）。
 */
const AUTO_REFRESH_MIN_GAP_MS = 10_000;
let autoRefreshInFlight = false;
let lastAutoRefreshAt = 0;

async function refreshAllOnShow(reason: string): Promise<void> {
  if (!service) return;
  // e2e 静置审计逃生口：静置期「零出站」断言必须排除窗口事件驱动的采集（产品特性），
  // 否则测试桌面上的杂散 show/focus 事件会在 60s 空窗内触发合法全量采集造成误报。
  // 置位后，静置窗内任何出站请求只能来自调度器/定时器 = 真违规（由测试进程经 evalService 设置）。
  if (process.env.LLMDASH_DISABLE_AUTO_REFRESH === '1') return;
  if (autoRefreshInFlight) return;
  // 冷启动（lastAutoRefreshAt=0）不受间隔限制；此后同一次呼出内的重复事件跳过
  if (lastAutoRefreshAt && Date.now() - lastAutoRefreshAt < AUTO_REFRESH_MIN_GAP_MS) return;
  autoRefreshInFlight = true;
  lastAutoRefreshAt = Date.now();
  try {
    const results = await service.refreshByScope('all');
    const failed = results.filter((r) => !r.ok && !r.skipped);
    runLogger.log(
      'app',
      `窗口呼出自动刷新（${reason}）：${results.length} 个 provider，成功 ${results.length - failed.length}，失败 ${failed.length}`,
    );
  } catch (e) {
    runLogger.log('app', `窗口呼出自动刷新失败（忽略）：${(e as Error).message}`);
  } finally {
    autoRefreshInFlight = false;
    broadcastToWindow({ type: 'refresh-finished', results: [] });
  }
}

/**
 * 绑定窗口「被呼出」的所有路径。
 *
 * 关键：Alt+Tab 从别的应用切回来时，窗口始终是可见的（未最小化、未隐藏），
 * show / restore 都不会触发，只有 focus 会。必须覆盖 focus，
 * 否则「切到应用」这个最常见场景不会刷新。
 * focus 用 blur/focus 配对 + 时间阈值来过滤窗口内误点（判定见 window-focus.ts，含单测）。
 */
function bindAutoRefreshOnShow(win: BrowserWindow): void {
  let blurredAt = 0;
  win.once('ready-to-show', () => {
    win.show();
    void refreshAllOnShow('冷启动');
  });
  win.on('restore', () => void refreshAllOnShow('取消最小化'));
  win.on('show', () => {
    if (win.isVisible()) void refreshAllOnShow('窗口显示');
  });
  win.on('blur', () => {
    blurredAt = Date.now();
  });
  win.on('focus', () => {
    const now = Date.now();
    if (!isReturnFromBackground(blurredAt, now)) {
      // 未达标也清空，避免同一段离开时间被后续 focus 复用
      blurredAt = 0;
      return;
    }
    blurredAt = 0;
    void refreshAllOnShow('从后台切回');
  });
}

async function boot(): Promise<void> {
  service = new AppService(defaultDataDir(), app.getAppPath());
  // 网络审计（安全判据：抓包无指向非 provider 官方域名的上传请求）：
  // 必须在创建任何窗口/发起任何请求前挂上 Chromium webRequest + 主进程 fetch 两面钩子
  netAudit = new NetAudit();
  netAudit.start(service.dataDir);
  netAudit.installChromiumHook(app);
  netAudit.installFetchHook();
  service.netAudit = netAudit;
  if (process.env.LLMDASH_TEST === '1') {
    // E2E：在主进程 global 暴露服务实例（仅测试模式），供 app.evaluate 驱动与 SQL 取证
    (globalThis as unknown as { __llmService?: AppService }).__llmService = service;
  }
  service.onBroadcast((payload) => {
    broadcastToWindow(payload);
    if ((payload as { type?: string }).type === 'alert-triggered') {
      const e = (payload as { event: AlertEvent }).event;
      if (service?.alerts.getChannel('system')?.enabled && Notification.isSupported()) {
        new Notification({ title: '额度告警', body: e.message }).show();
      }
    }
  });
  registerIpcHandlers(service);
  createMainWindow();

  // 本地 REST 面（14_API_Spec）——失败不阻塞主流程
  apiServer = new LocalApiServer(service, Number(process.env.LLMDASH_API_PORT || 47321));
  try {
    await apiServer.start();
    runLogger.log('app', `REST 服务就绪 ${apiServer.address}`);
  } catch (e) {
    runLogger.log('app', `REST 服务启动失败（忽略）：${(e as Error).message}`);
  }
}

app.whenReady().then(() => {
  void boot();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    // 已在运行时的二次唤起同样刷新（restore/show 事件在部分平台不触发，显式补一次）
    void refreshAllOnShow('二次唤起');
  }
});

app.on('window-all-closed', () => {
  // 桌面应用：关窗即退出
  app.quit();
});

app.on('before-quit', () => {
  try {
    service?.close();
    void apiServer?.stop();
    netAudit?.stop();
  } catch {
    // ignore
  }
});
