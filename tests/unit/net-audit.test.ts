import { describe, expect, it, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { NetAudit, PROVIDER_OFFICIAL_HOSTS } from '../../src/main/net-audit';
import { tmpDir } from './setup';

/**
 * 网络审计（P0-003 安全判据的取证面）：Node fetch 钩子 + 本地落盘 + 白名单判定。
 * Chromium webRequest 面在 e2e 中随真实窗口验证。
 */
describe('NetAudit 网络审计', () => {
  const dir = tmpDir('netaudit');
  const audit = new NetAudit();
  audit.start(dir);
  audit.installFetchHook();

  let server: http.Server;
  let port = 0;
  afterAll(async () => {
    audit.uninstallFetchHook();
    audit.stop();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('记录出站 fetch：GET/POST 均入审计，POST 标记 isUpload', async () => {
    server = http.createServer((req, res) => {
      void req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) =>
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        r();
      }),
    );

    await fetch(`http://127.0.0.1:${port}/usage`);
    await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', body: 'pwd=1' });

    const entries = audit.snapshot().filter((e) => e.face === 'node-fetch' && e.url.includes(`:${port}`));
    expect(entries.length).toBe(2);
    const get = entries.find((e) => e.method === 'GET')!;
    const post = entries.find((e) => e.method === 'POST')!;
    expect(get.isUpload).toBe(false);
    expect(post.isUpload).toBe(true);
    expect(get.host).toBe('127.0.0.1');
  });

  it('落盘 JSONL：记录逐行写入 logs/net-audit.jsonl（本地取证文件）', () => {
    const file = path.join(dir, 'logs', 'net-audit.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const parsed = lines.map((l) => JSON.parse(l) as { method: string; url: string; isUpload: boolean });
    expect(parsed.some((p) => p.method === 'POST' && p.isUpload)).toBe(true);
  });

  it('白名单判定：本机回环/官方 API 域名允许，任意第三方域名拒绝', () => {
    expect(NetAudit.isAllowedHost('127.0.0.1')).toBe(true);
    expect(NetAudit.isAllowedHost('localhost')).toBe(true);
    expect(NetAudit.isAllowedHost('')).toBe(true); // file:// 无 host
    for (const host of PROVIDER_OFFICIAL_HOSTS) {
      expect(NetAudit.isAllowedHost(host)).toBe(true);
    }
    expect(NetAudit.isAllowedHost('telemetry.example.com')).toBe(false);
    expect(NetAudit.isAllowedHost('ocr.aliyuncs.com')).toBe(false); // 云端 OCR 不在白名单（本地 PaddleOCR 零出站）
    expect(NetAudit.isAllowedHost('evil.upload.cn')).toBe(false);
  });

  afterEach(() => {
    // 本文件内的钩子由 afterAll 统一还原；此处仅做快照健康检查
    expect(audit.snapshot().length).toBeGreaterThanOrEqual(0);
  });
});
