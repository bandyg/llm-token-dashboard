/** 内置厂商模板（25_UI_UX 提供商配置页左侧模板列表） */
export interface ProviderTemplate {
  id: string;
  name: string;
  adapter: string | null;
  baseUrl: string;
  pageUrl: string;
  /** 登录 / 抓取用页面（与 pageUrl 不同源时使用，如 SPA 的 hash 路由） */
  domUrl?: string;
  /** 支持的采集模式 */
  modes: ('api' | 'web_crawl' | 'manual')[];
  currency: string;
  quotaTotal: number | null;
  /** 默认 DOM 选择器 */
  selectors: { name: string; selector: string }[];
  loginRequiredSelector: string | null;
  /** OpenAI 兼容厂商用于「测试连接/刷新」的极简探活路径（POST）。缺省时 openai-compatible 适配器退回原 OpenAI billing 端点 */
  probePath?: string;
  /** 真实采集路径（GET）。缺省时用 adapter 默认行为 */
  quotaPath?: string;
  note: string;
}

/**
 * 模板顺序：用户常用（智谱/MiniMax/小米 MiMo/OpenCode）置顶，其它按主流程度排，custom 末尾（templateById 未知 id 回退依赖此）。
 * 修改顺序时确认：1) custom 保持最后；2) tests/unit/templates.test.ts 的 12 条总数断言不挂。
 */
export const TEMPLATES: ProviderTemplate[] = [
  {
    id: 'zhipu',
    name: '智谱',
    adapter: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    pageUrl: 'https://open.bigmodel.cn/finance-center/finance/pay',
    modes: ['api', 'manual'],
    currency: 'CREDIT',
    quotaTotal: null,
    selectors: [],
    loginRequiredSelector: '.login-btn',
    /** quotaPath：挂在 api host 根路径，不与 baseUrl 拼接（adapter 从 baseUrl 派生 host 后再拼 quotaPath）；
     probePath：探针测试用的试键路径，挂在 baseUrl 末尾（如 /api/paas/v4 + probePath）；
     quota 端点挂时自动降级到 probePath 探活 */
    quotaPath: '/api/monitor/usage/quota/limit',
    probePath: '/chat/completions',
    note: 'GLM Coding Plan 额度端点。limits[] 按 unit 区分窗口（3=5 小时、6=每周、TIME_LIMIT=月度 MCP），CREDIT_LIMIT 与 TOKENS_LIMIT 两种类型均兼容；另有 /api/biz/subscription/list 提供套餐名与续费日期。CREDIT 为额度点数维度，非货币，勿按 ¥ 解读。baseUrl 必须是 https://open.bigmodel.cn/api/paas/v4（含 /v4），否则探活 probe 会 404',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    adapter: 'minimax',
    baseUrl: 'https://api.minimaxi.com/v1',
    pageUrl: 'https://platform.minimaxi.com/',
    modes: ['api', 'web_crawl', 'manual'],
    currency: 'CREDIT',
    quotaTotal: null,
    selectors: [],
    loginRequiredSelector: '.login-btn',
    note: 'Token Plan 额度端点 {host}/backend/account/token_plan_credit【只认网页登录 Cookie，不认 API Key】。必须先在卡片点「登录」完成浏览器会话导入，Cookie 失效会返回 HTTP 200 + status_code 1004(not login)。国内站 api.minimaxi.com → www.minimaxi.com，国际站 api.minimax.io → www.minimax.io。额度为「积分」维度，非货币',
  },
  {
    id: 'xiaomi-mimo',
    name: '小米 MiMo',
    adapter: 'xiaomi-mimo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    pageUrl: 'https://platform.xiaomimimo.com/#/console/balance',
    domUrl: 'https://platform.xiaomimimo.com/#/console/balance',
    modes: ['api', 'web_crawl', 'manual'],
    currency: 'CREDIT',
    quotaTotal: null,
    selectors: [],
    loginRequiredSelector: '.login-btn',
    note: '额度接口在控制台 https://platform.xiaomimimo.com/api/v1 下【只认网页 Cookie，不认 API Key】，必须先点「登录」导入会话。TokenPlan Key（tp- 开头）走 /tokenPlan/usage 读套餐额度；按量计费 Key（sk- 开头）走 /balance 读账户余额。必需 Cookie：api-platform_serviceToken、userId。Cookie 失效返回 HTTP 401',
  },
  {
    id: 'opencode',
    name: 'OpenCode Go',
    adapter: 'opencode',
    baseUrl: 'https://opencode.ai/zen/v1',
    pageUrl: 'https://opencode.ai/console/go',
    modes: ['api', 'web_crawl', 'manual'],
    currency: 'PERCENT',
    quotaTotal: null,
    selectors: [],
    loginRequiredSelector: null,
    note: 'GET {origin}/zen/go/v1/usage 【认 API Key，无需 Cookie】。三窗口：5 小时 / 每周 / 每月，接口只返回已用百分比（限额按美元计价：Go 为 $12/$30/$60），绝对金额需在控制台查看。另有 /zen/v1/credits 可读 Zen 余额。未订阅 Go 时 usage 为空会报解析错误',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com',
    pageUrl: 'https://platform.openai.com/usage',
    modes: ['api', 'web_crawl', 'manual'],
    currency: 'USD',
    quotaTotal: 50,
    selectors: [{ name: '已用', selector: '[data-testid="usage-card"] .usage-value' }],
    loginRequiredSelector: 'a[href*="/login"]',
    note: '官方 API 适配器读取订阅与用量端点',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    pageUrl: 'https://console.anthropic.com/settings/usage',
    modes: ['api', 'web_crawl', 'manual'],
    currency: 'USD',
    quotaTotal: 50,
    selectors: [{ name: '已用', selector: '.usage-panel .amount' }],
    loginRequiredSelector: 'input[type="password"]',
    note: 'Admin API 用量报表端点',
  },
  {
    id: 'google',
    name: 'Google AI',
    adapter: null,
    baseUrl: 'https://generativelanguage.googleapis.com',
    pageUrl: 'https://aistudio.google.com/usage',
    modes: ['web_crawl', 'manual'],
    currency: 'USD',
    quotaTotal: 100,
    selectors: [{ name: '已用', selector: '.quota-usage' }],
    loginRequiredSelector: 'a[href*="accounts.google.com"]',
    note: '暂无内置 API 适配器，推荐 OCR 框选配额区域',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapter: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    pageUrl: 'https://platform.deepseek.com/usage',
    modes: ['api', 'web_crawl', 'manual'],
    currency: 'CNY',
    quotaTotal: 200,
    selectors: [{ name: '余额', selector: '.balance-info .num' }],
    loginRequiredSelector: 'input[type="password"]',
    note: '官方 /user/balance 端点',
  },
  {
    id: 'qwen',
    name: '通义千问',
    adapter: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    pageUrl: 'https://bailian.console.aliyun.com/',
    modes: ['web_crawl', 'manual'],
    currency: 'CNY',
    quotaTotal: 300,
    selectors: [{ name: '已用', selector: '.resource-usage .value' }],
    loginRequiredSelector: '.next-dialog input[type="password"]',
    probePath: '/chat/completions',
    note: '兼容端点 baseUrl 自带 /v1，探活打 /chat/completions（推荐 OCR 框选百炼控制台额度区域）',
  },
  {
    id: 'wenxin',
    name: '文心一言',
    adapter: null,
    baseUrl: 'https://aip.baidubce.com',
    pageUrl: 'https://console.bce.baidu.com/qianfan/finance',
    modes: ['web_crawl', 'manual'],
    currency: 'CNY',
    quotaTotal: 200,
    selectors: [{ name: '余额', selector: '.finance-balance' }],
    loginRequiredSelector: '#login-form',
    note: '千帆控制台财务页抓取',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    adapter: null,
    baseUrl: 'http://127.0.0.1:11434',
    pageUrl: 'http://127.0.0.1:11434',
    modes: ['manual'],
    currency: 'COUNT',
    quotaTotal: null,
    selectors: [],
    loginRequiredSelector: null,
    note: '本地模型无额度概念，仅手动录入统计',
  },
  {
    id: 'custom',
    name: '自定义',
    adapter: null,
    baseUrl: '',
    pageUrl: '',
    modes: ['api', 'web_crawl', 'manual'],
    currency: 'USD',
    quotaTotal: null,
    selectors: [],
    loginRequiredSelector: null,
    note: '从零配置全部字段',
  },
];

export function templateById(id: string): ProviderTemplate {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[TEMPLATES.length - 1];
}