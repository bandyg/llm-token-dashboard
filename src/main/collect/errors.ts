import type { FailReasonCode } from '../../shared/types';
import { AdapterError } from '../adapters/types';

export class CollectError extends Error {
  constructor(
    public code: FailReasonCode,
    message: string,
  ) {
    super(message);
    this.name = 'CollectError';
  }
}

/** AdapterError.code → FailReasonCode（决定卡片给什么修复动作） */
const ADAPTER_ERROR_MAP: Record<AdapterError['code'], FailReasonCode> = {
  auth_expired: 'auth_expired',
  adapter_upstream_error: 'adapter_upstream_error',
  network: 'network',
  parse_error: 'parse_error',
};

export function toCollectError(e: unknown): CollectError {
  if (e instanceof CollectError) return e;
  // 适配器已分类的错误保留原 code：否则 auth_expired 会被降级成 network，
  // 界面就会给出「检查网络」而非「重新登录」的错误修复动作
  if (e instanceof AdapterError) return new CollectError(ADAPTER_ERROR_MAP[e.code], e.message || String(e));
  return new CollectError('network', (e as Error)?.message || String(e));
}
