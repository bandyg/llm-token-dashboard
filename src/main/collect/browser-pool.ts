import { BrowserView, BrowserWindow, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

export const MAX_BROWSER_VIEWS = 30;

export class BrowserViewLimitError extends Error {
  constructor() {
    super('已达硬上限 30');
    this.name = 'BrowserViewLimitError';
  }
}

export interface PoolEntry {
  providerId: string;
  view: BrowserView;
  /** 当前是否附着在主窗口（区域选择器中部 / 采集截图时临时附着） */
  attached: boolean;
  webContentsId: number;
}

/**
 * BrowserView 池：
 *  - 每条 web_crawl 记录独立 partition（persist:prov-{id}）→ Cookie 与登录态按 provider 隔离并持久化；
 *  - 硬上限 30：超限抛 BrowserViewLimitError（AC：尝试创建第 31 个时弹窗「已达硬上限 30」并阻止）；
 *  - 登录弹窗窗口计入同一预算。
 */
export class BrowserViewPool {
  private entries = new Map<string, PoolEntry>();
  private loginWindows = new Map<string, BrowserWindow>();
  private pendingLoginResolvers = new Map<string, () => void>();

  constructor(
    private getParentWindow: () => BrowserWindow | null,
    private preloadPath: string,
    private onLoginWindowClosed?: (providerId: string) => void,
  ) {}

  get count(): number {
    return this.entries.size + this.loginWindows.size;
  }

  has(providerId: string): boolean {
    return this.entries.has(providerId);
  }

  get(providerId: string): PoolEntry | null {
    return this.entries.get(providerId) ?? null;
  }

  /** 所有驻留条目（性能判据用） */
  list(): PoolEntry[] {
    return [...this.entries.values()];
  }

  async ensureForProvider(providerId: string): Promise<PoolEntry> {
    const existing = this.entries.get(providerId);
    if (existing) return existing;
    if (this.count >= MAX_BROWSER_VIEWS) throw new BrowserViewLimitError();
    const ses = session.fromPartition(`persist:prov-${providerId}`);
    const view = new BrowserView({
      webPreferences: {
        partition: `persist:prov-${providerId}`,
        preload: fs.existsSync(this.preloadPath) ? this.preloadPath : undefined,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const entry: PoolEntry = { providerId, view, attached: false, webContentsId: view.webContents.id };
    this.entries.set(providerId, entry);
    return entry;
  }

  /** 区域选择器：附着到主窗口中部 */
  attach(providerId: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const entry = this.entries.get(providerId);
    const win = this.getParentWindow();
    if (!entry || !win) return;
    win.addBrowserView(entry.view);
    entry.view.setBounds(bounds);
    entry.attached = true;
  }

  detach(providerId: string): void {
    const entry = this.entries.get(providerId);
    const win = this.getParentWindow();
    if (!entry || !win) return;
    try {
      win.removeBrowserView(entry.view);
    } catch {
      // 未附着时忽略
    }
    entry.attached = false;
  }

  setBounds(providerId: string, bounds: { x: number; y: number; width: number; height: number }): void {
    const entry = this.entries.get(providerId);
    if (entry?.attached) entry.view.setBounds(bounds);
  }

  async navigate(providerId: string, url: string, timeoutMs = 20000): Promise<void> {
    const entry = this.entries.get(providerId);
    if (!entry) throw new Error('BrowserView 不存在');
    const wc = entry.view.webContents;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        // 超时但已加载出内容时容忍（部分站点持续加载资源）
        if (!wc.isLoading()) resolve();
        else reject(new Error('页面加载超时'));
      }, timeoutMs);
      const onDone = () => {
        cleanup();
        resolve();
      };
      const onFail = (_e: unknown, code: number, desc: string) => {
        cleanup();
        reject(new Error(`页面加载失败 (${code} ${desc})`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        wc.removeListener('did-finish-load', onDone);
        wc.removeListener('did-fail-load', onFail);
      };
      wc.on('did-finish-load', onDone);
      wc.on('did-fail-load', onFail);
      void wc.loadURL(url).catch(() => undefined);
    });
  }

  async executeJs(providerId: string, code: string): Promise<unknown> {
    const entry = this.entries.get(providerId);
    if (!entry) throw new Error('BrowserView 不存在');
    return entry.view.webContents.executeJavaScript(code, true);
  }

  /** 登录态检测（静态检测脚本） */
  async checkAuth(providerId: string, loginSelector: string | null): Promise<{ loginRequired: boolean; url: string }> {
    const { buildLoginDetectScript, parseLoginDetect } = await import('./login-detector');
    const raw = await this.executeJs(providerId, buildLoginDetectScript(loginSelector));
    const r = parseLoginDetect(raw);
    return { loginRequired: r.loginRequired, url: r.url };
  }

  /** 截图指定 CSS 像素区域（返回 BGRA 位图 + 物理尺寸） */
  async captureRegion(
    providerId: string,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<{ width: number; height: number; data: Buffer }> {
    const entry = this.entries.get(providerId);
    if (!entry) throw new Error('BrowserView 不存在');
    const img = await entry.view.webContents.capturePage({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    const size = img.getSize();
    return { width: size.width, height: size.height, data: Buffer.from(img.toBitmap()) };
  }

  /** 会话 Cookie 导出到加密存储（直接读 provider 专属 partition，登录窗口设置的 Cookie 也可导出） */
  async exportCookies(providerId: string, encrypt: (v: string) => string): Promise<{ name: string; domain?: string; valueEncrypted: string }[]> {
    const ses = session.fromPartition(`persist:prov-${providerId}`);
    const cookies = await ses.cookies.get({});
    return cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      valueEncrypted: encrypt(c.value),
    }));
  }

  webContentsIdOf(providerId: string): number | null {
    return this.entries.get(providerId)?.webContentsId ?? null;
  }

  /** 未登录弹窗（独立 BrowserWindow，计入 30 上限） */
  async openLoginWindow(
    providerId: string,
    url: string,
    onComplete: () => void,
  ): Promise<number> {
    const existing = this.loginWindows.get(providerId);
    if (existing) {
      existing.focus();
      return existing.webContents.id;
    }
    if (this.count >= MAX_BROWSER_VIEWS) throw new BrowserViewLimitError();
    const win = new BrowserWindow({
      width: 960,
      height: 720,
      title: '请在该窗口中完成登录，完成后关闭',
      webPreferences: {
        partition: `persist:prov-${providerId}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.loginWindows.set(providerId, win);
    win.on('closed', () => {
      this.loginWindows.delete(providerId);
      this.onLoginWindowClosed?.(providerId);
      const resolver = this.pendingLoginResolvers.get(providerId);
      if (resolver) {
        this.pendingLoginResolvers.delete(providerId);
        resolver();
      }
    });
    await win.loadURL(url);
    return win.webContents.id;
  }

  /** 等待登录窗口关闭（复用会话，不重复创建） */
  waitForLoginWindow(providerId: string, timeoutMs = 300000): Promise<void> {
    if (!this.loginWindows.has(providerId)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      this.pendingLoginResolvers.set(providerId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(providerId: string): void {
    const entry = this.entries.get(providerId);
    if (entry) {
      this.detach(providerId);
      try {
        entry.view.webContents.stop();
      } catch {
        // ignore
      }
      this.entries.delete(providerId);
    }
    const lw = this.loginWindows.get(providerId);
    if (lw && !lw.isDestroyed()) lw.close();
  }

  destroyAll(): void {
    for (const id of [...this.entries.keys()]) this.destroy(id);
  }

  static partitionFor(providerId: string): string {
    return `persist:prov-${providerId}`;
  }
}

export function defaultPreloadPath(appPath: string): string {
  return path.join(appPath, 'dist', 'preload', 'region-bridge.js');
}
