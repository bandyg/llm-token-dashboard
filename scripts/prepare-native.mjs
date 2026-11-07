#!/usr/bin/env node
/**
 * 准备 Electron ABI 的 better-sqlite3 原生二进制（vendor/better_sqlite3-electron.node）。
 * vitest 在 Node ABI 下直接使用 node_modules 内二进制；Electron 主进程通过
 * Database(path, { nativeBinding }) 加载 vendor 内的 electron ABI 二进制。
 * 二者并存，互不覆盖。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const pkg = require('../package.json');
const sqliteVersion = pkg.devDependencies && pkg.dependencies && pkg.dependencies['better-sqlite3']
  ? pkg.dependencies['better-sqlite3']
  : require('../node_modules/better-sqlite3/package.json').version;

const electronAbi = 130; // Electron 33
const electronAbiDir = 'electron-v' + electronAbi;
const platform = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch;
const vendorDir = path.join(root, 'vendor');
const target = path.join(vendorDir, `better_sqlite3-electron-v${electronAbi}-${platform}-${arch}.node`);

async function main() {
  fs.mkdirSync(vendorDir, { recursive: true });
  if (fs.existsSync(target)) {
    console.log('[prepare-native] already exists:', target);
    return;
  }
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${sqliteVersion}/better-sqlite3-v${sqliteVersion}-${electronAbiDir}-${platform}-${arch}.tar.gz`;
  console.log('[prepare-native] downloading', url);
  const tgz = path.join(vendorDir, '.tmp-bs3.tar.gz');
  try {
    execFileSync('curl', ['-sLf', '--max-time', '300', '-o', tgz, url], { stdio: 'inherit' });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  }
  // tar.gz 解包：取 build/Release/better_sqlite3.node
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs3-'));
  execFileSync('tar', ['-xzf', tgz, '-C', tmp]);
  fs.rmSync(tgz, { force: true });
  const extracted = path.join(tmp, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(extracted)) throw new Error('binary not found in tarball');
  fs.copyFileSync(extracted, target);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('[prepare-native] saved', target, fs.statSync(target).size, 'bytes');
}

main().catch((e) => {
  console.error('[prepare-native] FAILED:', e.message);
  process.exit(1);
});
