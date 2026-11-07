#!/usr/bin/env node
/**
 * 用 esbuild 打包主进程 / preload / 选区 overlay 三类入口：
 *  - dist/main/index.js          主进程（cjs，external: electron / better-sqlite3）
 *  - dist/preload/main.js        主窗口 preload（cjs）
 *  - dist/preload/region-bridge.js 采集 BrowserView 的 preload（cjs）
 *  - dist/renderer/region-overlay.js 选区 overlay（iife，注入页面执行）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esbuildArgs0 = [path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild')];

const define = { 'process.env.NODE_ENV': '"production"', 'global': 'globalThis' };

const targets = [
  {
    entry: 'src/main/index.ts',
    outfile: 'dist/main/index.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'better-sqlite3'],
    sourcemap: true,
  },
  {
    entry: 'src/preload/main.ts',
    outfile: 'dist/preload/main.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    sourcemap: false,
  },
  {
    entry: 'src/preload/region-bridge.ts',
    outfile: 'dist/preload/region-bridge.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    sourcemap: false,
  },
  {
    entry: 'src/region-overlay/index.ts',
    outfile: 'dist/renderer/region-overlay.js',
    platform: 'browser',
    format: 'iife',
    sourcemap: false,
  },
];

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
for (const t of targets) {
  const args = [
    path.join(root, t.entry),
    `--outfile=${path.join(root, t.outfile)}`,
    `--platform=${t.platform}`,
    `--format=${t.format}`,
    '--bundle',
    '--charset=utf8',
  ];
  if (t.external) t.external.forEach((e) => args.push(`--external:${e}`));
  if (t.sourcemap) args.push('--sourcemap');
  Object.entries(define).forEach(([k, v]) => args.push(`--define:${k}=${v}`));
  execFileSync(process.execPath, [...esbuildArgs0, ...args], { stdio: 'inherit', cwd: root });
  console.log('[build-main]', t.outfile, 'done');
}
