import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

/**
 * 凭据安全存储：API Key 等敏感值以 safeStorage 加密 blob 存于 userData/credentials/ 下，
 * 数据库仅保存 credential_ref（文件名指针），明文永不落盘、不进日志。
 */
export class SafeStore {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private fileOf(ref: string): string {
    // 仅允许安全文件名，防止路径穿越
    const safe = ref.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.dir, `${safe}.bin`);
  }

  write(ref: string, plaintext: string): void {
    fs.writeFileSync(this.fileOf(ref), this.encryptToBlob(plaintext));
  }

  /** 加密为可入库的 blob 字符串（cookies 表 value_encrypted 用） */
  encryptToBlob(plaintext: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plaintext).toString('base64');
    }
    return `plain:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
  }

  decryptBlob(blob: string): string {
    if (blob.startsWith('plain:')) return Buffer.from(blob.slice(6), 'base64').toString('utf8');
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      return '';
    }
  }

  read(ref: string): string | null {
    const f = this.fileOf(ref);
    if (!fs.existsSync(f)) return null;
    // 文件内容为 encryptToBlob 产出的（base64 | plain:base64）文本
    const s = fs.readFileSync(f, 'utf8');
    if (s.startsWith('plain:')) return Buffer.from(s.slice(6), 'base64').toString('utf8');
    try {
      return safeStorage.decryptString(Buffer.from(s, 'base64'));
    } catch {
      return null;
    }
  }

  remove(ref: string): void {
    const f = this.fileOf(ref);
    if (fs.existsSync(f)) fs.rmSync(f);
  }
}
