# 41 Acceptance Criteria

> Template v2

## 验收清单

- [ ] 系统支持新增/编辑/删除/启用/禁用 LLM 服务商配置，持久化到本地 SQLite；同一服务商可配置多条记录（多账号/多配额并行） — 判据：执行 CRUD 后 SQLite `providers` 表行数与字段（enabled、alias、provider_name）对应变化；同一 `provider_name` 下可查询到 ≥2 条 `alias` 不同的记录并在 Dashboard 渲染为多行。

- [ ] 每条服务商独立选择采集模式 api 或 web_crawl；web_crawl 下二选一 dom 或 ocr 并保存对应参数 — 判据：编辑表单切换控件 `mode` 取值仅为 `api` 或 `web_crawl`；当 `mode=web_crawl` 时 `sub_mode` 取值仅为 `dom` 或 `ocr`，对应参数（`dom_script` 或 `region`/`ocr_threshold`）写入数据库并随表单保存落库。

- [ ] OCR 模式下用户在 BrowserView 当前页面可通过鼠标拖拽直接框选截图区域，所选区域实时高亮显示，落库为坐标参数，免除手填 x,y,w,h — 判据：在 BrowserView 页面按下左键拖拽绘制蓝色矩形选区且跟随光标实时高亮；松开鼠标后 `region` 字段写入 `{x,y,w,h}` 四个数字且无需手动键入。

- [ ] OCR 识别结果置信度低于配置阈值时判定抓取失败，不生成错误快照 — 判据：注入 OCR 返回 `confidence=0.5`、`ocr_threshold=0.8` 时该 provider 行显示红色「⚠️ 抓取失败」，`llm_usage_snapshots` 表 `COUNT(*)` 不增加。

- [ ] 检测到服务商页面未登录时该行显示红色「🔐 请手动登录」，弹窗 BrowserView 供用户登录，登录成功后自动隐藏并复用会话 — 判据：未登录时行内 DOM 含 `.auth-required` 红色类与「🔐 请手动登录」文案；点击行弹窗 `BrowserView`，手动登录后弹窗关闭且重启应用无需重新登录（Cookie 持久化命中）。

- [ ] 任意采集环节失败该行显示红色「⚠️ 抓取失败」，历史快照数据保持不变 — 判据：注入网络异常后行渲染红色「⚠️ 抓取失败」文案；查询 `llm_usage_snapshots` 该 provider 最新 `created_at` 时间戳与失败前一致。

- [ ] 采集成功后自动计算剩余额度并写入 llm_usage_snapshots 表；剩余额度≤告警阈值时该行以红色背景/状态提示 — 判据：刷新成功后 `llm_usage_snapshots` 新增一行且 `remaining` 字段非空；当 `remaining ≤ alert_threshold` 时该行 DOM 含 `.alert-bg` 类且 `background-color` 计算值为红色系。

- [ ] 抓取失败或未登录时支持手动输入本周期已用量，提交后生成有效快照并参与告警与趋势图 — 判据：失败/未登录状态下点击「手动录入」提交数字 → `llm_usage_snapshots` 新增 `status='valid'` 行，且同 provider 趋势图立即新增对应数据点。

- [ ] 手动录入→生成有效快照全流程≤3 次鼠标点击完成 — 判据：操作序列「点击行(1) → 点击录入按钮(2) → 点击提交(3)」共 3 次点击后快照可见且参与告警判断，浏览器 DevTools Performance 面板 click 事件计数 ≤3。

- [ ] Dashboard 支持单服务商历史用量趋势图（已用/剩余双曲线），仅展示有效快照，时间范围可筛选 — 判据：详情面板渲染 SVG/Canvas 双 Y 轴折线（`used`、`remaining`）；切换时间范围下拉（24h/7d/30d/custom）后数据点数量随之变化；手动写入 `status='invalid'` 的快照不绘制在曲线上。

- [ ] 所有采集仅由用户点击【全部刷新】/【单条刷新】触发，无任何后台定时/自动轮询 — 判据：源码 grep `setInterval`、`setTimeout`、`cron`、`node-cron`、`BullMQ` 等调度关键词无采集调用；静置 1 小时后 `llm_usage_snapshots` 无新增行。

- [ ] 全部刷新时执行策略符合配置：并行/串行/分批可设定，相邻 provider 刷新间隔≥N 秒以规避风控 — 判据：设置面板可切换 `batch_size` 与 `interval_seconds`，运行时日志可见相邻 provider 之间 `await sleep(N)` 调用且 `N ≥ 配置值`；并发上限与 `batch_size` 一致。

- [ ] 所有登录态、Cookie、配置数据、用量快照均保存在本地 SQLite，不上传外部服务器 — 判据：抓包（Charles/Wireshark）监控 1 小时无任何指向非 provider 官方域名（如 `telemetry.example.com`）的 POST/上传请求；SQLite 文件包含 `providers`、`cookies`、`llm_usage_snapshots` 等表。

- [ ] 单实例同时驻留 BrowserView 数量在 20 个以内时体验流畅，硬上限 30 个 — 判据：启用 20 个 `BrowserView` 时 DevTools Performance 帧率 ≥30fps；尝试创建第 31 个时 UI 弹窗「已达硬上限 30」并阻止创建。

- [ ] Expo Web 仅作为静态 UI 嵌入 Electron，所有数据库/BrowserView/OCR 操作必须经主进程 IPC 校验 — 判据：渲染进程 bundle 中 grep `sqlite3`、`BrowserView`、`paddleocr` 无直接调用痕迹；所有 DB/OCR/BrowserView 调用经 `ipcRenderer.invoke('llm:*')` 进入主进程 handler 并通过白名单校验。

- [ ] DOM 提取仅执行预配置脚本片段读取页面文本，不注入不可信远程脚本 — 判据：`providers.dom_script` 字段为本地静态字符串；抓包验证页面加载无远程脚本注入；执行后仅返回 `textContent` 文本，无 `eval`、`Function`、`<script>` 注入痕迹。

- [ ] OCR 基于本地 PaddleOCR-js 运行，不依赖外部云端识别服务 — 判据：断网状态下 OCR 截图→识别全流程仍可成功；网络面板无 `ocr.tencentcloud.com`、`ocr.aliyun.com` 等云端 OCR 接口请求。

- [ ] 系统支持新增/编辑/删除/启用/禁用 LLM 服务商配置，配置持久化到本地 SQLite — 判据：CRUD 操作对应 SQLite `providers` 表 `INSERT/UPDATE/DELETE` 行变化；`enabled=false` 时 Dashboard 不渲染该行，SQLite 仍保留记录。

- [ ] 每个服务商可独立选择采集模式：api 或 web_crawl — 判据：编辑表单 `mode` 字段枚举值为 `api` 或 `web_crawl`，切换后立即写入 `providers.mode` 字段并刷新 Dashboard 行为表现。

- [ ] web_crawl 模式下，可选择 dom 或 ocr 提取方式并保存对应配置参数 — 判据：`sub_mode` 字段值变更持久化；DOM 模式保存 `dom_script`，OCR 模式保存 `region`、`ocr_threshold` 等参数，SQLite 行字段可查询到。

- [ ] 同一服务商支持多条配置并行（多账号/多配额），各自独立 BrowserView 与登录态 — 判据：同一 `provider_name` 下 ≥2 条记录在 `providers` 表中可见；每条记录对应独立 `webContents.id`，`cookies` 表按 `provider_id` 隔离。

- [ ] 单实例舒适支持 ≥20 个服务商，硬上限 30 个 — 判据：同时启用 20 个 provider 执行「全部刷新」整体完成时间 <60s；尝试启用第 31 个时 UI 弹窗拒绝并 SQLite 不新增记录。

- [ ] API 模式下，系统调用配置的用量接口生成快照（V1.0 内置 OpenAI / Anthropic / Azure OpenAI 三家固定适配器） — 判据：内置适配器列表（`src/main/adapters/`）包含 `openai.ts`、`anthropic.ts`、`azure-openai.ts`；刷新后调用对应 usage endpoint 并将响应写入 `llm_usage_snapshots`。

- [ ] Web 抓取模式下，每个服务商对应独立 BrowserView 会话，Cookie 与登录态本地持久化 — 判据：每条 `mode=web_crawl` 记录对应独立 `webContents.id`；重启应用后无需重新登录即可直接抓取。

- [ ] OCR 模式下用户可在 BrowserView 当前页面上拖拽框选截图区域，所选坐标自动回填并持久化，所见即所得 — 判据：拖框结束后 UI 表单自动填充 `{x,y,w,h}` 数值无需键入；保存后刷新页面/重启应用仍可见相同坐标值。

- [ ] OCR 识别结果低于配置置信度阈值时判定为抓取失败，不生成错误快照 — 判据：OCR 返回 `confidence < threshold` 时该 provider 行渲染「⚠️ 抓取失败」红字，`llm_usage_snapshots` 表行数不变。

- [ ] 检测到服务商页面需要登录时，前端红字显示「🔐 请手动登录」，允许用户在内嵌浏览器中完成登录后自动隐藏 BrowserView — 判据：未登录态下 Dashboard 行显示红色「🔐 请手动登录」文案；点击行后 BrowserView 弹窗出现；登录完成点击「完成」按钮后弹窗自动关闭且 `auth-status=ok`。

- [ ] 任意采集环节失败时，前端表格红字显示「⚠️ 抓取失败」，不污染历史快照 — 判据：注入 API/抓取异常后行 DOM 含 `.error-text` 类且文字色为红；`llm_usage_snapshots` 表无 `status='invalid'` 或空 `remaining` 行写入。

- [ ] 采集成功后系统自动计算剩余额度并写入 llm_usage_snapshots 表 — 判据：刷新成功后 `SELECT * FROM llm_usage_snapshots WHERE provider_id=? ORDER BY created_at DESC LIMIT 1` 返回新行且 `remaining`、`used`、`reset_at` 字段非空。

- [ ] 剩余额度 ≤ 告警阈值时，对应服务商在 Dashboard 中以红色背景或红色告警状态提示 — 判据：构造 `remaining <= alert_threshold` 测试数据后该行计算样式 `background-color` 为红色系且状态字段含「告警」二字。

- [ ] 抓取失败或未登录时支持手动输入当前周期已用量并提交生成有效快照，整个录入流程 ≤3 次点击 — 判据：操作序列「点击行(1) → 点击录入(2) → 输入并提交(3)」共 3 次点击后快照可见，DevTools click 事件计数 ≤3。

- [ ] Dashboard 支持查看每个服务商的历史用量趋势图，图中仅展示有效快照数据 — 判据：图表 SQL 数据源含 `WHERE status='valid'`；手动伪造 `status='invalid'` 行在 SVG/Canvas 中不可见。

- [ ] 系统不执行任何后台自动定时抓取，所有网页采集均由用户手动点击刷新触发 — 判据：源码 grep `setInterval`、`cron` 等调度关键词无采集相关调用；静置 1 小时 `llm_usage_snapshots` 行数无变化。

- [ ] 【全部刷新】采用分批并行策略，默认并发 5 个/批，可在设置中调整为 1~10 — 判据：设置面板 `batch_size` 默认值为 5，可调范围 `[1,10]`；运行时实际并发任务数 ≤ `batch_size`，日志可见分批执行轨迹。

- [ ] 同一 Provider 两次刷新间隔 <60 秒则直接跳过并提示「操作过于频繁」；【全部刷新】按钮点击后置灰 10 秒 — 判据：60s 内对同 provider 触发第二次刷新时 UI 弹 toast「操作过于频繁」且无新快照写入；【全部刷新】按钮 `disabled=true` 持续 10s 后恢复。

- [ ] 所有登录态、Cookie、配置数据和用量快照均保存在本地，不上传外部服务器 — 判据：抓包监控 1 小时无任何指向非 provider 官方域名的 POST/上传请求；本地仅存在 SQLite 文件与加密 Cookie 存储。

## 通过判定

- 验收清单 36 条全部为 `[x]` 且对应判据中所有可观测条件（SQL 查询、DOM/CSS、网络抓包、日志输出）均通过，方可判定本期整体通过。

- 允许例外：`API 模式下，系统调用配置的用量接口生成快照（V1.0 内置 OpenAI / Anthropic / Azure OpenAI 三家固定适配器）` 若因网络或凭据问题导致真实接口不可调用，可使用 Mock Server 替换，只要请求路径/方法/参数与官方一致且快照生成逻辑正确即视为通过；其余条目不允许以 Mock 替代。

- 任何 1 条 AC 未通过即整体不通过，需修复后重新走完整验收流程。

## 验收角色

- **产品经理**：负责对照验收清单逐条确认功能完整性，重点核验 CRUD、采集模式选择、手动录入≤3 点击、趋势图可见性等面向用户的可观测结果。

- **前端工程师（Expo Web + Electron Renderer）**：负责验证 DOM/CSS 渲染（红色 🔐/⚠️ 提示、红色背景告警、趋势图 SVG/Canvas 绘制、按钮置灰 10s、拖拽选区 UI），并核对渲染进程无直接 DB/OCR/BrowserView 调用。

- **Electron 主进程 / 后端工程师**：负责验证 SQLite 持久化（providers/cookies/llm_usage_snapshots 表结构与字段）、IPC 白名单校验、PaddleOCR-js 本地调用、BrowserView 生命周期与 Cookie 隔离、batch/interval 调度策略。

- **QA 工程师**：负责执行抓包、DevTools Performance、SQL 查询、源码 grep 等客观判据项，输出 36 条 AC 对应的日志、截图与查询证据，形成验收报告。