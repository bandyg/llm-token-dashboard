import type { SyncSettings } from '../../shared/types';

/** 渲染层「恢复默认」用的默认值副本（与主进程 DEFAULT_SETTINGS 保持一致） */
export const DEFAULT_SETTINGS_CLIENT: SyncSettings = {
  strategy: 'batch',
  batch_size: 5,
  interval_seconds: 60,
  min_refresh_seconds: 60,
  default_alert_threshold: 20,
  ocr_threshold_default: 0.8,
  theme: 'light',
  sync_all_cooldown_ms: 10000,
};
