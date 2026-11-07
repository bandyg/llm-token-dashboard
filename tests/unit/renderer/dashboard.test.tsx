import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderCard, TrendModal, ManualEntryModal, TodayOverview, EmptyState, DashboardPage } from '../../../src/renderer/src/pages/DashboardPage';
import { OverviewBanner } from '../../../src/renderer/src/components/OverviewBanner';
import { TrendChart } from '../../../src/renderer/src/components/TrendChart';
import { Toasts } from '../../../src/renderer/src/components/common';
import { AppProvider } from '../../../src/renderer/src/store';
import type { ProviderUsageView, QuotaWindow, TrendPoint } from '../../../src/shared/types';

function mkView(patch: Partial<ProviderUsageView> = {}): ProviderUsageView {
  return {
    id: 'prov_x',
    provider_name: 'OpenAI',
    alias: '主号',
    mode: 'api',
    sub_mode: null,
    enabled: 1,
    used: 12.34,
    remaining: 37.66,
    total: 50,
    percent_used: 24.7,
    currency: 'USD',
    source: 'api',
    collected_at: new Date().toISOString(),
    status: 'ok',
    fail_reason: null,
    fail_action: null,
    auth_required: false,
    alert: false,
    alert_threshold: 10,
    progress_band: 'low',
    windows: [],
    subscription: null,
    ...patch,
  };
}

function mkWindow(patch: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    id: 'w1',
    snapshot_id: 's1',
    provider_id: 'prov_x',
    window_key: 'weekly',
    window_label: '每周剩余',
    percent_used: null,
    used: null,
    remaining: null,
    total: null,
    unit: '%',
    reset_at: null,
    collected_at: new Date().toISOString(),
    ...patch,
  };
}

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    trend: vi.fn(async () => [] as TrendPoint[]),
    refreshOne: vi.fn(async () => ({ ok: true })),
    manualEntry: vi.fn(async () => ({ snapshot: { id: 's1' } })),
    loginOpen: vi.fn(async () => ({ webContentsId: 1 })),
    loginComplete: vi.fn(async () => ({ authStatus: 'ok', cookies: 3 })),
    alertEventsList: vi.fn(async () => []),
    providersList: vi.fn(async () => []),
    dashboardUsage: vi.fn(async () => ({ updated_at: '', summary: { used: 0, remaining: 0, currency: 'USD' }, byCurrency: [], providers: [] })),
    settingsGet: vi.fn(async () => ({ strategy: 'batch', batch_size: 5, interval_seconds: 60, min_refresh_seconds: 60, default_alert_threshold: 20, ocr_threshold_default: 0.8, theme: 'light', sync_all_cooldown_ms: 10000 })),
    onEvent: vi.fn(() => () => undefined),
  },
}));

const { api } = await import('../../../src/renderer/src/api');

function withProvider(ui: React.ReactElement): React.ReactElement {
  return React.createElement(AppProvider, null, ui);
}

describe('ProviderCard 货币维度徽章（P1-002）', () => {
  it('USD/CNY/TOKEN 三种 currency 渲染对应 tag-dim 徽章', () => {
    const cases: Array<[string, string]> = [
      ['USD', 'usd'],
      ['CNY', 'cny'],
      ['TOKEN', 'token'],
    ];
    for (const [currency, className] of cases) {
      const { unmount } = render(
        withProvider(
          React.createElement(ProviderCard, {
            p: mkView({ currency, total: null }),
            loading: false, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined,
          }),
        ),
      );
      const badge = screen.getByTestId('currency-badge-prov_x');
      expect(badge.className).toContain(`tag-dim`);
      expect(badge.className).toContain(className);
      expect(badge.textContent).toBe(currency);
      unmount();
    }
  });

  it('COUNT 渲染「次数」中文标签', () => {
    render(
      withProvider(
        React.createElement(ProviderCard, {
          p: mkView({ currency: 'COUNT', total: null }),
          loading: false, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined,
        }),
      ),
    );
    const badge = screen.getByTestId('currency-badge-prov_x');
    expect(badge.className).toContain('count');
    expect(badge.textContent).toBe('次数');
  });

  it('未知 currency 不渲染徽章（不报错）', () => {
    render(
      withProvider(
        React.createElement(ProviderCard, {
          p: mkView({ currency: 'XYZ', total: null }),
          loading: false, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined,
        }),
      ),
    );
    expect(screen.queryByTestId('currency-badge-prov_x')).toBeNull();
  });
});

describe('ProviderCard（P0-001 判据）', () => {
  it('渲染厂商名/状态点/进度条/最近抓取时间与 refresh/edit 按钮 testid', () => {
    render(withProvider(React.createElement(ProviderCard, { p: mkView(), loading: false, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined })));
    expect(screen.getByTestId('card-refresh-prov_x')).toBeInTheDocument();
    expect(screen.getByTestId('card-edit-prov_x')).toBeInTheDocument();
    expect(screen.getByTestId('progress-text-prov_x').textContent).toMatch(/^已用 \$12\.34 \/ \$50\.00（24\.7%）$/);
    expect(screen.getByText(/最近抓取/)).toBeInTheDocument();
  });

  it('进度条三档颜色：<60 蓝 / 60–85 橙 / >85 红（class 断言）', () => {
    const cases: [number, string][] = [[24.7, 'band-low'], [70, 'band-mid'], [90, 'band-high']];
    for (const [pct, band] of cases) {
      const { container, unmount } = render(withProvider(React.createElement(ProviderCard, { p: mkView({ percent_used: pct, progress_band: band.replace('band-', '') as 'low' | 'mid' | 'high' }), loading: false, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined })));
      const fill = container.querySelector('.progress-fill');
      expect(fill?.className).toContain(band);
      unmount();
    }
  });

  it('错误态：红色描边 class + card-error-msg 具体原因 + card-manual-entry 红字按钮', () => {
    const { container } = render(withProvider(React.createElement(ProviderCard, { p: mkView({ status: 'failed', fail_reason: 'DOM 选择器失效：未在页面中命中元素' }), loading: false, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined })));
    expect(container.querySelector('.provider-card')?.className).toContain('failed');
    expect(screen.getByTestId('card-error-msg-prov_x').textContent).toContain('DOM 选择器失效');
    expect(screen.getByTestId('card-manual-entry-prov_x').className).toContain('btn-danger');
    expect(screen.getByTestId('card-error-msg-prov_x').textContent).toContain('⚠️ 抓取失败');
  });

  it('未登录态：.auth-required 与「🔐 请手动登录」', () => {
    render(withProvider(React.createElement(ProviderCard, { p: mkView({ status: 'failed', auth_required: true, fail_reason: '🔐 请手动登录' }), loading: false, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined })));
    const el = screen.getByTestId('card-auth-prov_x');
    expect(el.className).toContain('auth-required');
    expect(el.textContent).toContain('🔐 请手动登录');
  });

  it('告警行：.alert-bg + 「告警」状态标签（background 红色系在 E2E 验证计算值）', () => {
    const { container } = render(withProvider(React.createElement(ProviderCard, { p: mkView({ alert: true, remaining: 5, alert_threshold: 10 }), loading: false, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined })));
    expect(container.querySelector('.provider-card')?.className).toContain('alert-bg');
    expect(screen.getByText('告警')).toBeInTheDocument();
  });

  it('加载态骨架屏', () => {
    const { container } = render(withProvider(React.createElement(ProviderCard, { p: mkView(), loading: true, checked: false, onCheck: () => undefined, onClick: () => undefined, onDoubleClick: () => undefined, onManualEntry: () => undefined, onLogin: () => undefined, onRefresh: () => undefined, onContextMenu: () => undefined })));
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThanOrEqual(2);
  });
});

describe('TrendChart / TrendModal（P0-001：双 Y 轴、时间范围切换点数变化、invalid 不绘制）', () => {
  beforeEach(() => {
    vi.mocked(api.trend).mockReset();
  });

  it('图表渲染 used/remaining 两条曲线与等量数据点', () => {
    const pts: TrendPoint[] = [
      { collected_at: '2026-10-01T00:00:00Z', used: 1, remaining: 9, source: 'api' },
      { collected_at: '2026-10-02T00:00:00Z', used: 2, remaining: 8, source: 'api' },
      { collected_at: '2026-10-03T00:00:00Z', used: 3, remaining: 7, source: 'ocr' },
    ];
    const { container } = render(React.createElement(TrendChart, { points: pts }));
    expect(container.querySelector('[data-testid="trend-line-used"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="trend-line-remaining"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="trend-point-used"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-testid="trend-point-remaining"]')).toHaveLength(3);
  });

  it('切 24h/7d/30d 后数据点数随之变化（api.trend 返回不同长度）', async () => {
    vi.mocked(api.trend).mockImplementation(async (q) =>
      Array.from({ length: q.range === '24h' ? 4 : q.range === '7d' ? 9 : 21 }, (_, i) => ({ collected_at: `t${i}`, used: i, remaining: 100 - i, source: 'api' as const })),
    );
    render(withProvider(React.createElement(TrendModal, { provider: mkView(), onClose: () => undefined })));
    await waitFor(() => expect(screen.getByTestId('trend-point-count').textContent).toContain('数据点 9'));
    fireEvent.click(screen.getByRole('radio', { name: '24h' }));
    await waitFor(() => expect(screen.getByTestId('trend-point-count').textContent).toContain('数据点 4'));
    fireEvent.click(screen.getByRole('radio', { name: '30d' }));
    await waitFor(() => expect(screen.getByTestId('trend-point-count').textContent).toContain('数据点 21'));
    // 断言调用链：SQL 层 WHERE status='valid' 由 snapshots.history 保证（见 db.test）
    expect(api.trend).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'prov_x' }));
  });

  it('无有效快照：空态「暂无趋势数据」+ 引导按钮', async () => {
    vi.mocked(api.trend).mockResolvedValue([]);
    render(withProvider(React.createElement(TrendModal, { provider: mkView(), onClose: () => undefined })));
    await waitFor(() => expect(screen.getByTestId('trend-empty')).toBeInTheDocument());
    expect(screen.getByText('暂无趋势数据')).toBeInTheDocument();
  });
});

describe('ManualEntryModal（≤3 次点击兜底）', () => {
  beforeEach(() => {
    vi.mocked(api.manualEntry).mockClear();
  });
  it('预填最近快照值，manual-save 提交调用 manualEntry 且生成 valid 快照', async () => {
    render(withProvider(React.createElement(ManualEntryModal, { provider: mkView({ status: 'failed', fail_reason: 'x', used: 12.34 }), onClose: () => undefined, onSaved: async () => undefined })));
    const amount = screen.getByTestId('manual-amount') as HTMLInputElement;
    expect(amount.value).toContain('12.34');
    expect(screen.getByTestId('manual-mode')).toBeInTheDocument();
    expect(screen.getByTestId('manual-time')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('manual-save'));
    await waitFor(() => expect(api.manualEntry).toHaveBeenCalledWith('prov_x', expect.objectContaining({ mode: 'used', amount: 12.34 })));
  });

  it('负数拦截：红色 toast「数值异常，请确认」', async () => {
    render(withProvider(React.createElement(React.Fragment, null,
      React.createElement(ManualEntryModal, { provider: mkView({ used: 5 }), onClose: () => undefined, onSaved: async () => undefined }),
      React.createElement(Toasts),
    )));
    const amount = screen.getByTestId('manual-amount') as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '-3' } });
    fireEvent.click(screen.getByTestId('manual-save'));
    await waitFor(() => expect(screen.getByTestId('toast-error')).toBeInTheDocument());
    expect(screen.getByTestId('toast-error').textContent).toContain('数值异常');
    expect(api.manualEntry).not.toHaveBeenCalled();
  });
});

describe('EmptyState（P0-001 空态插画判据）', () => {
  it('渲染空态插画元素（svg[role=img]）+ 引导文案 + empty-add-provider 主按钮', () => {
    render(withProvider(React.createElement(EmptyState, { hasAnyProvider: false, searchActive: false })));
    // 插画元素本体存在：svg 标签、role=img、可访问名称
    const illo = screen.getByTestId('empty-illustration');
    expect(illo.tagName.toLowerCase()).toBe('svg');
    expect(illo.getAttribute('role')).toBe('img');
    expect(illo.getAttribute('aria-label')).toContain('空态插画');
    expect(screen.getByText('还没有配置任何 LLM 提供商，点击右上角添加')).toBeInTheDocument();
    const btn = screen.getByTestId('empty-add-provider');
    expect(btn.tagName.toLowerCase()).toBe('button');
    expect(btn.textContent).toContain('添加 Provider');
  });

  it('有 Provider 全禁用 / 搜索无结果时文案切换且不渲染添加按钮', () => {
    const { unmount } = render(withProvider(React.createElement(EmptyState, { hasAnyProvider: true, searchActive: false })));
    expect(screen.getByText('所有提供商均已禁用，启用后即可在这里看到额度')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-add-provider')).toBeNull();
    unmount();
    render(withProvider(React.createElement(EmptyState, { hasAnyProvider: false, searchActive: true })));
    expect(screen.getByText('没有匹配搜索条件的提供商')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-add-provider')).toBeNull();
  });
});

describe('Dashboard 货币分桶汇总（P1-002 多维度场景）', () => {
  it('多 currency（USD/CNY/TOKEN）分桶渲染,每个 bucket 一个 tag-dim 徽章 + provider_count 注脚', async () => {
    vi.mocked(api.dashboardUsage).mockResolvedValue({
      updated_at: new Date().toISOString(),
      summary: { used: 0, remaining: 0, currency: 'USD' }, // 多维度时 summary 数值无意义
      byCurrency: [
        { currency: 'USD', used: 12.34, remaining: 37.66, total: 50, provider_count: 1 },
        { currency: 'CNY', used: 50, remaining: 78.4, total: 128.4, provider_count: 1 },
        { currency: 'TOKEN', used: 21200000, remaining: 18800000, total: 40000000, provider_count: 1 },
      ],
      providers: [],
    });
    // 触发一次 refresh 让 store 取到 mock 数据
    render(withProvider(React.createElement(DashboardPage, { search: '', onContextMenu: () => undefined, selectedIds: [], onSelectedChange: () => undefined })));
    await waitFor(() => expect(screen.getByTestId('summary-by-currency')).toBeInTheDocument());
    const summary = screen.getByTestId('summary-by-currency');
    expect(summary.textContent).toContain('USD');
    expect(summary.textContent).toContain('CNY');
    expect(summary.textContent).toContain('TOKEN');
    // token 维度 M 单位
    expect(summary.textContent).toMatch(/已用 21\.20M/);
    // 1 个 provider 不显示「N 个」
    expect(summary.textContent).not.toContain('（1 个）');
  });

  it('单维度(provider_count=3)显示「3 个」注脚', async () => {
    vi.mocked(api.dashboardUsage).mockResolvedValue({
      updated_at: new Date().toISOString(),
      summary: { used: 100, remaining: 200, currency: 'USD' },
      byCurrency: [{ currency: 'USD', used: 100, remaining: 200, total: 300, provider_count: 3 }],
      providers: [],
    });
    render(withProvider(React.createElement(DashboardPage, { search: '', onContextMenu: () => undefined, selectedIds: [], onSelectedChange: () => undefined })));
    await waitFor(() => expect(screen.getByTestId('summary-by-currency').textContent).toContain('（3 个）'));
  });
});

describe('OverviewBanner（耗尽的 0% 窗口不上总览）', () => {
  it('剩余 0% 的窗口不进总览排名，也不再计入「不足 20%」', () => {
    const providers = [
      // 智谱：5 小时还有量（0% 已用），每周已耗尽（0% 剩余）——后者不应出现
      mkView({
        id: 'p_zhipu', provider_name: '智谱', percent_used: null, used: null, remaining: null, total: null,
        windows: [
          mkWindow({ id: 'w1', window_key: 'five_hour', window_label: '5 小时剩余', percent_used: 0 }),
          mkWindow({ id: 'w2', window_key: 'weekly', window_label: '每周剩余', percent_used: 100 }),
        ],
      }),
      // OpenCode Go：唯一窗口每月已耗尽 → 整家不出现在总览
      mkView({
        id: 'p_ocg', provider_name: 'OpenCode Go', percent_used: null, used: null, remaining: null, total: null,
        windows: [mkWindow({ id: 'w3', window_key: 'monthly', window_label: '每月剩余', percent_used: 100 })],
      }),
      // MiniMax：周剩 79%，是过滤后最紧的窗口
      mkView({
        id: 'p_mm', provider_name: 'MiniMax', percent_used: null, used: null, remaining: null, total: null,
        windows: [mkWindow({ id: 'w4', window_key: 'weekly', window_label: '周剩余', percent_used: 21 })],
      }),
    ];
    render(React.createElement(OverviewBanner, { providers }));
    const banner = screen.getByTestId('overview-banner');
    // 过滤后最紧的两个窗口：MiniMax 周 79%、智谱 5 小时 100%；两个 0% 窗口（智谱每周、OpenCode 每月）都不出现
    const vals = Array.from(banner.querySelectorAll('.overview-worst-value')).map((el) => el.textContent);
    expect(vals).toEqual(['79%', '100%']);
    const srcs = Array.from(banner.querySelectorAll('.overview-worst-src')).map((el) => el.textContent);
    expect(srcs).toEqual(['MiniMax', '智谱']);
    expect(banner.textContent).not.toContain('OpenCode');
    // 两个 0% 窗口不再计入「不足 20%」→ 整体水位正常
    expect(banner.textContent).toContain('整体水位正常');
  });

  it('所有窗口都耗尽时整个横幅隐藏', () => {
    const providers = [
      mkView({
        id: 'p_zhipu', provider_name: '智谱', percent_used: null, used: null, remaining: null, total: null,
        windows: [mkWindow({ id: 'w1', percent_used: 100 })],
      }),
      mkView({
        id: 'p_ocg', provider_name: 'OpenCode Go', percent_used: null, used: null, remaining: null, total: null,
        windows: [mkWindow({ id: 'w2', percent_used: 100 })],
      }),
    ];
    const { container } = render(React.createElement(OverviewBanner, { providers }));
    expect(screen.queryByTestId('overview-banner')).toBeNull();
    expect(container.querySelector('.overview-worst')).toBeNull();
  });
});

describe('Dashboard 卡片按剩余量排序（耗尽沉底）', () => {
  it('余量多的在前；0% 沉底；无百分比数据（纯余额/未采集）排中间档', async () => {
    const mk = (id: string, patch: Partial<ProviderUsageView> = {}): ProviderUsageView =>
      mkView({ id, provider_name: id, percent_used: null, used: null, remaining: null, total: null, windows: [], ...patch });
    // 故意按「期望顺序的倒序」摆放，验证排序真的生效
    const providers = [
      mk('p_dead', { windows: [mkWindow({ id: 'wd1', window_key: 'weekly', percent_used: 100 })] }), // 最紧窗口 0% → 沉底
      mk('p_unknown'),                                                                               // 无任何百分比依据
      mk('p_high', { percent_used: 20, used: 10, remaining: 40, total: 50 }),                        // 剩 80%
      mk('p_mid', { windows: [mkWindow({ id: 'wm1', window_key: 'weekly', percent_used: 21 })] }),   // 最紧窗口剩 79%
    ];
    vi.mocked(api.dashboardUsage).mockResolvedValue({
      updated_at: new Date().toISOString(),
      summary: { used: 0, remaining: 0, currency: 'USD' },
      byCurrency: [],
      providers,
    });
    render(withProvider(React.createElement(DashboardPage, { search: '', onContextMenu: () => undefined, selectedIds: [], onSelectedChange: () => undefined })));
    await waitFor(() => expect(screen.getByTestId('provider-grid')).toBeInTheDocument());
    const ids = Array.from(
      screen.getByTestId('provider-grid').querySelectorAll('[data-testid^="provider-card-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['provider-card-p_high', 'provider-card-p_mid', 'provider-card-p_unknown', 'provider-card-p_dead']);
  });
});

describe('TodayOverview（P0-003：卡片进度条与今日用量概览同步更新）', () => {
  it('渲染每行 provider 条形与用量文本', () => {
    render(withProvider(React.createElement(TodayOverview, { items: [mkView()] })));
    expect(screen.getByTestId('today-overview')).toBeInTheDocument();
    expect(screen.getByTestId('overview-bar-prov_x').textContent).toContain('已用 $12.34');
  });

  it('无数据时显示引导文案', () => {
    render(withProvider(React.createElement(TodayOverview, { items: [mkView({ used: null })] })));
    expect(screen.getByText(/暂无数据/)).toBeInTheDocument();
  });
});
