import { describe, expect, it } from 'vitest';
import { TEMPLATES, templateById } from '../../src/shared/templates';

describe('内置厂商模板', () => {
  it('共 12 个内置模板，id 唯一', () => {
    expect(TEMPLATES).toHaveLength(12);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(12);
  });

  it('含小米 MiMo / MiniMax / OpenCode，且 baseUrl 为可访问官方端点', () => {
    const byId = Object.fromEntries(TEMPLATES.map((t) => [t.id, t]));
    expect(byId['xiaomi-mimo']).toMatchObject({
      name: '小米 MiMo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      adapter: 'xiaomi-mimo',
      // TokenPlan 套餐额度为 credits 维度；按量计费 Key 时适配器按响应返回 CNY
      currency: 'CREDIT',
    });
    expect(byId.minimax).toMatchObject({
      name: 'MiniMax',
      baseUrl: 'https://api.minimaxi.com/v1',
      // 额度为「积分」维度，非货币
      currency: 'CREDIT',
      adapter: 'minimax',
    });
    expect(byId.opencode).toMatchObject({
      name: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/zen/v1',
      pageUrl: 'https://opencode.ai/console/go',
      adapter: 'opencode',
      // 接口只返回已用百分比，金额需在控制台查看
      currency: 'PERCENT',
    });
  });

  it('OpenCode Go 有内置适配器（认 API Key，无需 Cookie）；MiniMax / MiMo 有（需 Cookie）', () => {
    // OpenCode：/zen/go/v1/usage 直接认 Bearer Key，无需网页会话
    const oc = templateById('opencode');
    expect(oc.adapter).toBe('opencode');
    expect(oc.modes).toContain('api');
    expect(oc.note).toMatch(/无需 Cookie/);

    // 额度端点在控制台侧、只认网页 Cookie 的两家
    for (const [id, adapterId] of [['minimax', 'minimax'], ['xiaomi-mimo', 'xiaomi-mimo']] as const) {
      const t = templateById(id);
      expect(t.adapter).toBe(adapterId);
      expect(t.modes).toContain('api');
      expect(t.note).toMatch(/Cookie/);
    }
  });

  it('templateById 未知 id 回退到自定义模板', () => {
    expect(templateById('nonexistent').id).toBe('custom');
  });
});
