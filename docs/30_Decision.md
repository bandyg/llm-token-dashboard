# 30 Decision

## Status

Ready for Development

## Verdict

GO

## 理由

文档链路完整：Idea/Goals/Non-Goals 划界清晰，PRD、架构分层、数据模型（8 实体 ER）、API 端点、UI 规范齐备；AC 可测性强（DOM 类名、快照表计数、≤3 次点击等判据明确）；实施计划五阶段依赖顺序合理，手动刷新+本地存储的 Non-Goals 有效收敛了风控与隐私风险；核心差异化记忆点（可视化拖框选区+OCR 坐标回填）已贯穿 PRD/架构/AC/计划，可立即进入开发。

## 风险

- DOM/OCR 抓取对页面改版高度脆弱，selector 与选区坐标的长期维护成本高，anchor_selector 兜底效果待验证

- 网页端抓取可能触碰厂商 ToS，存在账号被风控/封禁的残余风险，需在 UI 明示用户自担

- PaddleOCR-js 在 Electron 三平台（dmg/nsis/AppImage）的原生依赖打包与推理性能存在不确定性

- Electron BrowserView API 已趋于弃用（新版本转向 WebContentsView），需在阶段一确认 Electron 版本选型

- 仅手动刷新意味着告警时效取决于用户操作频率，与「防超额停服」的诉求存在体验落差

## 下一步行动

进入阶段一开发前，先做 3 项技术 Spike：① 确认 Electron 版本与 BrowserView/WebContentsView 选型；② PaddleOCR-js 在三平台的打包与识别准确率 PoC；③ 2~3 家无 API 厂商的 DOM/OCR 抓取可行性验证，结果回填实施计划后再全面铺开。