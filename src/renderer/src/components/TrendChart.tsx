import React from 'react';
import type { TrendPoint } from '../../../shared/types';

/**
 * 历史趋势双 Y 轴折线（SVG）：左轴「已用」#F59E0B，右轴「剩余」#4DA3FF。
 * 每个数据点渲染为 <circle data-testid="trend-point">，便于断言数据点数量随时间范围变化。
 */
export function TrendChart({ points, width = 620, height = 260 }: { points: TrendPoint[]; width?: number; height?: number }): React.ReactElement {
  const padL = 48;
  const padR = 48;
  const padT = 16;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const values = points.flatMap((p) => [p.used, p.remaining]).filter((v): v is number => v !== null);
  const maxV = Math.max(1, ...values);
  const niceMax = niceCeil(maxV);
  const n = points.length;
  const xOf = (i: number): number => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yOf = (v: number): number => padT + innerH - (v / niceMax) * innerH;

  const line = (key: 'used' | 'remaining'): string =>
    points
      .map((p, i) => (p[key] === null ? null : `${xOf(i)},${yOf(p[key]!)}`))
      .filter(Boolean)
      .join(' ');

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg data-testid="trend-chart" width={width} height={height} role="img" aria-label="已用/剩余双轴趋势图">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={padL} x2={width - padR} y1={padT + innerH * (1 - t)} y2={padT + innerH * (1 - t)} stroke="#39424C" strokeDasharray="2 4" />
          <text x={padL - 6} y={padT + innerH * (1 - t) + 4} fontSize={10} fill="#8B95A0" textAnchor="end">
            {(niceMax * t).toFixed(niceMax >= 10 ? 0 : 1)}
          </text>
          <text x={width - padR + 6} y={padT + innerH * (1 - t) + 4} fontSize={10} fill="#8B95A0">
            {(niceMax * t).toFixed(niceMax >= 10 ? 0 : 1)}
          </text>
        </g>
      ))}
      {n > 0 ? (
        <>
          {points.some((p) => p.used !== null) ? <polyline data-testid="trend-line-used" points={line('used')} fill="none" stroke="#F59E0B" strokeWidth={2} /> : null}
          {points.some((p) => p.remaining !== null) ? <polyline data-testid="trend-line-remaining" points={line('remaining')} fill="none" stroke="#4DA3FF" strokeWidth={2} /> : null}
          {points.map((p, i) => (
            <g key={p.collected_at + i}>
              {p.used !== null ? (
                <circle data-testid="trend-point-used" data-ts={p.collected_at} data-value={p.used} cx={xOf(i)} cy={yOf(p.used)} r={3} fill="#F59E0B">
                  <title>{`已用 ${p.used} @ ${new Date(p.collected_at).toLocaleString()}`}</title>
                </circle>
              ) : null}
              {p.remaining !== null ? (
                <circle data-testid="trend-point-remaining" data-ts={p.collected_at} data-value={p.remaining} cx={xOf(i)} cy={yOf(p.remaining)} r={3} fill="#4DA3FF">
                  <title>{`剩余 ${p.remaining} @ ${new Date(p.collected_at).toLocaleString()}`}</title>
                </circle>
              ) : null}
            </g>
          ))}
        </>
      ) : null}
      <text x={12} y={padT + 4} fontSize={11} fill="#F59E0B" fontWeight="600">
        已用
      </text>
      <text x={width - 44} y={padT + 4} fontSize={11} fill="#4DA3FF" fontWeight="600" textAnchor="end">
        剩余
      </text>
      {n > 0 ? (
        <>
          <text x={padL} y={height - 8} fontSize={10} fill="#6B7280">
            {fmtTime(points[0].collected_at)}
          </text>
          <text x={width - padR} y={height - 8} fontSize={10} fill="#6B7280" textAnchor="end">
            {fmtTime(points[n - 1].collected_at)}
          </text>
        </>
      ) : null}
    </svg>
  );
}

function niceCeil(v: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / pow) * pow;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
