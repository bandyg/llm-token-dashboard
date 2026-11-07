#!/usr/bin/env node
/**
 * P0-003 安全判据「抓包 1 小时」实测脚本。
 *
 * 用法：node scripts/capture-1h.mjs [分钟数=60] [--out docs/changelog/artifacts]
 *
 * 做什么：
 *   1. 在 127.0.0.1 起一个 loopback mock provider（额度端点 + 控制台页 + 登录页）；
 *   2. 用 Playwright _electron 启动构建产物（独立 dataDir + LLMDASH_TEST=1），
 *      应用自身挂载 NetAudit 双面抓包（Chromium webRequest + 主进程 fetch），逐条落盘
 *      dataDir/logs/net-audit.jsonl；
 *   3. 种 3 个 Provider（API 适配器 / DOM 抓取 / 仅手动录入）并写入凭据（safeStorage）；
 *   4. 模拟真实用户节奏：每 3.5 分钟手动触发一次「全部刷新」（用户动作，非后台轮询），
 *      其中穿插一次手动录入兜底；其余时间静置；
 *   5. 每 30s 心跳：解析 net-audit.jsonl 当前增量，记录耗时/请求数/上传数/快照行数；
 *   6. 结束后全量分析 jsonl：域名分布、上传请求去向、非白名单域名判定；
 *      并经 test:sql 核对 providers/cookies/llm_usage_snapshots 均在本地 SQLite；
 *   7. 输出 JSON 报告 + 控制台摘要；发现非白名单上传请求时 exit 1。
 *
 * 说明：脚本自身的定时器只驱动「测试车」（触发用户刷新动作 + 心跳读文件），
 * 不属于应用代码；应用内无任何定时采集（见 scripts/audit-no-scheduler.mjs 门禁）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINUTES = Number(process.argv[2]?.match(/^\d+$/)?.[0] ?? 60);
const DURATION_MS = MINUTES * 60_000;
const OUT_DIR = path.join(REPO, 'docs', 'changelog', 'artifacts');
const REFRESH_PERIOD_MS = 210_000; // 每 3.5 分钟一次用户「全部刷新」
const HEARTBEAT_MS = 30_000;

/* ---------- 1. loopback mock provider ---------- */
function startMock(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/dashboard/billing/subscription') {
      if ((req.headers.authorization ?? '') !== 'Bearer sk-capture-good') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total_granted: 80, total_used: 21.5, total_available: 58.5, plan: 'pay-as-you-go' }));
      return;
    }
    if (url.pathname === '/console') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>capture console</title></head><body>
        <div class="quota-panel"><span class="quota-used">36.20</span><span class="quota-remaining">43.80</span></div>
        </body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: (server.address()).port })));
}

/* ---------- allowlist：与 src/main/net-audit.ts 保持单一来源（启动时从源码解析） ---------- */
function loadProviderHosts() {
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'net-audit.ts'), 'utf8');
  const block = src.slice(src.indexOf('PROVIDER_OFFICIAL_HOSTS'));
  const hosts = [...block.matchAll(/'([a-z0-9.\-]+\.[a-z]+)'/g)].map((m) => m[1]);
  if (!hosts.length) throw new Error('未能从 net-audit.ts 解析 provider 官方域名白名单');
  return new Set(hosts);
}
function isAllowedHost(host, providerHosts) {
  if (!host) return true; // file://、devtools:// 等无网络 host
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host.endsWith('.localhost')) return true;
  return providerHosts.has(host);
}

/* ---------- jsonl 解析 ---------- */
function analyzeJsonl(file, providerHosts) {
  const entries = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* 截断行忽略 */ }
    }
  }
  const byHost = new Map();
  const uploadsByHost = new Map();
  let uploads = 0;
  const violations = [];
  const uploadViolations = [];
  for (const e of entries) {
    byHost.set(e.host, (byHost.get(e.host) ?? 0) + 1);
    if (e.isUpload) {
      uploads++;
      uploadsByHost.set(e.host, (uploadsByHost.get(e.host) ?? 0) + 1);
    }
    if (!isAllowedHost(e.host, providerHosts)) {
      violations.push(e);
      if (e.isUpload) uploadViolations.push(e);
    }
  }
  return { total: entries.length, uploads, byHost, uploadsByHost, violations, uploadViolations };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const startedAt = new Date();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmdash-capture1h-'));
  const jsonl = path.join(dataDir, 'logs', 'net-audit.jsonl');
  const progressFile = path.join(OUT_DIR, 'net-capture-progress.jsonl');
  fs.writeFileSync(progressFile, '');
  const providerHosts = loadProviderHosts();
  const mock = await startMock();
  const base = `http://127.0.0.1:${mock.port}`;

  console.log(`[capture-1h] 开始：${startedAt.toISOString()}，时长 ${MINUTES} 分钟`);
  console.log(`[capture-1h] dataDir=${dataDir}`);
  console.log(`[capture-1h] mock(loopback)=${base}，provider 官方域名白名单 ${providerHosts.size} 条`);

  const app = await electron.launch({
    args: [REPO],
    env: {
      ...process.env,
      LLMDASH_DATA_DIR: dataDir,
      LLMDASH_API_PORT: '47995',
      LLMDASH_TEST: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('[data-testid="main-area"]', { timeout: 20_000 });
  const invoke = async (channel, payload) => {
    // preload 的 invoke 返回统一信封 { code, message, data }；非 0 抛错
    const r = await win.evaluate(({ c, p }) => (window).llm.invoke(c, p), { c: channel, p: payload });
    if (r.code !== 0) throw new Error(`IPC ${channel} 失败: ${r.message}`);
    return r.data;
  };
  await invoke('llm:settings:set', { interval_seconds: 0, min_refresh_seconds: 1 });

  // 种 Provider：API 适配器（node-fetch 面）+ DOM 抓取（Chromium 面）+ 仅手动
  const mk = (patch) => invoke('llm:providers:create', patch);
  const apiId = (await mk({
    provider_name: 'Capture-API', alias: '适配器', template: 'custom', mode: 'api', adapter: 'openai',
    enabled: 1, base_url: base, quota_total: 80, currency: 'USD', alert_threshold: 10,
  })).id;
  await invoke('llm:credentials:set', { providerId: apiId, apiKey: 'sk-capture-good' });
  const domId = (await mk({
    provider_name: 'Capture-DOM', alias: '网页抓取', template: 'custom', mode: 'web_crawl', sub_mode: 'dom',
    enabled: 1, dom_url: `${base}/console`, selectors: [{ name: '已用', selector: '.quota-used' }, { name: '剩余', selector: '.quota-remaining' }],
    quota_total: 80, currency: 'USD', alert_threshold: 10,
  })).id;
  const manualId = (await mk({
    provider_name: 'Capture-Manual', alias: '手动', template: 'custom', mode: 'manual', sub_mode: null,
    enabled: 1, quota_total: 100, currency: 'USD', alert_threshold: 10,
  })).id;
  console.log(`[capture-1h] 已种 3 个 Provider：api=${apiId} dom=${domId} manual=${manualId}`);

  const snapCount = async () => {
    const r = await invoke('llm:test:sql', { sql: 'SELECT COUNT(*) AS c FROM llm_usage_snapshots' });
    return Number(r.rows[0].c);
  };
  const tableRow = (t) => invoke('llm:test:sql', { sql: `SELECT COUNT(*) AS c FROM ${t}` }).then((r) => Number(r.rows[0].c));

  let refreshCycles = 0;
  const deadline = Date.now() + DURATION_MS;
  let nextRefresh = Date.now() + REFRESH_PERIOD_MS;
  let nextBeat = Date.now() + HEARTBEAT_MS;
  let manualDone = false;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(deadline - Date.now(), 0))));
    const now = Date.now();
    if (now >= nextRefresh) {
      nextRefresh = now + REFRESH_PERIOD_MS;
      refreshCycles++;
      const before = await snapCount();
      // 用户动作：顶部「同步刷新」等价的 IPC（分批并行策略走设置默认值）
      await invoke('llm:refresh:batch', { scope: 'all', ids: [] });
      const after = await snapCount();
      console.log(`[capture-1h] t+${((now - startedAt.getTime()) / 60000).toFixed(1)}min 用户全部刷新 #${refreshCycles}：快照 ${before} → ${after}`);
    }
    if (!manualDone && now >= startedAt.getTime() + 10 * 60_000) {
      manualDone = true;
      await invoke('llm:usage:manual', { providerId: manualId, mode: 'used', amount: 12.5, note: 'capture-1h 手动兜底' });
      console.log('[capture-1h] t+10min 手动录入兜底一次（本地，无网络请求）');
    }
    if (now >= nextBeat) {
      nextBeat = now + HEARTBEAT_MS;
      const a = analyzeJsonl(jsonl, providerHosts);
      const snaps = await snapCount();
      const beat = {
        at: new Date().toISOString(),
        elapsedMin: Number(((now - startedAt.getTime()) / 60000).toFixed(2)),
        requests: a.total, uploads: a.uploads,
        violations: a.violations.length, uploadViolations: a.uploadViolations.length,
        snapshotRows: snaps, refreshCycles,
      };
      fs.appendFileSync(progressFile, `${JSON.stringify(beat)}\n`);
      console.log(`[capture-1h] 心跳 t+${beat.elapsedMin}min 请求=${a.total} 上传=${a.uploads} 违规=${a.violations.length} 快照=${snaps}`);
    }
  }

  /* ---------- 收尾分析 ---------- */
  console.log('[capture-1h] 到达 1 小时，关闭应用并做全量分析…');
  const dbTables = {};
  for (const t of ['providers', 'cookies', 'llm_usage_snapshots']) dbTables[t] = await tableRow(t);
  await app.close().catch(() => undefined);
  mock.server.closeAllConnections?.();
  mock.server.close();

  const a = analyzeJsonl(jsonl, providerHosts);
  const endedAt = new Date();
  const report = {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMinutes: MINUTES,
    dataDir,
    netAuditFile: jsonl,
    allowlist: { providerOfficialHosts: [...providerHosts].sort(), loopback: ['127.0.0.1', 'localhost', '[::1]'] },
    totals: {
      requests: a.total,
      uploads: a.uploads,
      byFace: [...a.byHost.keys()].length ? undefined : undefined,
      requestsByHost: Object.fromEntries([...a.byHost.entries()].sort()),
      uploadsByHost: Object.fromEntries([...a.uploadsByHost.entries()].sort()),
    },
    security: {
      nonAllowlistedRequests: a.violations.length,
      nonAllowlistedUploads: a.uploadViolations.length,
      uploadViolations: a.uploadViolations.slice(0, 20),
      violationsSample: a.violations.slice(0, 20).map((v) => ({ at: v.at, face: v.face, method: v.method, url: v.url })),
    },
    userActions: { refreshCycles, manualEntry: manualDone },
    localSqlite: { file: path.join(dataDir, 'llm-dashboard.sqlite3'), rows: dbTables },
    progressFile,
    verdict: a.uploadViolations.length === 0 ? 'PASS' : 'FAIL',
  };
  const reportPath = path.join(OUT_DIR, `net-capture-1h-report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('\n========== 抓包 1 小时结论 ==========');
  console.log(`时间窗：${report.startedAt} → ${report.endedAt}（${MINUTES} 分钟）`);
  console.log(`捕获请求总数：${a.total}（其中上传 POST/PUT/PATCH ${a.uploads} 条）`);
  for (const [h, c] of [...a.byHost.entries()].sort()) console.log(`  host ${h}: ${c} 条`);
  for (const [h, c] of [...a.uploadsByHost.entries()].sort()) console.log(`  upload ${h}: ${c} 条`);
  console.log(`非白名单域名请求：${a.violations.length} 条；其中上传：${a.uploadViolations.length} 条`);
  console.log(`本地 SQLite 行数：providers=${dbTables.providers} cookies=${dbTables.cookies} llm_usage_snapshots=${dbTables.llm_usage_snapshots}`);
  console.log(`用户动作：全部刷新 ×${refreshCycles}，手动录入 ×${manualDone ? 1 : 0}`);
  console.log(`判定：${report.verdict}（报告：${reportPath}）`);
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error('[capture-1h] 失败：', e);
  process.exit(2);
});
