import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function tmpDbFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `llmdash-${name}-`));
  return path.join(dir, 'test.sqlite3');
}

export function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `llmdash-${name}-`));
}
