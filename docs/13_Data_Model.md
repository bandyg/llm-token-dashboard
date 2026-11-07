# 13 Data Model

> Template v2

## 核心实体

- 本工具为纯本地单机应用，数据模型落地为本地 SQLite 单库，共 8 个核心实体：厂商（Provider）、账号（Account）、采集通道（CollectionChannel）、选区配置（RegionConfig）、额度快照（QuotaSnapshot）、告警规则（AlertRule）、告警事件（AlertEvent）、采集失败记录（CollectionFailure）。

```mermaid
erDiagram
    PROVIDER ||--o{ ACCOUNT : "拥有"
    ACCOUNT ||--o{ COLLECTION_CHANNEL : "配置"
    ACCOUNT ||--o{ ALERT_RULE : "设定"
    COLLECTION_CHANNEL ||--o{ REGION_CONFIG : "框选区域"
    COLLECTION_CHANNEL ||--o{ QUOTA_SNAPSHOT : "产出"
    COLLECTION_CHANNEL ||--o{ COLLECTION_FAILURE : "记录"
    ALERT_RULE ||--o{ ALERT_EVENT : "触发"
    QUOTA_SNAPSHOT ||--o{ ALERT_EVENT : "作为触发依据"

    PROVIDER {
        string provider_id PK
        string name "厂商显示名"
        string adapter_type "api|dom|ocr|hybrid"
    }
    ACCOUNT {
        string account_id PK
        string provider_id FK
        string display_name
        string credential_ref "safeStorage加密指针"
        string external_uid "站点侧唯一标识"
    }
    COLLECTION_CHANNEL {
        string channel_id PK
        string account_id FK
        string mode "rest_api|dom_parse|ocr|manual"
        string page_url_pattern "BrowserView目标页"
    }
    REGION_CONFIG {
        string region_id PK
        string channel_id FK
        string slot "used|remaining|expire"
        int x "拖框自动回填"
        int y "拖框自动回填"
        int width "拖框自动回填"
        int height "拖框自动回填"
        float scale_factor
        string anchor_selector "锚点CSS选择器"
        float min_confidence "OCR置信度阈值"
    }
    QUOTA_SNAPSHOT {
        string snapshot_id PK
        string channel_id FK
        string quota_type "token|credit|usd|message"
        number used
        number remaining
        number total
        string source "api|dom|ocr|manual"
        datetime collected_at
    }
    ALERT_RULE {
        string rule_id PK
        string account_id FK
        string metric "remaining_pct|remaining_abs|daily_used"
        number threshold
    }
    ALERT_EVENT {
        string event_id PK
        string rule_id FK
        string snapshot_id FK
        datetime triggered_at
        bool acknowledged
    }
    COLLECTION_FAILURE {
        string failure_id PK
        stri
```

```
ng channel_id FK
        string error_type "login_expired|selector_missing|ocr_low_confidence|network"
        int consecutive_count
        datetime occurred_at
    }
```

- 凭据永不入主库：DB 中仅存 `credential_ref` 指针，实际 API Key / Cookie 以 Electron `safeStorage` 加密 blob 存于独立文件，删除账号时同步粉碎。

## 实体关系

- PROVIDER 1—N ACCOUNT：一个厂商可挂多个账号；ACCOUNT 1—N COLLECTION_CHANNEL：同一账号可同时配置 REST API 与 OCR 截图双通道，互为冗余降级路径。

- COLLECTION_CHANNEL 1—N REGION_CONFIG：BrowserView 同一目标页允许框选多个区域（“已用额度”“剩余额度”“重置日期”各一框），每框独立持久化为一条 RegionConfig，跨会话复用。

- REGION_CONFIG 通过 `page_url_pattern + anchor_selector` 与 BrowserView 页面锚定，页面小幅改版时随锚点元素平移仍可命中，实现“一次配置终身复用”。

- QUOTA_SNAPSHOT 是全系统唯一事实源：Dashboard 展示、趋势聚合、告警判定均从快照派生；COLLECTION_FAILURE 挂在通道上，与其最近快照状态联动决定红字提示与手动录入入口。

## 关键字段

- **RegionConfig**（记忆点载体）：`x,y,width,height: int(px)` 必填——仅由可视化拖框自动回填，UI 不提供手输框；`scale_factor: float` 必填（DPI 适配）；`anchor_selector: string` 选填（相对锚点定位，抗改版）；`min_confidence: float(0~1)` source=ocr 时必填；`enabled: bool` 必填，默认 true。

- **QuotaSnapshot**：`channel_id: uuid` 必填；`quota_type: enum(token|credit|usd|message)` 必填；`used / remaining: decimal(18,4)` 必填，`total` 选填（可由 used+remaining 推导）；`source: enum(api|dom|ocr|manual)` 必填；`collected_at: datetime` 必填；`prefill_from_snapshot_id: uuid` 选填——手动兜底录入时预填上一条快照值，保证 ≤3 次点击完成。

- **Account**：`display_name: string` 必填；`credential_ref: string` 可空（免登录站点）；`external_uid: string` 选填，用于唯一性去重。

- **CollectionFailure**：`error_type: enum(login_expired|selector_missing|ocr_low_confidence|network|parse_error)` 必填；`consecutive_count: int` 必填，达 2 即触发红字提示；`suggestion: string` 选填（如“Cookie 过期，请重新登录”）。

- **AlertRule**：`metric: enum(remaining_pct|remaining_abs|daily_used)` 必填；`threshold: decimal(18,4)` 必填；`dedupe_window_minutes: int` 选填，默认 60。

## 索引与约束

- 唯一索引：`ACCOUNT(provider_id, external_uid)` 防重复添加同一账号；`REGION_CONFIG(channel_id, slot, enabled)` 保证同一通道同一槽位至多一个启用选区。

- 查询索引：`QUOTA_SNAPSHOT(channel_id, collected_at DESC)` 支撑趋势折线与“剩余额度”最新值查询；`QUOTA_SNAPSHOT(source)` 过滤手动兜底数据；`COLLECTION_FAILURE(channel_id, occurred_at DESC)` 供 Dashboard 红字定位。

- CHECK 约束：`width > 0 AND height > 0`（拖框合法性）；`x >= 0 AND y >= 0`（视口内）；`ocr_confidence BETWEEN 0 AND 1`；`used >= 0 AND remaining >= 0`。

- 级联与留存：删除 ACCOUNT 时 REGION_CONFIG、ALERT_RULE 级联删除，QUOTA_SNAPSHOT 保留并匿名聚合以维持历史趋势完整性；原始快照保留 90 天，日粒度聚合永久保留。

- 安全约束：`credential_ref` 仅可为指向 safeStorage blob 的相对路径；REGION_CONFIG 坐标、DOM selector 均只存本地，任何采集流程不得外发。

## 生命周期

- **RegionConfig**：未配置 → 用户在 BrowserView 叠层 UI 拖框，坐标经合法性校验（面积 > 阈值、在视口内）后自动回填入库 → 启用；OCR 置信度连续 3 次低于 `min_confidence` 时转入 `drifted` 状态，Dashboard 黄字提示“选区疑似失效，点击重新框选”，重选后复位。

- **QuotaSnapshot**：用户手动批量刷新触发 → 按 API / DOM / OCR 采集 → 解析与数值校验 → 写入原始快照 → 后台按日聚合成趋势汇总 → 90 天后原始记录滚动清理。

- **失败降级链**：单次失败仅静默重试一次；连续 ≥2 次写入 COLLECTION_FAILURE 并将通道标红 → 点击红字打开手动录入弹层（已预填最近快照值）→ 核对/修改后确认即写入 `source=manual` 快照，全程 ≤3 次点击，成功后 `consecutive_count` 清零。

- **AlertRule → AlertEvent**：某次快照跨越阈值即生成事件，同一规则在去重窗口内不重复触发；事件确认后静默，仅保留历史。

- **Account**：`active ⇄ paused`（暂停通道仍保留历史与规则，只是不刷新）→ `archived`（只读归档，趋势图可查、不再产生新快照）。