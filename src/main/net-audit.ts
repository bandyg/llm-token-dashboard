/**
 * 网络审计（安全判据：抓包监控全程无指向非 provider 官方域名的上传请求）。
 * 两条捕获面：
 *  - Chromium 面：app 'web-contents-created' → session.webRequest.onBeforeRequest，
 *    覆盖主窗口/采集 BrowserView/登录窗口的所有页面网络请求；
 *  - Node 面：包装 globalThis.fetch（API 适配器在主进程经 undici 直连厂商，
 *    webRequest 不可见，必须钩 fetch 才能覆盖「抓包」全集）。
 * 记录仅写入本地内存环形缓冲 + dataDir/logs/net-audit.jsonl，永不出站。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface NetAuditEntry {
  at: string;
  /** 捕获面：chromium（webRequest）| node-fetch（主进程适配器） */
  face: 'chromium' | 'node-fetch';
  method: string;
  url: string;
  host: string;
  resourceType?: string;
  /** 上传语义：POST / PUT / PATCH */
  isUpload: boolean;
}

const UPLOAD_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const MAX_BUFFER = 20000;

interface WebRequestSession {
  webRequest: {
    onBeforeRequest(filter: unknown, listener: (details: { method: string; url: string; resourceType: string }, callback: (r: unknown) => void) => void): void;
  };
}

export class NetAudit {
  private entries: NetAuditEntry[] = [];
  private stream: fs.WriteStream | null = null;
  private fetchPatched = false;
  private originalFetch: typeof fetch | null = null;
  private hookedSessions = new WeakSet<object>();

  /** 启动：打开本地落盘文件（调用方负责在 app ready 后、创建窗口前调用） */
  start(dataDir: string): void {
    if (this.stream) return;
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    this.stream = fs.createWriteStream(path.join(dir, 'net-audit.jsonl'), { flags: 'a' });
  }

  stop(): void {
    this.stream?.end();
    this.stream = null;
  }

  /** Chromium 面：所有 webContents 的 session 挂 webRequest 监听（同 session 只挂一次） */
  installChromiumHook(app: { on(event: string, listener: (e: unknown, wc: { session: WebRequestSession }) => void): void }): void {
    app.on('web-contents-created', (_e: unknown, wc: { session: WebRequestSession }) => {
      const ses = wc?.session;
      if (!ses || this.hookedSessions.has(ses)) return;
      this.hookedSessions.add(ses);
      try {
        ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
          this.record({ face: 'chromium', method: details.method, url: details.url, resourceType: details.resourceType });
          callback({});
        });
      } catch {
        // 会话不可钩（如内存临时会话销毁中）时静默
      }
    });
  }

  /** Node 面：包装 globalThis.fetch，主进程适配器出站请求全部入审计 */
  installFetchHook(): void {
    const g = globalThis as { fetch?: typeof fetch };
    if (this.fetchPatched || typeof g.fetch !== 'function') return;
    const original = g.fetch;
    this.originalFetch = original;
    this.fetchPatched = true;
    g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      let url = '';
      try {
        url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      } catch {
        url = String(input);
      }
      const method = String(init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET') ?? 'GET').toUpperCase();
      this.record({ face: 'node-fetch', method, url });
      return original.call(globalThis, input as RequestInfo, init);
    }) as typeof fetch;
  }

  /** 还原 globalThis.fetch（测试清理用） */
  uninstallFetchHook(): void {
    if (!this.fetchPatched || !this.originalFetch) return;
    (globalThis as { fetch?: typeof fetch }).fetch = this.originalFetch;
    this.originalFetch = null;
    this.fetchPatched = false;
  }

  record(e: { face: NetAuditEntry['face']; method: string; url: string; resourceType?: string }): void {
    let host = '';
    try {
      host = new URL(e.url).hostname; // 不含端口：白名单按域名判定
    } catch {
      host = '(unparsable)';
    }
    const entry: NetAuditEntry = {
      at: new Date().toISOString(),
      face: e.face,
      method: e.method.toUpperCase(),
      url: e.url,
      host,
      resourceType: e.resourceType,
      isUpload: UPLOAD_METHODS.has(e.method.toUpperCase()),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_BUFFER) this.entries.splice(0, this.entries.length - MAX_BUFFER);
    this.stream?.write(`${JSON.stringify(entry)}\n`);
  }

  snapshot(): NetAuditEntry[] {
    return [...this.entries];
  }

  /** 域名白名单判定：本机回环 / 无 host（file: 等）/ provider 官方 API 域名 */
  static isAllowedHost(host: string): boolean {
    if (!host) return true; // file://、about:blank 等无网络 host
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host.endsWith('.localhost')) return true;
    return PROVIDER_OFFICIAL_HOSTS.has(host);
  }
}

/** provider 官方出站白名单：内置适配器默认端点（用户显式配置 base_url 也在其官方域下） */
export const PROVIDER_OFFICIAL_HOSTS: ReadonlySet<string> = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'management.azure.com',
  'api.deepseek.com',
  'apiapi.moonshot.cn',
  'open.bigmodel.cn',
  'dashscope.aliyuncs.com',
  'aip.baidubce.com',
  'api.xiaomimimo.com',
  'api.minimaxi.com',
  'api.minimax.io',
  'opencode.ai',
]);
