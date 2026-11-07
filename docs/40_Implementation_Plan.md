# 40 Implementation Plan

> Template v2

## 阶段划分

- 阶段一：基础设施（Electron 主进程 + BrowserView 池 + 本地持久化 + 凭据收纳）

- 阶段二：采集三路并行（官方 API 适配器 / DOM 抓取 / 可视化框选 + PaddleOCR-js）

- 阶段三：统一 Dashboard 与归一化数据呈现（卡片、趋势、告警）

- 阶段四：手动兜底与失败反馈（≤3 次点击录入、红字提示）

- 阶段五：刷新调度与跨平台打包分发

## 任务

- [ ] 阶段一交付：Electron 主进程 + BrowserView 池 + IPC 通道（刷新 / 拉取配额 / 写入历史）；本地持久化（Provider / OCR 选区 / 刷新历史 / 手动录入 四类表）；凭据写入系统 keychain（macOS Keychain / Windows Credential / libsecret），UI 提供一次性录入入口

- [ ] 阶段二交付（可并行）：抽象统一 `QuotaProvider` 接口（fetchQuota → normalizedUsage），实现 OpenAI / Anthropic / Gemini / DeepSeek / 通义 / 文心 / Kimi / 智谱 等官方 API 适配器；DOM 抓取适配器（语义化 selector）+ content script 注入，处理 SPA 路由与懒加载；在 BrowserView 上叠加透明选区层，鼠标 down/move/up 实时绘制矩形并显示像素坐标与尺寸，松手后归一化坐标持久化到 `selectRegion`，实现一次配置终身复用；集成 PaddleOCR-js 本地推理对框选截图做 OCR，与 DOM 结果交叉校验

- [ ] 阶段三交付：统一 Dashboard 页面（已用 / 剩余卡片 + 剩余百分比进度条 + 按日/周/月趋势图 + 阈值告警 <20% 黄 / <5% 红）；按 Provider 分组的历史趋势聚合，支持 7 / 30 / 90 天切换

- [ ] 阶段四交付：采集失败时对应卡片红字标注「采集失败 + 原因摘要」并暴露「手动录入」入口；手动录入流程 ≤3 次点击（点击卡片 → 选择用量类型 → 输入数值并保存）；手动值与自动采集统一口径，参与趋势与告警计算

- [ ] 阶段五交付：手动批量刷新调度三档粒度（刷新全部 / 选中 Provider / 单 Provider）；首次启动引导（添加 Provider → 选择采集方式 → 配置凭据或框选教学）；Electron 跨平台打包（macOS dmg + Windows nsis + Linux AppImage）

## 依赖顺序

- 阶段一：无（基线，必须最先完成）

- 阶段二：依赖阶段一（IPC、BrowserView、持久化底座）；阶段二内部三条采集路线可并行推进

- 阶段三：依赖阶段二产出的归一化数据

- 阶段四：依赖阶段三（卡片已具备承载失败态的位置与样式）

- 阶段五：依赖阶段二～阶段四全量验收；引导中的「框选教学」环节依赖阶段二的可视化选区模块已稳定

## 验证方式

- 阶段一：`npm run dev` 启动含 BrowserView 的 Electron 空窗口；通过 IPC 触发一次空数据写入持久化层并能再次读出；凭据录入后系统在 keychain 中可见加密条目

- 阶段二：单元测试覆盖 `QuotaProvider` 契约；接入 ≥2 家 API + ≥2 家 DOM + 1 个 OCR Provider 后日志输出归一化的 `used / remaining / resetAt`；在 BrowserView 拖框后关闭应用再重启，选区坐标自动还原；同一截图像的 OCR 输出与 DOM 抓取数值偏差 < 5%

- 阶段三：Dashboard 同时呈现 API / DOM / OCR 三种来源卡片；趋势图按日期聚合正确；剩余百分比 <20% / <5% 时对应卡片触发黄 / 红告警色

- 阶段四：人为制造采集失败（断网 / 错凭据 / 错选择器）后卡片显示红字 + 原因摘要；点击「手动录入」到保存数值全程 ≤3 次点击；保存后趋势曲线与告警颜色立即同步更新

- 阶段五：手动批量刷新全部 Provider 在合理时间内完成；`npm run build` 产出 macOS / Windows / Linux 三平台安装包；安装后冷启动到 Dashboard 时间 < 5 秒