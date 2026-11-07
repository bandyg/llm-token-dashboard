import http from 'node:http';
import crypto from 'node:crypto';
import type httpy from 'node:http';
import { TEMPLATES } from '../../src/main/ocr/font-bitmaps';

export interface MockRequest {
  path: string;
  host: string;
  method: string;
  at: number;
}

export interface MockServer {
  port: number;
  close(): Promise<void>;
  requests: MockRequest[];
  /** 武装一次：下一个 usage 端点请求挂起不响应（测试连接 10s 超时弹窗用例） */
  armHangNext(): void;
}

/**
 * E2E mock 集合：
 *  - /console            已登录控制台：DOM 额度文本 + 5×7 像素字体 canvas（OCR 识别目标）
 *  - /console（无 cookie）登录墙（password 输入 → loginRequired 检测命中）
 *  - /login              写入 console_auth cookie（真实 Cookie 持久化链路）
 *  - /v1/dashboard/billing/subscription 等 OpenAI/Anthropic/Azure 用量端点
 */
export function startMockConsole(): Promise<MockServer> {
  const requests: MockRequest[] = [];
  const templatesJson = JSON.stringify(TEMPLATES);
  let hangNext = false;
  const server: httpy.Server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ path: url.pathname, host: req.headers.host ?? '', method: req.method ?? 'GET', at: Date.now() });

    if (url.pathname === '/__hang/arm') {
      // 测试控制面：武装一次挂起（仅本地 mock 控制用途）
      hangNext = true;
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      res.writeHead(302, {
        'Set-Cookie': `console_auth=1; Path=/; Max-Age=86400`,
        Location: '/console',
      });
      res.end();
      return;
    }

    if (url.pathname === '/v1/dashboard/billing/subscription') {
      if (hangNext) {
        // 单次挂起：不响应任何字节，供「测试连接 10s 超时 → 继续等待/跳过」弹窗用例
        hangNext = false;
        return;
      }
      if ((req.headers.authorization ?? '') !== 'Bearer sk-good') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total_granted: 50.0, total_used: 12.34, total_available: 37.66, plan: 'pay-as-you-go', access_until: '2026-11-01T00:00:00Z' }));
      return;
    }
    if (url.pathname === '/v1/organization/costs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ amount: { value: 5.25 } }] }));
      return;
    }
    if (url.pathname.startsWith('/v1/organizations/usage_report')) {
      if ((req.headers['x-api-key'] ?? '') !== 'ak-good') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ usage: { input: 1200, output: 300 }, costUSD: 2.5 }] }));
      return;
    }
    if (url.pathname.includes('/usages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: [{ currentValue: 30, limit: 100, unit: 'Count' }] }));
      return;
    }
    if (url.pathname === '/user/balance') {
      if ((req.headers.authorization ?? '') !== 'Bearer dk-good') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: 128.4, granted_balance: 500 }] }));
      return;
    }
    if (url.pathname === '/console') {
      const cookies = parseCookies(req.headers.cookie ?? '');
      if (cookies.console_auth !== '1' && url.searchParams.get('auth') !== 'ok') {
        // 登录墙（未登录）
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>登录 - 某厂控制台</title></head><body>
          <h1>请登录</h1>
          <form method="post" action="/login">
            <input type="password" name="pwd" placeholder="密码" />
            <button type="submit">登录</button>
          </form>
        </body></html>`);
        return;
      }
      const canvasText = url.searchParams.get('ocr') === 'low' ? '$12.8#/$371.60' : '$128.40/$371.60';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderConsole(canvasText, templatesJson));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        requests,
        armHangNext: () => {
          hangNext = true;
        },
        close: () =>
          new Promise((r) => {
            // 挂起中的「超时用例」连接不结束会阻塞 close，统一强断
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

function renderConsole(canvasText: string, templatesJson: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>某厂控制台 - 用量</title></head>
<body style="margin:0;font-family:system-ui">
  <h2 style="margin:16px 20px">用量概览</h2>
  <div style="margin:8px 20px" class="quota-panel">
    <span class="quota-label">已用</span>
    <span class="quota-used">$12.34</span>
    <span style="margin:0 8px">/</span>
    <span class="quota-label">剩余</span>
    <span class="quota-remaining">$37.66</span>
  </div>
  <div id="ocr-target" style="position:absolute;left:120px;top:160px;background:#fff;border:1px solid #eee">
    <canvas id="quota-canvas" width="${canvasText.length * 36}" height="42"></canvas>
  </div>
  <script>
    // 5×7 像素字体渲染（与应用内置 OCR 模板同源字形，用于离线 OCR 闭环验证）
    var TPL = ${templatesJson};
    var text = ${JSON.stringify(canvasText)};
    var cv = document.getElementById('quota-canvas');
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#271811';
    var SCALE = 6, GW = 5, GH = 7, SP = 1;
    for (var gi = 0; gi < text.length; gi++) {
      var rows = TPL[text[gi]];
      if (!rows) continue;
      for (var ty = 0; ty < GH; ty++) {
        for (var tx = 0; tx < GW; tx++) {
          if (rows[ty][tx] === '1') {
            ctx.fillRect((gi*(GW+SP)+tx)*SCALE, ty*SCALE, SCALE, SCALE);
          }
        }
      }
    }
  </script>
</body></html>`;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}
