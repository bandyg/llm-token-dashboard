import fs from 'node:fs';
import path from 'node:path';

/**
 * 运行日志：采集编排过程（含 await sleep(N) 间隔轨迹）落盘到 userData/logs/run.log，
 * 供验收「运行日志可见相邻 provider 间 await sleep(N) 且 N≥interval_seconds」核验。
 */
export class RunLogger {
  private lines: string[] = [];
  private stream: fs.WriteStream | null = null;

  constructor(private file?: string) {}

  attachFile(file: string): void {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    for (const l of this.lines) this.stream.write(l + '\n');
  }

  log(scope: string, message: string): void {
    const line = `${new Date().toISOString()} [${scope}] ${message}`;
    this.lines.push(line);
    if (this.lines.length > 5000) this.lines.splice(0, 1000);
    if (this.stream) this.stream.write(line + '\n');
    else console.log(line);
  }

  tail(n = 200): string[] {
    return this.lines.slice(-n);
  }
}

export const runLogger = new RunLogger();

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
