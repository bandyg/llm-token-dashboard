import type { ProviderConfig, Region } from '../../shared/types';
import { BrowserViewPool } from './browser-pool';
import { CollectError } from './errors';
import { runDomScript, buildDefaultDomScript } from './dom-extractor';
import { selectOcrEngine } from '../ocr/engine';
import { parseQuotaText, parseUsedRemaining } from '../ocr/number-parser';
import type { SafeStore } from '../credentials/safe-store';
import type { CookieStore } from '../db/cookies';
import type { RunLogger } from '../logger';

/** 测试注入钩子（LLMDASH_TEST=1 时生效）——验收判据中「注入 OCR confidence / 注入网络异常」的落点 */
export interface TestInjections {
  ocrConfidence?: number;
  ocrText?: string;
  networkFail?: boolean;
  domMiss?: boolean;
  authRequired?: boolean;
}

export interface CollectOutcome {
  used: number | null;
  remaining: number | null;
  total: number | null;
  source: 'dom' | 'ocr';
  raw_text: string;
  confidence?: number;
}

export class WebCollector {
  constructor(
    private pool: BrowserViewPool,
    private safeStore: SafeStore,
    private cookieStore: CookieStore,
    private logger: RunLogger,
    private injections: TestInjections = {},
  ) {}

  setInjections(inj: TestInjections): void {
    this.injections = inj;
  }

  async collect(provider: ProviderConfig, winSize: { width: number; height: number }): Promise<CollectOutcome> {
    if (this.injections.networkFail) {
      throw new CollectError('network', '网络异常（注入）：无法连接目标站点');
    }
    const url = provider.dom_url || provider.page_url;
    if (!url) throw new CollectError('browserview_unavailable', '未配置抓取目标 URL');

    const entry = await this.pool.ensureForProvider(provider.id);
    try {
      await this.pool.navigate(provider.id, url);
    } catch (e) {
      throw new CollectError('browserview_unavailable', (e as Error).message);
    }

    // 登录态检测
    let authRequired = !!this.injections.authRequired;
    if (!authRequired) {
      try {
        const r = await this.pool.checkAuth(provider.id, provider.login_required_selector);
        authRequired = r.loginRequired;
      } catch {
        authRequired = false;
      }
    }
    if (authRequired) {
      throw new CollectError('login_expired', '🔐 请手动登录');
    }

    // Cookie 导出（safeStorage 加密镜像到 cookies 表，按 provider_id 隔离）
    try {
      const cookies = await this.pool.exportCookies(provider.id, (v) => this.safeStore.encryptToBlob(v));
      if (cookies.length) this.cookieStore.replaceForProvider(provider.id, cookies);
    } catch (e) {
      this.logger.log('web-collector', `cookie 导出失败 provider=${provider.id}: ${(e as Error).message}`);
    }

    if (provider.sub_mode === 'ocr') {
      return this.collectOcr(provider, winSize);
    }
    return this.collectDom(provider);
  }

  private async collectDom(provider: ProviderConfig): Promise<CollectOutcome> {
    if (this.injections.domMiss) {
      throw new CollectError('selector_missing', 'DOM 选择器失效：未在页面中命中元素（注入）');
    }
    const script =
      provider.dom_script ||
      buildDefaultDomScript(provider.selectors);
    const { text, missedSelectors } = await runDomScript((code) => this.pool.executeJs(provider.id, code), script);
    if (missedSelectors.length) {
      throw new CollectError('selector_missing', `DOM 选择器失效：未在页面中命中元素（${missedSelectors.join(', ')}）`);
    }
    const { used, remaining } = parseUsedRemaining(text);
    if (used === null && remaining === null) {
      throw new CollectError('parse_error', `响应解析失败：未找到可用额度数字（原文「${text.slice(0, 40)}」）`);
    }
    return {
      used,
      remaining,
      total: provider.quota_total ?? null,
      source: 'dom',
      raw_text: text,
    };
  }

  private async collectOcr(provider: ProviderConfig, winSize: { width: number; height: number }): Promise<CollectOutcome> {
    const region: Region | null = provider.region;
    if (!region || region.w <= 0 || region.h <= 0) {
      throw new CollectError('parse_error', 'OCR 选区未配置，请先在区域选择器中拖拽框选');
    }
    // 视口夹紧（选区超出视口自动裁剪）
    const x = Math.min(region.x, winSize.width - 1);
    const y = Math.min(region.y, winSize.height - 1);
    const w = Math.min(region.w, winSize.width - x);
    const h = Math.min(region.h, winSize.height - y);
    if (w < 10 || h < 10) {
      throw new CollectError('parse_error', '选区过小或超出视口，请重新框选');
    }

    const { engine, backend } = await selectOcrEngine();
    const bmp = await this.pool.captureRegion(provider.id, { x, y, width: w, height: h });
    const result = await engine.recognize(bmp);
    const confidence = this.injections.ocrConfidence ?? result.confidence;
    const text = this.injections.ocrText ?? result.text;
    this.logger.log(
      'web-collector',
      `OCR(${backend}) provider=${provider.id} region={x:${x},y:${y},w:${w},h:${h}} text="${text}" confidence=${confidence.toFixed(3)} threshold=${provider.ocr_threshold}`,
    );
    if (confidence < provider.ocr_threshold) {
      throw new CollectError('ocr_low_confidence', `OCR 置信度 ${confidence.toFixed(2)} < 阈值 ${provider.ocr_threshold}，已拒绝生成快照`);
    }
    const parsedPair = parseUsedRemaining(text);
    const used = parsedPair.used ?? parseQuotaText(text).primary;
    const remaining =
      parsedPair.remaining ?? (provider.quota_total !== null && used !== null ? provider.quota_total - used : null);
    if (used === null && remaining === null) {
      throw new CollectError('ocr_low_confidence', `OCR 未识别出额度数字（原文「${text.slice(0, 40)}」）`);
    }
    return {
      used,
      remaining,
      total: provider.quota_total ?? null,
      source: 'ocr',
      raw_text: text,
      confidence,
    };
  }
}

