#!/usr/bin/env node
/**
 * 用 Playwright 渲染 resources/icon.svg，生成多尺寸 PNG 并打包成 resources/icon.ico。
 * ICO 采用 PNG 内嵌格式（Vista+ 均支持），避免手写 BMP 行序。
 * 用法：node scripts/make-icon.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'resources', 'icon.svg');
const icoPath = path.join(root, 'resources', 'icon.ico');
const pngDir = path.join(root, 'resources', 'icons');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function packIco(entries) {
  // entries: [{ size, buf }]，按尺寸降序写入目录
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirEntries = [];
  const blobs = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 表示 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    dirEntries.push(e);
    blobs.push(buf);
    offset += buf.length;
  }
  return Buffer.concat([header, ...dirEntries, ...blobs]);
}

const svg = fs.readFileSync(svgPath, 'utf8');
fs.mkdirSync(pngDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
await page.setContent(
  `<!doctype html><html><head><style>*{margin:0;padding:0}html,body{background:transparent;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style></head><body>${svg}</body></html>`
);

const entries = [];
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  fs.writeFileSync(path.join(pngDir, `icon-${size}.png`), buf);
  entries.push({ size, buf });
  console.log('[make-icon]', `icon-${size}.png`, `${buf.length}B`);
}
await browser.close();

// 256px 独立 PNG（将来打包/托盘可直接用）
fs.writeFileSync(path.join(root, 'resources', 'icon.png'), entries[entries.length - 1].buf);
fs.writeFileSync(icoPath, packIco(entries));
console.log('[make-icon]', path.relative(root, icoPath), `${fs.statSync(icoPath).size}B`);
