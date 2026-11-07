import React, { useEffect, useMemo, useState } from 'react';
import type { DomSelector, ProviderConfig, ProviderMode, ProviderSubMode } from '../../../shared/types';
import { api } from '../api';
import { useApp } from '../store';
import { navigate } from '../App';
import { Modal, Segmented, Spinner } from '../components/common';
import { TEMPLATES, templateById } from '../../../shared/templates';
import { fmtSnapshotDetail } from '../utils';

type Tab = 'basic' | 'credential' | 'capture' | 'region';

interface FormState {
  id?: string;
  provider_name: string;
  alias: string;
  template: string;
  mode: ProviderMode;
  sub_mode: ProviderSubMode | null;
  adapter: string | null;
  enabled: boolean;
  base_url: string;
  dom_url: string;
  dom_script: string;
  selectors: DomSelector[];
  ocr_threshold: number;
  quota_total: string;
  currency: string;
  alert_threshold: string;
  login_required_selector: string;
  region: { x: number; y: number; w: number; h: number } | null;
}

function formFrom(p: ProviderConfig | null): FormState {
  return {
    id: p?.id,
    provider_name: p?.provider_name ?? '',
    alias: p?.alias ?? '',
    template: p?.template ?? 'custom',
    mode: p?.mode ?? 'api',
    sub_mode: p?.sub_mode ?? null,
    adapter: p?.adapter ?? null,
    enabled: p?.enabled === 1 || !p,
    base_url: p?.base_url ?? '',
    dom_url: p?.dom_url ?? p?.page_url ?? '',
    dom_script: p?.dom_script ?? '',
    selectors: p?.selectors ?? [],
    ocr_threshold: p?.ocr_threshold ?? 0.8,
    quota_total: p?.quota_total == null ? '' : String(p.quota_total),
    currency: p?.currency ?? 'USD',
    alert_threshold: String(p?.alert_threshold ?? ''),
    login_required_selector: p?.login_required_selector ?? '',
    region: p?.region ?? null,
  };
}

export function ProvidersPage({ editId }: { editId?: string }): React.ReactElement {
  const { providers, pushToast, refreshProviders, refreshUsage } = useApp();
  const [editing, setEditing] = useState<FormState | null>(editId ? null : formFrom(null));

  useEffect(() => {
    if (editId) {
      void api.providerGet(editId).then((p) => setEditing(formFrom(p)));
    }
  }, [editId]);

  const startNew = (templateId: string): void => {
    const t = templateById(templateId);
    setEditing({
      ...formFrom(null),
      template: t.id,
      provider_name: t.id === 'custom' ? '' : t.name,
      mode: t.modes.includes('api') ? 'api' : 'web_crawl',
      sub_mode: t.modes.includes('api') ? null : 'ocr',
      adapter: t.adapter,
      base_url: t.baseUrl,
      dom_url: t.domUrl ?? t.pageUrl,
      selectors: t.selectors,
      login_required_selector: t.loginRequiredSelector ?? '',
      quota_total: t.quotaTotal === null ? '' : String(t.quotaTotal),
      currency: t.currency,
      alert_threshold: t.quotaTotal === null ? '' : String(Math.round(t.quotaTotal * 0.2 * 100) / 100),
      ocr_threshold: 0.8,
    });
  };

  return (
    <div style={{ display: 'flex', gap: 0, margin: -24, height: 'calc(100% + 48px)' }}>
      <aside className="selectable-list" aria-label="厂商模板列表">
        <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>厂商模板</h3>
          <button className="btn-primary icon-btn" data-testid="provider-add" onClick={() => startNew('custom')}>
            ＋ 新增
          </button>
        </div>
        {TEMPLATES.map((t) => (
          <div key={t.id} className="tpl" tabIndex={0} role="button" onClick={() => startNew(t.id)} onKeyDown={(e) => e.key === 'Enter' && startNew(t.id)}>
            <div style={{ fontWeight: 600 }}>{t.name}</div>
            <div className="hint">{t.note}</div>
          </div>
        ))}
        <div style={{ padding: '16px' }}>
          <h3>已配置（{providers.length}）</h3>
          {providers.map((p) => (
            <div key={p.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.provider_name}
                {p.alias ? <span className="hint">（{p.alias}）</span> : null}
              </span>
              <span className={`tag ${p.enabled ? 'ok' : ''}`}>{p.enabled ? '启用' : '停用'}</span>
              <button className="icon-btn" data-testid={`provider-row-edit-${p.id}`} onClick={() => void api.providerGet(p.id).then((x) => x && setEditing(formFrom(x)))}>
                ✎
              </button>
            </div>
          ))}
        </div>
      </aside>
      <section style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {!editing ? (
          <div className="empty-state">
            <p>选一个厂商模板开始配置，或点击右上角「＋ 新增」自定义。</p>
          </div>
        ) : (
          <ProviderForm
            form={editing}
            onChange={setEditing}
            onClose={() => {
              setEditing(null);
              navigate('#/providers');
            }}
            onSaved={async () => {
              await refreshProviders();
              await refreshUsage();
            }}
            pushToast={pushToast}
          />
        )}
      </section>
    </div>
  );
}

function ProviderForm({
  form,
  onChange,
  onClose,
  onSaved,
  pushToast,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  pushToast: ReturnType<typeof useApp>['pushToast'];
}): React.ReactElement {
  const [tab, setTab] = useState<Tab>('basic');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [credShown, setCredShown] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [credResult, setCredResult] = useState<{
    ok: boolean;
    message: string;
    endpoint?: string;
    auth_scheme?: 'bearer' | 'x-api-key';
    adapter_id?: string;
    status?: number;
    account?: string;
  } | null>(null);
  const [selectorMiss, setSelectorMiss] = useState<string | null>(null);
  const [timeoutAsk, setTimeoutAsk] = useState<{ resolve: (v: boolean) => void } | null>(null);
  const errors = useMemo(() => validate(form), [form]);

  const patch = (p: Partial<FormState>): void => onChange({ ...form, ...p });

  const applyTemplate = (templateId: string): void => {
    const t = templateById(templateId);
    patch({
      template: t.id,
      provider_name: t.id === 'custom' ? form.provider_name : t.name,
      mode: t.modes.includes('api') ? 'api' : 'web_crawl',
      sub_mode: t.modes.includes('api') ? null : 'ocr',
      adapter: t.adapter,
      base_url: t.baseUrl,
      dom_url: t.domUrl ?? t.pageUrl,
      selectors: t.selectors,
      login_required_selector: t.loginRequiredSelector ?? '',
      currency: t.currency,
    });
  };

  const doTestConnection = async (): Promise<void> => {
    setTesting(true);
    setCredResult(null);
    const buildResult = (r: Awaited<ReturnType<typeof api.credentialTest>>): typeof credResult => ({
      ok: r.ok,
      message: r.ok ? `连接成功${r.account ? `（账号 ${r.account}）` : ''}` : r.message,
      endpoint: r.endpoint,
      auth_scheme: r.auth_scheme,
      adapter_id: r.adapter_id,
      status: r.status,
      account: r.account,
    });
    try {
      const timeout = new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('TEST_TIMEOUT')), 10000));
      const r = await Promise.race([api.credentialTest({ adapter: form.adapter ?? 'openai', baseUrl: form.base_url, apiKey: apiKeyInput }), timeout]);
      setCredResult(buildResult(r));
    } catch (e) {
      if ((e as Error).message === 'TEST_TIMEOUT') {
        // 测试连接超时 10s 弹窗询问「继续等待/跳过」
        const keep = await new Promise<boolean>((resolve) => setTimeoutAsk({ resolve }));
        setTimeoutAsk(null);
        if (keep) {
          try {
            const r = await api.credentialTest({ adapter: form.adapter ?? 'openai', baseUrl: form.base_url, apiKey: apiKeyInput, template: form.template })
            setCredResult(buildResult(r));
          } catch (e2) {
            setCredResult({ ok: false, message: (e2 as Error).message });
          }
        } else {
          setCredResult({ ok: false, message: '已跳过本次测试' });
        }
      } else {
        setCredResult({ ok: false, message: (e as Error).message });
      }
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    if (Object.keys(errors).length) {
      pushToast({ type: 'error', message: '表单校验未通过', detail: Object.values(errors)[0] });
      return;
    }
    setSaving(true);
    try {
      const payload: Partial<ProviderConfig> & { provider_name: string } = {
        provider_name: form.provider_name.trim(),
        alias: form.alias.trim(),
        template: form.template,
        mode: form.mode,
        sub_mode: form.mode === 'web_crawl' ? form.sub_mode : null,
        adapter: form.mode === 'api' ? form.adapter : null,
        enabled: form.enabled ? 1 : 0,
        base_url: form.base_url || null,
        dom_url: form.dom_url || null,
        dom_script: form.dom_script || null,
        selectors: form.selectors,
        ocr_threshold: form.ocr_threshold,
        quota_total: form.quota_total ? Number(form.quota_total) : null,
        currency: form.currency,
        alert_threshold: form.alert_threshold ? Number(form.alert_threshold) : 0,
        login_required_selector: form.login_required_selector || null,
      };
      const saved = form.id ? await api.providerUpdate(form.id, payload) : await api.providerCreate(payload);
      if (apiKeyInput.trim()) {
        await api.credentialSet(saved.id, apiKeyInput.trim());
      }
      pushToast({ type: 'success', message: '配置已保存，正在执行一次抓取以验证…' });
      await onSaved();
      // 保存后立即执行一次抓取验证（force=true 绕开 60s 节流，因为用户刚保存就期望看到结果）
      if (saved.enabled && saved.mode !== 'manual') {
        void api
          .refreshOne(saved.id, { force: true })
          .then((r) => {
            if (r.ok && r.snapshot) {
              const detail = fmtSnapshotDetail(r.snapshot);
              pushToast({ type: 'success', message: '已采集', detail: detail ?? undefined });
            } else if (!r.ok && r.reason) {
              pushToast({ type: r.reason.includes('频繁') ? 'warning' : 'error', message: r.reason });
            }
          })
          .finally(() => onSaved());
      }
      if (!form.id) navigate(`#/providers/${saved.id}`);
    } catch (e) {
      pushToast({ type: 'error', message: '保存失败', detail: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl+S 保存，Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      } else if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const captureModeValue: 'api' | 'dom' | 'ocr' | 'manual' =
    form.mode === 'api' ? 'api' : form.mode === 'manual' ? 'manual' : form.sub_mode === 'dom' ? 'dom' : 'ocr';

  // 当前模板与兼容 mode（用于 radio 灰掉不兼容项 + 模板切换时回弹）
  const currentTemplate = useMemo(() => templateById(form.template), [form.template]);
  const supportsApi = currentTemplate.modes.includes('api');
  const supportsWebCrawl = currentTemplate.modes.includes('web_crawl');
  const supportsManual = currentTemplate.modes.includes('manual');

  // 模板切换时：若当前 mode 不在新模板兼容列表，回弹到第一个兼容 mode 并 toast 提示
  useEffect(() => {
    const tmplModes = currentTemplate.modes;
    const compatible = form.mode === 'api'
      ? tmplModes.includes('api')
      : form.mode === 'manual'
        ? tmplModes.includes('manual')
        : tmplModes.includes('web_crawl');
    if (compatible) return;
    type Fallback = { mode: 'api' | 'web_crawl' | 'manual'; sub_mode: 'ocr' | 'dom' | null };
    const fallback: Fallback = tmplModes.includes('api')
      ? { mode: 'api', sub_mode: null }
      : tmplModes.includes('web_crawl')
        ? { mode: 'web_crawl', sub_mode: 'ocr' }
        : { mode: 'manual', sub_mode: null };
    const newLabel = fallback.mode === 'api' ? '官方 API' : fallback.mode === 'manual' ? '仅手动录入' : 'BrowserView OCR';
    pushToast({ type: 'warning', message: `已切换到「${newLabel}」（当前模板「${currentTemplate.name}」不支持原模式）` });
    patch(fallback);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.template]);

  return (
    <div data-testid="provider-form">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ flex: 1 }}>{form.id ? '编辑提供商' : '新增提供商'}</h1>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => patch({ enabled: e.target.checked })} aria-label="启用该提供商" />
          启用
        </label>
        <button className="btn-primary" data-testid="provider-save" onClick={() => void save()} disabled={saving}>
          {saving ? <Spinner /> : null} 保存（Ctrl+S）
        </button>
        <button onClick={onClose}>关闭（Esc）</button>
      </div>

      <div className="tabs" role="tablist">
        {([['basic', '基本信息'], ['credential', '凭据'], ['capture', '抓取方式'], ['region', '区域选择']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'basic' ? (
        <div>
          <div className="form-row">
            <label htmlFor="pf-name">厂商显示名 *</label>
            <input id="pf-name" value={form.provider_name} onChange={(e) => patch({ provider_name: e.target.value })} aria-label="厂商显示名" />
            {errors.provider_name ? <span className="field-error">{errors.provider_name}</span> : null}
          </div>
          <div className="form-row">
            <label htmlFor="pf-alias">记录别名（多账号区分，同一厂商可建多条）</label>
            <input id="pf-alias" value={form.alias} placeholder="如：主号 / 小号" onChange={(e) => patch({ alias: e.target.value })} aria-label="记录别名" />
          </div>
          <div className="form-row">
            <label htmlFor="pf-template">厂商模板</label>
            <select id="pf-template" value={form.template} onChange={(e) => applyTemplate(e.target.value)} aria-label="厂商模板">
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="pf-total">额度总额（可选，用于计算剩余与百分比）</label>
            <input id="pf-total" value={form.quota_total} inputMode="decimal" onChange={(e) => patch({ quota_total: e.target.value })} aria-label="额度总额" />
          </div>
          <div className="form-row">
            <label htmlFor="pf-currency">货币单位</label>
            <select id="pf-currency" value={form.currency} onChange={(e) => patch({ currency: e.target.value })} aria-label="货币单位">
              <option value="USD">USD ($)</option>
              <option value="CNY">CNY (¥)</option>
              <option value="CREDIT">积分</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="pf-alert">告警阈值（剩余 ≤ 该值时整行红色告警）</label>
            <input id="pf-alert" value={form.alert_threshold} inputMode="decimal" onChange={(e) => patch({ alert_threshold: e.target.value })} aria-label="告警阈值" />
          </div>
        </div>
      ) : null}

      {tab === 'credential' ? (
        <div>
          {form.mode !== 'api' ? <p className="hint">当前采集模式不是「官方 API」，凭据仅用于测试参考。</p> : null}
          <div className="form-row">
            <label htmlFor="pf-baseurl">Base URL</label>
            <input id="pf-baseurl" value={form.base_url} onChange={(e) => patch({ base_url: e.target.value })} aria-label="Base URL" />
          </div>
          <div className="form-row">
            <label htmlFor="pf-apikey">API Key</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="pf-apikey"
                data-testid="cred-apikey"
                type={credShown ? 'text' : 'password'}
                value={apiKeyInput}
                placeholder="粘贴后自动去空白；仅加密保存在本机"
                onChange={(e) => setApiKeyInput(e.target.value)}
                aria-label="API Key"
                style={{ flex: 1 }}
              />
              <button className="icon-btn" aria-label={credShown ? '隐藏' : '显示'} onClick={() => setCredShown((v) => !v)}>
                {credShown ? '🙈' : '👁️'}
              </button>
              <button onClick={() => void doTestConnection()} disabled={testing || !apiKeyInput} data-testid="cred-test">
                {testing ? <Spinner dark /> : null} 测试连接
              </button>
            </div>
            {credResult ? (
              <div data-testid="cred-result" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span className={credResult.ok ? 'tag ok' : 'field-error'}>
                  {credResult.ok ? '✓ ' : '❌ '}
                  {credResult.message}
                </span>
                {(credResult.endpoint || credResult.adapter_id || credResult.status) ? (
                  <span className="hint" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                    {[credResult.endpoint, credResult.adapter_id && `adapter=${credResult.adapter_id}`, credResult.status && `HTTP ${credResult.status}`, credResult.auth_scheme && `auth=${credResult.auth_scheme}`].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <p className="hint">凭据经系统 safeStorage 加密存储于本机；数据库仅保存指针，明文永不落盘。</p>
        </div>
      ) : null}

      {tab === 'capture' ? (
        <div>
          <div className="form-row">
            <label>采集模式（判据：mode=api|web_crawl|manual，web_crawl 下 sub_mode=dom|ocr）</label>
            <div className="radio-group" role="radiogroup" aria-label="采集模式" data-testid="capture-mode">
              {([
                ['api', '官方 API（自动）', supportsApi],
                ['dom', 'BrowserView DOM 抓取', supportsWebCrawl],
                ['ocr', 'BrowserView OCR 抓取', supportsWebCrawl],
                ['manual', '仅手动录入', supportsManual],
              ] as Array<[typeof captureModeValue, string, boolean]>).map(([v, label, enabled]) => (
                <label
                  key={v}
                  title={enabled ? undefined : `模板「${currentTemplate.name}」不支持此模式（modes: ${currentTemplate.modes.join('/')}）`}
                  style={{ opacity: enabled ? 1 : 0.45, cursor: enabled ? 'pointer' : 'not-allowed' }}
                >
                  <input
                    type="radio"
                    name="capture-mode"
                    checked={captureModeValue === v}
                    disabled={!enabled}
                    onChange={() => {
                      if (v === 'api') patch({ mode: 'api', sub_mode: null });
                      else if (v === 'manual') patch({ mode: 'manual', sub_mode: null });
                      else patch({ mode: 'web_crawl', sub_mode: v });
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* 模式上下文「下一步该做什么」具体提示 */}
          {form.mode === 'api' ? (
            <p className="hint">需在「凭据」页填 baseUrl + API Key，点「测试连接」看到端点和账号后再保存。</p>
          ) : form.mode === 'manual' ? (
            <p className="hint">无需配置。保存后在 Dashboard 卡片右上角「手动录入」填入已用/剩余数值生成有效快照。</p>
          ) : form.sub_mode === 'dom' ? (
            <p className="hint">需在「抓取」页填 dom_url 并补 DOM 选择器；保存后自动验证抓取，OCR 阈值/区域在「区域选择」配置。</p>
          ) : (
            <p className="hint">需在「抓取」页填 dom_url，「区域选择」页框选控制台配额区域，OCR 自动识别区域数字。</p>
          )}

          {form.mode === 'api' ? (
            <p className="hint">官方 API 模式：内置适配器 openai / anthropic / azure-openai / deepseek。请在「凭据」页配置 Key 并测试连接。</p>
          ) : form.mode === 'manual' ? (
            <p className="hint">仅手动录入：不执行任何自动采集，可在 Dashboard 卡片「手动录入」生成有效快照。</p>
          ) : (
            <>
              <div className="form-row">
                <label htmlFor="pf-domurl">控制台页面 URL</label>
                <input id="pf-domurl" data-testid="dom-url" value={form.dom_url} onChange={(e) => patch({ dom_url: e.target.value })} aria-label="控制台页面 URL" />
              </div>
              {form.sub_mode === 'dom' ? (
                <>
                  <div className="form-row">
                    <label>选择器列表（名称 + CSS 选择器）</label>
                    {form.selectors.map((s, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }} data-testid={`dom-selector-row-${i}`}>
                        <input value={s.name} style={{ width: 120 }} aria-label={`选择器 ${i + 1} 名称`} onChange={(e) => patch({ selectors: form.selectors.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                        <input value={s.selector} style={{ flex: 1 }} className="mono" aria-label={`选择器 ${i + 1} CSS`} onChange={(e) => patch({ selectors: form.selectors.map((x, j) => (j === i ? { ...x, selector: e.target.value } : x)) })} />
                        <button className="icon-btn" onClick={() => pushToast({ type: 'info', message: '请在区域选择器预览中查看高亮' })}>
                          在预览中高亮
                        </button>
                        <button className="icon-btn" aria-label="删除选择器" onClick={() => patch({ selectors: form.selectors.filter((_, j) => j !== i) })}>
                          🗑
                        </button>
                      </div>
                    ))}
                    <button className="icon-btn" onClick={() => patch({ selectors: [...form.selectors, { name: `字段 ${form.selectors.length + 1}`, selector: '' }] })}>
                      ＋ 添加选择器
                    </button>
                    <button
                      className="icon-btn"
                      onClick={async () => {
                        // 校验选择器是否命中（用无头加载 + executeJavaScript 模拟）
                        try {
                          const r = await api.browserCheckAuth(form.id ?? '');
                          setSelectorMiss(r.loginRequired ? '页面需要登录，选择器校验已跳过' : null);
                        } catch {
                          setSelectorMiss('选择器在当前页面未找到元素');
                        }
                      }}
                    >
                      校验选择器
                    </button>
                    {selectorMiss ? (
                      <span className="field-error" data-testid="selector-miss">
                        {selectorMiss}
                        <button className="icon-btn" onClick={() => form.id && navigate(`#/region/${form.id}`)}>
                          打开浏览器调试
                        </button>
                      </span>
                    ) : null}
                  </div>
                  <div className="form-row">
                    <label htmlFor="pf-domscript">自定义 dom_script（可选，静态表达式，仅读取文本）</label>
                    <textarea id="pf-domscript" className="mono" rows={3} value={form.dom_script} onChange={(e) => patch({ dom_script: e.target.value })} aria-label="自定义 DOM 提取脚本" />
                    <span className="hint">禁止 eval / new Function / 远程脚本；保存时自动校验。</span>
                  </div>
                  <div className="form-row">
                    <label>登录态 Cookie</label>
                    <button
                      onClick={() => {
                        if (form.id) void api.loginOpen(form.id);
                        else pushToast({ type: 'warning', message: '请先保存配置再导入 Cookie' });
                      }}
                    >
                      导入 / 打开浏览器登录
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="form-row">
                    <label>OCR 选区（{form.region ? `x=${form.region.x}, y=${form.region.y}, w=${form.region.w}, h=${form.region.h}` : '尚未框选'}）</label>
                    <button className="btn-primary" data-testid="region-open-browser" onClick={() => form.id && navigate(`#/region/${form.id}`)} disabled={!form.id}>
                      🖼️ 打开浏览器捕获（拖拽框选，免手填坐标）
                    </button>
                    {!form.id ? <span className="hint">请先保存以生成记录，再打开区域选择器。</span> : null}
                  </div>
                  <div className="form-row">
                    <label htmlFor="pf-ocr-th">OCR 置信度阈值（低于判定抓取失败，不生成快照）</label>
                    <input id="pf-ocr-th" type="number" min={0} max={1} step={0.05} value={form.ocr_threshold} onChange={(e) => patch({ ocr_threshold: Number(e.target.value) })} aria-label="OCR 置信度阈值" />
                  </div>
                </>
              )}
              <div className="form-row">
                <label htmlFor="pf-login-sel">未登录检测选择器（可选）</label>
                <input id="pf-login-sel" className="mono" value={form.login_required_selector} onChange={(e) => patch({ login_required_selector: e.target.value })} aria-label="未登录检测选择器" />
              </div>
            </>
          )}
          {errors.mode ? <span className="field-error">{errors.mode}</span> : null}
        </div>
      ) : null}

      {tab === 'region' ? (
        <div>
          <p>在 BrowserView 页面上像截图工具一样拖拽框选 OCR 区域，坐标自动回填并持久化（一次配置、终身复用）。</p>
          <div className="form-row">
            <label>当前主选区</label>
            <span className="mono" data-testid="region-value">
              {form.region ? `{ x: ${form.region.x}, y: ${form.region.y}, w: ${form.region.w}, h: ${form.region.h} }` : '未配置'}
            </span>
          </div>
          <button className="btn-primary" data-testid="region-open-browser-tab" onClick={() => form.id && navigate(`#/region/${form.id}`)} disabled={!form.id}>
            打开浏览器捕获
          </button>
        </div>
      ) : null}

      {timeoutAsk ? (
        <Modal title="测试连接超时" onClose={() => timeoutAsk.resolve(false)} width={420}>
          <p>测试连接已超过 10 秒未响应，继续等待还是跳过？</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => timeoutAsk.resolve(false)}>跳过</button>
            <button className="btn-primary" onClick={() => timeoutAsk.resolve(true)}>
              继续等待
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function validate(f: FormState): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!f.provider_name.trim()) errs.provider_name = '厂商显示名为必填项';
  if (f.mode === 'web_crawl' && !f.sub_mode) errs.mode = '请先选择采集方式（DOM 或 OCR）';
  if (f.mode === 'web_crawl' && f.sub_mode === 'dom' && !f.dom_url.trim()) errs.mode = 'DOM 抓取需要配置控制台页面 URL';
  if (f.mode === 'web_crawl' && f.sub_mode === 'ocr' && !f.dom_url.trim()) errs.mode = 'OCR 抓取需要配置控制台页面 URL';
  return errs;
}
