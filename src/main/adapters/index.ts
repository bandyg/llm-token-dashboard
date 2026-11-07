import type { Adapter, FetchLike } from './types';
import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { azureOpenAiAdapter } from './azure-openai';
import { deepseekAdapter } from './deepseek';
import { zhipuAdapter } from './zhipu';
import { minimaxAdapter } from './minimax';
import { mimoAdapter } from './xiaomi-mimo';
import { opencodeGoAdapter } from './opencode-go';

export const ADAPTERS: Record<string, Adapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  'azure-openai': azureOpenAiAdapter,
  deepseek: deepseekAdapter,
  zhipu: zhipuAdapter,
  minimax: minimaxAdapter,
  'xiaomi-mimo': mimoAdapter,
  opencode: opencodeGoAdapter,
  /** OpenAI 兼容协议兜底（通义/月之暗面等兼容端点） */
  'openai-compatible': openaiAdapter,
};

export function getAdapter(id: string | null | undefined): Adapter | null {
  if (!id) return null;
  return ADAPTERS[id] ?? null;
}

export function adapterIds(): string[] {
  return Object.keys(ADAPTERS);
}

export function defaultFetch(): FetchLike {
  return (async (url: string, init?: RequestInit) => {
    const res = await fetch(url, init);
    return {
      status: res.status,
      ok: res.ok,
      json: () => res.json(),
      text: () => res.text(),
    };
  }) as FetchLike;
}
