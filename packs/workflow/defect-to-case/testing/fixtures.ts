// Synthetic fixtures for defect-to-case workflow tests.
import type { CatalogEntry } from '../../../../contracts/src/tables.ts';
import type { IndexView } from '../../../../contracts/src/views.ts';
import { buildCatalog, type CatalogSpec } from '../../../../hub/rules/api.ts';
import type { DraftCase } from '../functions/types.ts';

const ROOT_DIGEST = 'a'.repeat(64);

export const SYNTHETIC_BUG_74001 = {
  id: '74001',
  '74001': true,
  kind: 'bug',
  title: 'SLB健康检查间隔无法保存',
  status: 'closed',
  label: 'SLB健康检查间隔无法保存',
  location: `src:${'b'.repeat(64)}/plm:bug/74001`,
  fixReference: `src:${'b'.repeat(64)}/markdown@1/s/fix`,
  fixText: '健康检查间隔设置成功，默认值为 5 秒。',
  fields: {
    status: 'closed',
    resolution: 'fixed',
    severity: 'major',
    assignedTo: 'tester1',
  },
  html_fields: {
    steps: '<p>1. 进入 SLB 页面</p><p>2. 修改健康检查间隔为 60 秒</p><p>3. 点击保存</p>',
    fix: '<p>修复说明：修改 health interval 参数范围校验，修复保存后不生效的问题。命令行配置 widget health interval &lt;1-300&gt;。期望结果：健康检查间隔设置成功，系统运行正常。</p>',
  },
};

export const SYNTHETIC_BUG_71010_UNCHECKABLE = {
  id: '71010',
  '71010': true,
  kind: 'bug',
  title: '底层组件内存碎片整理优化',
  status: 'closed',
  label: '底层组件内存碎片整理优化',
  location: `src:${'b'.repeat(64)}/plm:bug/71010`,
  fields: {
    status: 'closed',
    resolution: 'fixed',
  },
  html_fields: {
    steps: '<p>内部优化任务</p>',
    fix: '<p>代码内部重构与碎片整理，无外部可测命令行或行为变化。</p>',
  },
};

export const MANUAL_PASSAGE = '配置命令行 service http port <1-65535>。期望结果：服务端口修改成功，HTTP服务正常监听。';

export const SYNTHETIC_CATALOG_SPEC: CatalogSpec = {
  root: ROOT_DIGEST,
  complete: true,
  entries: [
    {
      head: 'widget health interval',
      signatures: [[{ name: 'seconds', type: 'int', minimum: 1, maximum: 300 }]],
      summary: '设置健康检查间隔',
    },
    {
      head: 'show health',
      signatures: [[]],
      summary: '查看健康检查状态',
    },
    {
      head: 'service http port',
      signatures: [[{ name: 'port', type: 'port', minimum: 1, maximum: 65535 }]],
      summary: '设置HTTP服务端口',
    },
  ],
};

export const SYNTHETIC_CATALOG: CatalogEntry[] = buildCatalog(SYNTHETIC_CATALOG_SPEC).entries();

export const SYNTHETIC_INDEX_VIEW: IndexView = {
  schema: 'index-view@1',
  product: 'apv',
  build: { build: 'Rel_APV_10_6_1_57', root: '1111111111111111111111111111111111111111111111111111111111111111' },
  kind: 'case',
  key: 'commands',
  keys: {
    'show health detail': ['2222222222222222222222222222222222222222222222222222222222222222'],
  },
  entries: {
    '2222222222222222222222222222222222222222222222222222222222222222': {
      entry: '2222222222222222222222222222222222222222222222222222222222222222',
      kind: 'case',
      statement: 'doc_101:node_5 | 健康检查详细信息查看',
      reference: `tree:${'1'.repeat(64)}/commands/show/health@${'2'.repeat(64)}`,
      data: {
        document: 'doc_101',
        node: 'node_5',
        title: '健康检查详细信息查看',
        negative: false,
        commands: ['show health detail'],
        expected_texts: ['健康检查状态显示正常'],
      },
    },
  },
  total_keys: 1,
  total_entries: 1,
  truncated: false,
  skipped: 0,
  notes: ['only=show health detail'],
};

/** The same view without the narrowing echo: the complete-index rule applies (old behaviour). */
export const SYNTHETIC_INDEX_VIEW_COMPLETE: IndexView = {
  ...SYNTHETIC_INDEX_VIEW,
  notes: [],
};

export const INCOMPLETE_INDEX_VIEW: IndexView = {
  ...SYNTHETIC_INDEX_VIEW,
  skipped: 3,
  notes: ['3 listed sources went unused'],
};

export function makeGoodDraft(options: { ref?: string } = {}): DraftCase {
  const ref = options.ref ?? 'src:fix_sha';
  return {
    title: 'SLB健康检查间隔配置正向测试',
    priority: 2,
    negative: false,
    expects_refutation: false,
    preconditions: ['SLB服务正常运行'],
    steps: [{ command: 'widget health interval 60', note: '设置间隔为60秒' }],
    expected: [
      {
        text: '健康检查间隔设置成功',
        quote: {
          reference: ref,
          text: '健康检查间隔设置成功',
        },
      },
    ],
    tags: ['Functional'],
  };
}

export const goodDraft = (overrides: Partial<DraftCase> = {}): DraftCase => ({ ...makeGoodDraft(), ...overrides });

export function makeNegativeExpectedRefutationDraft(options: { ref?: string } = {}): DraftCase {
  const ref = options.ref ?? 'src:fix_sha';
  return {
    title: 'SLB健康检查间隔超界反向测试',
    priority: 2,
    negative: true,
    expects_refutation: true,
    preconditions: ['SLB服务正常运行'],
    steps: [{ command: 'widget health interval 99999', note: '设置超界数值99999' }],
    expected: [
      {
        text: '系统运行正常',
        quote: {
          reference: ref,
          text: '系统运行正常',
        },
      },
    ],
    tags: ['Negative'],
  };
}

export function makeNegativeUnexpectedAcceptDraft(options: { ref?: string } = {}): DraftCase {
  const ref = options.ref ?? 'src:fix_sha';
  return {
    title: '反向声明但命令合法的错误起草',
    priority: 2,
    negative: true,
    expects_refutation: true,
    preconditions: ['SLB服务正常运行'],
    steps: [{ command: 'widget health interval 60', note: '合法命令' }],
    expected: [
      {
        text: '系统运行正常',
        quote: {
          reference: ref,
          text: '系统运行正常',
        },
      },
    ],
    tags: ['Negative'],
  };
}

export function makeDuplicateDraft(options: { ref?: string } = {}): DraftCase {
  const ref = options.ref ?? 'src:fix_sha';
  return {
    title: '健康检查详细信息查看',
    priority: 2,
    negative: false,
    expects_refutation: false,
    preconditions: [],
    steps: [{ command: 'show health detail', note: '查看详细信息' }],
    expected: [
      {
        text: '系统运行正常',
        quote: {
          reference: ref,
          text: '系统运行正常',
        },
      },
    ],
    tags: ['Functional'],
  };
}
