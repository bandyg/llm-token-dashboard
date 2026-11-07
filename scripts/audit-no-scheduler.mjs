#!/usr/bin/env node
/**
 * 无采集调度审计（AC：所有采集仅由用户行为触发，无任何后台定时/自动轮询）。
 * 「用户行为触发」含两种，均不含时间驱动：
 *   - 用户点击「刷新」按钮
 *   - 用户呼出应用窗口（冷启动 / 取消最小化 / 从后台切回 / 二次唤起）—— 属用户动作，非后台轮询
 * 规则：
 *   1) 硬禁关键词（任何出现即失败）：node-cron / cron.schedule / BullMQ / agenda / node-schedule
 *   2) setInterval( 仅允许出现在白名单文件（附理由），其余即失败
 *   3) setTimeout( 同一行/语句含采集语义关键词（collect|refresh|poll|schedule|轮询|定时采集|snapshot|crawl）即失败
 *      （setTimeout 本身合法：防抖、Toast、超时 Abort、加载超时等均非采集调度）
 * 退出码：0 = 通过（无采集调度）；1 = 发现疑似调度器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

const HARD_FORBIDDEN = [/node-cron/, /cron\.schedule/, /\bBullMQ\b/, /\bagenda\b/, /node-schedule/];
const COLLECT_SEMANTIC = /(collect|refresh|poll|snapshot|crawl|轮询|定时采集|定时抓取|自动刷新|scheduler)/i;

/** setInterval 白名单：路径片段 → 理由 */
const SET_INTERVAL_ALLOWLIST = new Map([
  ['src/renderer/src/App.tsx', '同步按钮 10s 冷却倒计时（UI 计时，1s 减 1，不触发任何采集 IPC）'],
]);

function* walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mjs)$/.test(f.name)) yield full;
  }
}

const offenders = [];
const allowedHits = [];
let filesScanned = 0;

for (const file of walk(SRC)) {
  filesScanned++;
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const no = `${rel}:${i + 1}`;
    for (const re of HARD_FORBIDDEN) {
      if (re.test(line)) offenders.push(`${no} 硬禁调度关键词 /${re.source}/ → ${line.trim().slice(0, 90)}`);
    }
    if (/setInterval\s*\(/.test(line)) {
      const reason = [...SET_INTERVAL_ALLOWLIST.entries()].find(([frag]) => rel.includes(frag));
      if (reason && !COLLECT_SEMANTIC.test(line)) allowedHits.push(`${no} setInterval（白名单：${reason[1]}）→ ${line.trim().slice(0, 90)}`);
      else offenders.push(`${no} 非白名单 setInterval → ${line.trim().slice(0, 90)}`);
    }
    if (/setTimeout\s*\(/.test(line) && COLLECT_SEMANTIC.test(line)) {
      offenders.push(`${no} setTimeout 带采集语义 → ${line.trim().slice(0, 90)}`);
    }
  });
}

console.log(`[audit-no-scheduler] 扫描 ${filesScanned} 个源文件（${path.relative(ROOT, SRC)}）`);
for (const hit of allowedHits) console.log(`  ALLOWED  ${hit}`);
if (offenders.length) {
  for (const o of offenders) console.error(`  OFFENDER ${o}`);
  console.error(`[audit-no-scheduler] FAIL：发现 ${offenders.length} 处疑似采集调度`);
  process.exit(1);
}
console.log('[audit-no-scheduler] PASS：无任何定时/队列驱动的采集调度（采集仅由用户点击刷新触发）');
