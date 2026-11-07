/** 适配器输出的单个额度窗口（落库前不含 id/snapshot_id 等存储字段） */
export interface QuotaWindowOut {
  window_key: string;
  window_label: string;
  percent_used: number | null;
  used: number | null;
  remaining: number | null;
  total: number | null;
  /** '%' 百分比口径 | '次' 绝对次数口径 */
  unit: string;
  reset_at: string | null;
}

/** 适配器输出的订阅信息 */
export interface SubscriptionOut {
  product_name: string | null;
  level: string | null;
  status: string | null;
  valid_from: string | null;
  valid_to: string | null;
  next_renew_at: string | null;
  auto_renew: 0 | 1;
  billing_cycle: string | null;
  raw?: string | null;
}

export interface NormalizedUsage {
  used: number | null;
  remaining: number | null;
  total: number | null;
  used_input?: number | null;
  used_output?: number | null;
  currency?: string;
  reset_at?: string | null;
  account_preview?: string;
  /** 多额度窗口（订阅型厂商）；普通厂商留空 */
  windows?: QuotaWindowOut[];
  /** 订阅信息；无订阅概念或端点失败时为 null */
  subscription?: SubscriptionOut | null;
}

export interface AdapterCredentials {
  apiKey: string;
  baseUrl: string;
  extra?: Record<string, string>;
  /** 网页登录态 Cookie 串（部分厂商的额度接口只认会话，不认 API Key），由编排器从 cookies 表注入 */
  cookie?: string | null;
}

export interface FetchLikeContext {
  fetchImpl: FetchLike;
  timeoutMs?: number;
  /** 可选 URL 观察钩子；fetchJson 在每次请求前回调。用于 service 层向用户报告实际命中端点。 */
  onUrl?: (url: string) => void;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<ResponseLike>;

export interface ResponseLike {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface Adapter {
  /** 与文件名同名的稳定标识 */
  id: string;
  /** 判据要求：调用对应 usage endpoint 生成快照 */
  fetchQuota(cred: AdapterCredentials, ctx: FetchLikeContext): Promise<NormalizedUsage>;
}

export class AdapterError extends Error {
  constructor(
    public code: 'auth_expired' | 'adapter_upstream_error' | 'network' | 'parse_error',
    message: string,
    public upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function fetchJson(ctx: FetchLikeContext, url: string, init: RequestInit = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    ctx.onUrl?.(url);
    const res = await ctx.fetchImpl(url, { ...init, signal: ctrl.signal });
    if (res.status === 401 || res.status === 403) {
      throw new AdapterError('auth_expired', `凭据无效 (${res.status})`, res.status);
    }
    if (!res.ok) {
      throw new AdapterError('adapter_upstream_error', `上游接口错误 HTTP ${res.status}`, res.status);
    }
    return await res.json();
  } catch (e) {
    if (e instanceof AdapterError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new AdapterError('network', '请求超时（10s）');
    }
    throw new AdapterError('network', `网络异常：${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}
