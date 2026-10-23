// Source: packs/workflow/template-gap/functions/tags.ts (aliases) and tables/template-v3.json (six types and labels).
// Pack content copied because production pack functions cannot import another pack; tag-table-consistency.test.ts pins equality.
export const TAG_SPELLINGS = {
  Functional: ['functional', 'function', 'functions', 'functionality', 'func', '功能', '功能性', '基本功能'],
  Configuration: ['configuration', 'configurations', 'config', 'configs', 'configure', 'cfg', '配置'],
  Integration: ['integration', 'integrations', 'integrated', 'integrate', '集成'],
  Compatibility: ['compatibility', 'compatible', 'compat', '兼容', '兼容性'],
  Negative: ['negative', 'neg', '负向', '负面', '反向', '逆向', '异常'],
  Stress: ['stress', 'pressure', '压力', '压测'],
} as const;
export const TYPE_LABELS = { Functional: '功能测试', Configuration: '配置测试', Integration: '集成测试', Compatibility: '兼容性测试', Negative: '反向测试', Stress: '压力测试' } as const;
