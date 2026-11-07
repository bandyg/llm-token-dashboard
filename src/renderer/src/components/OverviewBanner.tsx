import React from 'react';
import type { ProviderUsageView } from '../../../shared/types';
import { windowRemainingPct } from '../utils';

/**
 * 全局总览头图。
 *
 * 解决的问题：原先要逐张卡往下扫才能发现「某家周额度只剩 15%」。
 * 这里把全局最紧的两个窗口提到页面顶部，进页面第一眼即知整体水位。
 *
 * 只统计有额度窗口的订阅型厂商（单窗口/纯余额厂商不参与「最紧窗口」竞争，
 * 否则它们的百分比会稀释真实风险）。已耗尽（剩余 0%）的窗口同样不参与排名和
 * 「不足 20%」计数——它们没有可行动的信息（只能等重置），继续置顶只是常驻红色噪音。
 * 总用量沿用 Dashboard 既有的货币维度汇总。
 */
export function OverviewBanner({
  providers,
}: {
  providers: ProviderUsageView[];
}): React.ReactElement | null {
  // 收集所有窗口，按剩余百分比升序，最紧的两个排前面
  const windows = providers
    .flatMap((p) =>
      (p.windows ?? []).map((w) => ({
        label: w.window_label.replace(/剩余|限额$/, ''),
        provider: p.provider_name,
        remainingPct: windowRemainingPct(w),
      })),
    )
    // 0%（耗尽待重置）的窗口不上总览：耗尽与否看卡片自身的红条即可
    .filter((w) => w.remainingPct !== null && w.remainingPct > 0)
    .sort((a, b) => (a.remainingPct ?? 100) - (b.remainingPct ?? 100));

  const tightest = windows.slice(0, 2);
  if (!tightest.length) return null;

  const risky = tightest.filter((w) => (w.remainingPct ?? 100) <= 20).length;

  return (
    <section className="overview-banner" data-testid="overview-banner" aria-label="额度总览">
      <div className="overview-banner-head">
        <h2>额度总览</h2>
        <p className="hint">
          {risky > 0
            ? `共 ${providers.length} 家，其中 ${risky} 个窗口剩余不足 20%`
            : `共 ${providers.length} 家，整体水位正常`}
        </p>
      </div>

      <div className="overview-worst">
        {tightest.map((w) => (
          <div key={`${w.provider}-${w.label}`} className={`overview-worst-item ${bandOf(w.remainingPct)}`}>
            <span className="overview-worst-label">{w.label}</span>
            <span className="overview-worst-value">{w.remainingPct === null ? '—' : `${Math.round(w.remainingPct)}%`}</span>
            <span className="overview-worst-bar">
              <span className={`win-bar-fill ${barClass(w.remainingPct)}`} style={{ width: `${w.remainingPct ?? 0}%` }} />
            </span>
            <span className="overview-worst-src">{w.provider}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function barClass(pct: number | null): string {
  if (pct === null) return 'win-bar-empty';
  if (pct > 50) return 'win-bar-ok';
  if (pct > 20) return 'win-bar-mid';
  return 'win-bar-low';
}

function bandOf(pct: number | null): string {
  if (pct === null) return 'empty';
  if (pct > 50) return 'ok';
  if (pct > 20) return 'mid';
  return 'low';
}
