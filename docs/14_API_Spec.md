# 14 API Spec

> Template v2

本文档定义本地桌面端 LLM 用量统一监控工具的内部服务 API。Electron 主进程在 `http://127.0.0.1:{port}/api/v1` 提供 REST 服务，渲染进程 Dashboard 与采集模块（适配器 / BrowserView 抓取 / PaddleOCR-js）均通过该 API 通信。

## 端点列表

| method | path | 用途 | |---|---|---| | GET | /api/v1/providers | 列出所有 Provider 及采集方式（adapter / browser-dom / browser-ocr）与已持久化选区 | | POST | /api/v1/providers | 新增 Provider，绑定厂商适配器或抓取方案 | | PATCH | /api/v1/providers/{id} | 更新采集配置（含替换/禁用 OCR 选区坐标） | | DELETE | /api/v1/providers/{id} | 删除 Provider 及其额度历史 | | POST | /api/v1/providers/{id}/refresh | 手动刷新单个 Provider 的已用/剩余额度 | | POST | /api/v1/refresh/batch | 分批手动刷新（用户勾选或全部），分批受并发与间隔约束 | | GET | /api/v1/dashboard/usage | 统一 Dashboard 汇总：已用/剩余、百分比、采集状态（失败含红字原因） | | GET | /api/v1/dashboard/history | 历史趋势（按小时/天聚合的用量曲线与告警触发点） | | GET | /api/v1/collect/status | 最近采集任务明细：成功/失败、失败原因、建议动作 | | POST | /api/v1/capture/selection/start | 在当前 BrowserView 页面上层唤起截图式拖拽框选浮层，返回会话 ID | | POST | /api/v1/capture/regions | 提交框选坐标并自动回填持久化，一次配置终身复用 | | POST | /api/v1/capture/ocr | 对指定选区截图并执行本地 PaddleOCR-js 解析额度字段 | | POST | /api/v1/usage/manual | 采集失败时的手动录入兜底（≤3 次点击完成） | | PUT | /api/v1/alerts/{providerId} | 设置告警阈值（剩余百分比或绝对额度） |

- 框选闭环链路：`selection/start`（唤起浮层，用户所见即所得拖框）→ `capture/regions`（坐标自动回填 + 持久化）→ 后续每次 `refresh` 直接复用该选区，无需重选。

- 兜底闭环：`dashboard/usage` 中 `status=failed` 的条目带 `failAction`，前端红字提示一键跳转「重新框选」或「手动录入」。

## 请求 / 响应

- 通用约定：请求/响应均为 UTF-8 JSON；统一信封 `{ "code": 0, "message": "ok", "data": {…} }`，业务成功 `code=0`，失败时 `code` 为错误码（见下节）；时间戳一律 ISO 8601 含时区。

- **POST /api/v1/capture/regions**（记忆点核心：拖框即配置）

```json
// 请求
{
  "providerId": "prov_web_01",
  "selectorSessionId": "sel_9c2f",
  "region": { "x": 1180, "y": 268, "w": 264, "h": 72, "dpr": 2 },
  "fieldMapping": "auto",
  "persist": true
}
// 响应
{
  "code": 0,
  "data": {
    "regionId": "rgn_5d21",
    "providerId": "prov_web_01",
    "persisted": true,
    "ocrPreview": { "text": "剩余额度 128.40 / 500.00 元", "confidence": 0.96 },
    "message": "坐标已自动回填并持久化，后续手动刷新直接复用该选区"
  }
}
```

- **GET /api/v1/dashboard/usage**（失败条目以 `status=failed` + 红字 `failReason` 返回）

```json
{
  "code": 0,
  "data": {
    "updatedAt": "2025-05-01T12:00:00+08:00",
    "summary": { "currency": "CNY", "used": 371.60, "remaining": 1128.40 },
    "providers": [
      { "id": "prov_openai_01", "name": "OpenAI Platform", "source": "adapter",
        "used": 128.40, "remaining": 371.60, "percentUsed": 25.7,
        "status": "ok", "lastRefreshAt": "2025-05-01T11:58:32+08:00" },
      { "id": "prov_web_01", "name": "某厂控制台（OCR 抓取）", "source": "browser-ocr",
        "used": null, "remaining": null, "percentUsed": null, "status": "failed",
        "failReason": "OCR 置信度过低，请重新拖拽框选或手动录入",
        "failAction": "/api/v1/capture/selection/start" }
    ]
  }
}
```

- **POST /api/v1/refresh/batch**

```json
// 请求
{ "providerIds": ["prov_openai_01", "prov_web_01"], "concurrency": 3 }
// 响应
{ "code": 0, "data": { "batchId": "bat_8a10", "accepted": 2,
  "results": [
    { "providerId": "prov_openai_01", "status": "ok" },
    { "providerId": "prov_web_01", "status": "failed", "failReason": "DOM 节点 .quota-panel 未找到" }
  ] } }
```

- **POST /api/v1/usage/manual**（`mode=remaining` 时用户只需粘贴/输入一个数字即完成，配合 Dashboard 预填默认值实现 ≤3 次点击兜底）

```json
{
  "providerId": "prov_web_01",
  "mode": "remaining",
  "remaining": 42.50,
  "currency": "CNY",
  "recordedAt": "2025-05-01T12:05:00+08:00",
  "note": "采集失败兜底录入"
}
```

## 错误码

- 失败响应信封示例：`{ "code": "OCR_LOW_CONFIDENCE", "message": "PaddleOCR 置信度 0.52 < 0.60，已拒绝自动回填", "data": { "confidence": 0.52 } }`。

| code | HTTP | 含义 | |---|---|---| | INVALID_REGION | 400 | 选区坐标越界或 w/h ≤ 0 | | UNAUTHORIZED | 401 | 本地 token 缺失或不匹配 | | PROVIDER_NOT_FOUND | 404 | providerId 不存在 | | SELECTION_SESSION_EXPIRED | 410 | 框选会话超过 60s 未提交，需重新唤起浮层 | | OCR_LOW_CONFIDENCE | 422 | PaddleOCR-js 置信度 < 0.60，不做自动回填，前端红字引导重选/手录 | | REFRESH_TOO_FREQUENT | 429 | 同一 Provider 刷新间隔小于 30s | | ADAPTER_UPSTREAM_ERROR | 502 | 厂商 API 报错或凭证失效（data 携带上游状态码） | | BROWSERVIEW_UNAVAILABLE | 503 | 目标页面加载失败或被反爬拦截 |

- 采集类错误（422 / 502 / 503）不中断批量任务：`refresh/batch` 逐条记录失败原因，Dashboard 对应条目显示红字并附 `failAction`。

- 所有 4xx/5xx 均本地落盘日志（含脱敏后的请求摘要），供「采集状态」页排障。

## 鉴权

- 服务仅绑定 `127.0.0.1`，禁止监听 `0.0.0.0`，不提供任何局域网/外网暴露面。

- 首次启动生成随机本地 token，存入操作系统密钥链（Keychain / Credential Manager）；所有请求须携带 `X-Local-Token: <token>` 头。

- 防 CSRF：服务端校验 `Origin` / `Host` 必须为本应用，且要求自定义头 `X-Local-Token`（浏览器内网页发起的跨站请求无法携带自定义头，天然阻断）。

- Token 可在设置页一键重置，重置后旧 token 立即失效并使所有进行中的框选/刷新会话作废。

## 限流

- 全局默认：单 token 20 req/s，超出返回 `429` 并附 `Retry-After` 头（本地防御渲染层 Bug 导致的请求风暴）。

- 刷新类端点：同一 Provider 最小间隔 30s；`refresh/batch` 并发上限 3、批间间隔 2s，避免触发厂商风控导致凭证被封。

- `capture/ocr`：6 req/min（PaddleOCR-js 本地推理占用 CPU，超限返回 `429`）。

- 以上阈值可在设置页调整但设有硬上限（并发 ≤ 5、OCR ≤ 12 req/min），防止用户配置自伤。