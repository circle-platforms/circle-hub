// The attribution scheme on invented ancestor paths in the real conventions. Each row states the expected answer; the rows
// were written from the owner's scheme before the function ran (docs/hub-r4-architecture.md section 6a, capability 3), and the
// rows of the second review round from the reviewers' scenarios before the fixes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import locateFunction, { described, locate, locateInputOf, locateItem, summaryOf } from './locate.ts';
import { assertTotal, hostileInputs, seeded } from './test-support.ts';
import type { Confidence, Conflict, IdRanges, LocateAnswer, LocateInput, VersionSource } from './types.ts';

const P0 = '030：APV/NSAE测试项目';
const LINE = { names: ['APV', 'NSAE'], product: 'apv' };

type Row = {
  id: string;
  root: string | null;
  ancestors: string[];
  title: string | null;
  declared?: { product?: string; line?: string };
  id_ranges?: IdRanges;
  unbound?: boolean;
  kind?: 'case';
  path?: string[];
  case_title?: string;
  expect: {
    product: [string | null, string | null];
    version: string | null;
    line: string | null;
    train: string | null;
    module: string | null;
    source: VersionSource;
    confidence: Confidence;
    verdict: 'support' | 'unknown' | 'refute';
    conflict_code?: string;
    build?: string | null;
    /** Default: folders when there is a build date, else none. */
    build_source?: VersionSource;
    patch?: string | null;
    patch_source?: VersionSource;
    build_names?: string[];
    requirements?: string[];
    defects?: string[];
    unclassified?: string[];
    ranged?: { requirements: string[]; defects: string[] };
    /** Where each id was read, keyed `<kind or ?>:<id>`; checked only when given. */
    from?: Record<string, string[]>;
    declared?: string[];
    conflicts?: Conflict[];
    note?: string;
    /** A part of the few words that say why the answer is not a fact (the summary lead). */
    brief?: string;
  };
};

const NSAE: Row['expect']['product'] = ['apv', 'NSAE'];
const APV: Row['expect']['product'] = ['apv', 'APV'];
const FULL = [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'];
const LOCATED = { product: NSAE, version: '10.6.1', line: '10.6.1', train: '10.6.1-R2-2026/7', module: 'SSL', source: 'folders', confidence: 'high', verdict: 'support' } as const;
const NESTED = [P0, '010：9.8', '020：10.6', '101：10.6-主线-2026/01', 'SLB'];

const ROWS: Row[] = [
  // The convention held fully, partly, and with its variants.
  { id: 'full-nsae', root: 'NSAE', ancestors: FULL, title: 'bug to case 90101 会话保持', expect: { ...LOCATED, unclassified: ['90101'], from: { '?:90101': ['title'] } } },
  {
    id: 'customer-train',
    root: 'NSAE',
    ancestors: [P0, '070：10.7.0', 'a10：10.7.0-BANK-20260625', 'WebUI'],
    title: '需求20931 证书链校验',
    expect: { product: NSAE, version: '10.7.0', line: '10.7.0', train: '10.7.0-BANK-20260625', module: 'WebUI', source: 'folders', confidence: 'high', verdict: 'support', requirements: ['20931'] },
  },
  {
    id: 'spaced-train-grouped-prefix',
    root: 'NSAE',
    ancestors: [P0, '030：10.6.2', '301：10.6.2 主线HG UOS-2026/08/02', '000-001-002：HA'],
    title: 'HA 切换',
    expect: { product: NSAE, version: '10.6.2', line: '10.6.2', train: '10.6.2 主线HG UOS-2026/08/02', module: 'HA', source: 'folders', confidence: 'high', verdict: 'support' },
  },
  {
    id: 'full-width',
    root: 'NSAE',
    ancestors: [P0, '０６０：１０.６.１', '００４：１０.６.１－Ｒ１－２０２６/７', '认证'],
    title: 'Story#20777 认证方式',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: '10.6.1-R1-2026/7', module: '认证', source: 'folders', confidence: 'high', verdict: 'support', requirements: ['20777'] },
  },
  {
    id: 'line-only',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', 'SSL'],
    title: 'SSL 卸载',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support', note: '没有发布火车' },
  },
  {
    id: 'train-without-line',
    root: 'NSAE',
    ancestors: [P0, '004：10.6.1-R2-2026/7', 'SLB'],
    title: '61001-会话保持',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: '10.6.1-R2-2026/7', module: 'SLB', source: 'folders', confidence: 'high', verdict: 'support', unclassified: ['61001'], note: '版本线取自发布火车' },
  },
  // Deeper functional folders only quote versions.
  { id: 'deeper-quote', root: 'NSAE', ancestors: [...FULL, '10.7.3 迁移回归'], title: 'bug 61234 证书迁移', expect: { ...LOCATED, defects: ['61234'], note: '只当引用' } },
  {
    id: 'deeper-build-number-quote',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'HA', 'HA 切换（10.6.1.57 引入）'],
    title: 'HA 主备切换',
    expect: { ...LOCATED, module: 'HA', build_names: [] },
  },
  // A folder that is only a version (the owner's expression over the whole label) is a version level of its own; a version
  // mentioned among other words is a reference version: confidence low, the answer unknown.
  {
    id: 'pure-version-label',
    root: 'NSAE',
    ancestors: [P0, 'V10.7.0'],
    title: '专项',
    expect: { product: NSAE, version: '10.7.0', line: null, train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support' },
  },
  {
    id: 'pure-version-label-with-a-name',
    root: 'NSAE',
    ancestors: [P0, 'NSAE_10.7.3'],
    title: '补丁验证',
    expect: { product: NSAE, version: '10.7.3', line: null, train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support' },
  },
  {
    id: 'folder-with-build-number',
    root: 'NSAE',
    ancestors: [P0, 'NSAE_10.6.1.57_专项'],
    title: '专项回归',
    expect: { product: NSAE, version: '10.6.1.57', line: null, train: null, module: null, source: 'folders', confidence: 'low', verdict: 'unknown', build_names: [], brief: '版本只是目录名里提到的' },
  },
  {
    id: 'v-prefix-among-words',
    root: 'NSAE',
    ancestors: [P0, 'V10.7.0 专项测试'],
    title: '专项',
    expect: { product: NSAE, version: '10.7.0', line: null, train: null, module: null, source: 'folders', confidence: 'low', verdict: 'unknown', brief: '版本只是目录名里提到的' },
  },
  // A version only in the title is a reference version.
  {
    id: 'title-only',
    root: 'NSAE',
    ancestors: [P0, '专项', 'SSL'],
    title: 'NSAE 10.6.2.31 升级兼容',
    expect: { product: NSAE, version: '10.6.2.31', line: null, train: null, module: null, source: 'title', confidence: 'low', verdict: 'unknown', build_names: [], brief: '版本只在标题里' },
  },
  // The APV-named root has no version level: version unknown, not an error.
  {
    id: 'apv-root',
    root: 'APV',
    ancestors: ['通用用例', '基础功能'],
    title: '设备基础配置',
    expect: { product: APV, version: null, line: null, train: null, module: null, source: 'none', confidence: 'none', verdict: 'unknown', brief: '没有版本层' },
  },
  {
    id: 'apv-root-direct',
    root: 'APV',
    ancestors: [],
    title: 'bug to case 90220 告警',
    expect: { product: APV, version: null, line: null, train: null, module: null, source: 'none', confidence: 'none', verdict: 'unknown', unclassified: ['90220'] },
  },
  // Build dates and patches count only at the version level (the version's label, the labels above it, the release train).
  {
    id: 'build-date-in-the-train',
    root: 'NSAE',
    ancestors: [P0, '060：10.7.0', '102：10.7.0-build20260402-2026/4', '网络'],
    title: '路由',
    expect: { product: NSAE, version: '10.7.0', line: '10.7.0', train: '10.7.0-build20260402-2026/4', module: '网络', source: 'folders', confidence: 'high', verdict: 'support', build: '20260402' },
  },
  {
    id: 'patch-in-the-train',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', '005：10.6.1-patch2-2026/9', 'SSL'],
    title: 'SSL',
    expect: { ...LOCATED, train: '10.6.1-patch2-2026/9', patch: '2' },
  },
  {
    id: 'build-date-in-a-deeper-folder',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', 'build20260315 回归'],
    title: '回归验证',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support', build: null, note: '只当引用' },
  },
  { id: 'build-date-only-in-the-title', root: 'NSAE', ancestors: FULL, title: 'SSL 回归 build20260315', expect: { ...LOCATED, build: null, note: '只当引用' } },
  { id: 'patch-in-a-functional-folder', root: 'NSAE', ancestors: [...FULL, '证书', 'patch2 遗留问题对比'], title: 'SSL 回归', expect: { ...LOCATED, patch: null, note: '只当引用' } },
  {
    id: 'dotted-patch-is-no-version',
    root: 'NSAE',
    ancestors: [P0, 'patch1.2 专项'],
    title: '补丁验证',
    expect: { product: NSAE, version: null, line: null, train: null, module: null, source: 'none', confidence: 'none', verdict: 'unknown', patch: '1.2' },
  },
  {
    id: 'patch-beside-a-mentioned-version',
    root: 'NSAE',
    ancestors: [P0, 'NSAE_10.7.3_patch3'],
    title: '补丁3',
    expect: { product: NSAE, version: '10.7.3', line: null, train: null, module: null, source: 'folders', confidence: 'low', verdict: 'unknown', patch: '3' },
  },
  {
    id: 'build-date-beside-a-mentioned-version',
    root: 'NSAE',
    ancestors: [P0, 'APV 10.7.0 build20260110'],
    title: '版本验证',
    expect: { product: NSAE, version: '10.7.0', line: null, train: null, module: null, source: 'folders', confidence: 'low', verdict: 'unknown', build: '20260110' },
  },
  {
    id: 'title-build-date-beside-a-title-version',
    root: 'NSAE',
    ancestors: [P0, '专项'],
    title: 'NSAE 10.6.2.31 build20260315 回归',
    expect: { product: NSAE, version: '10.6.2.31', line: null, train: null, module: null, source: 'title', confidence: 'low', verdict: 'unknown', build: '20260315', build_source: 'title' },
  },
  {
    id: 'invalid-build-date',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', 'build20261345'],
    title: '构建验证',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support', build: null, note: '不是有效的构建日期' },
  },
  // The root decides the product.
  { id: 'other-root', root: '合成平台', ancestors: FULL, title: 'SSL', expect: { ...LOCATED, product: [null, '合成平台'], verdict: 'unknown', brief: '不是产品名称' } },
  {
    id: 'no-root',
    root: null,
    ancestors: ['060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'],
    title: 'SSL',
    expect: { ...LOCATED, product: [null, null], verdict: 'unknown', brief: '没有目录树的根' },
  },
  { id: 'root-full-width-lower-case', root: 'ｎｓａｅ', ancestors: FULL, title: 'SSL', expect: LOCATED },
  { id: 'unbound-run', root: 'NSAE', ancestors: FULL, title: 'SSL', unbound: true, expect: { ...LOCATED, product: [null, 'NSAE'], verdict: 'unknown', note: '运行没有绑定产品线' } },
  // A tree that contradicts itself is not a fact: both values stay in the answer, the disagreement leads the summary.
  {
    id: 'several-line-nodes',
    root: 'NSAE',
    ancestors: NESTED,
    title: '负载均衡',
    expect: { product: NSAE, version: '9.8', line: '10.6', train: '10.6-主线-2026/01', module: 'SLB', source: 'folders', confidence: 'low', verdict: 'refute', conflict_code: 'case-location.version_conflict', brief: '目录里有几个版本线：9.8、10.6' },
  },
  {
    id: 'train-of-another-line',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', '004：10.6.2-R2-2026/7', 'SLB'],
    title: '负载均衡',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: '10.6.2-R2-2026/7', module: 'SLB', source: 'folders', confidence: 'low', verdict: 'refute', conflict_code: 'case-location.version_conflict', brief: '发布火车与版本线不一致' },
  },
  {
    id: 'nested-line-nodes-without-a-train',
    root: 'NSAE',
    ancestors: [P0, '010：9.8', 'SLB', '020：10.6'],
    title: '负载均衡',
    expect: { product: NSAE, version: '9.8', line: '9.8', train: null, module: null, source: 'folders', confidence: 'low', verdict: 'refute', conflict_code: 'case-location.version_conflict', brief: '目录里有几个版本线：9.8、10.6' },
  },
  {
    id: 'version-label-above-the-convention',
    root: 'NSAE',
    ancestors: ['10.6', P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL'],
    title: 'SSL',
    expect: { ...LOCATED, version: '10.6', confidence: 'low', verdict: 'refute', conflict_code: 'case-location.version_conflict', brief: '目录里的版本不一致：10.6、10.6.1' },
  },
  {
    id: 'document-folder-is-no-module',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'bug to case 61001'],
    title: '会话保持',
    expect: { ...LOCATED, module: null, unclassified: ['61001'], from: { '?:61001': ['folders'] }, note: '不是模块名' },
  },
  {
    id: 'document-folder-with-a-leading-id',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', '61002-会话保持'],
    title: '会话保持回归',
    expect: { ...LOCATED, module: null, unclassified: ['61002'], from: { '?:61002': ['folders'] } },
  },
  { id: 'activity-folder-is-no-module', root: 'NSAE', ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', '回归测试'], title: '回归', expect: { ...LOCATED, module: null } },
  { id: 'requirement-in-a-deeper-folder', root: 'NSAE', ancestors: [...FULL, '需求20931 证书链'], title: '会话保持', expect: { ...LOCATED, requirements: ['20931'], from: { 'story:20931': ['folders'] } } },
  {
    id: 'same-id-in-the-title-and-a-folder',
    root: 'NSAE',
    ancestors: [...FULL, 'bug 61001 回归'],
    title: 'bug 61001 会话保持',
    expect: { ...LOCATED, defects: ['61001'], from: { 'bug:61001': ['title', 'folders'] } },
  },
  { id: 'leading-number-of-a-deeper-folder-is-no-id', root: 'NSAE', ancestors: [...FULL, '4094 VLAN 上限'], title: 'VLAN', expect: LOCATED },
  // Dotted numbers that are not product versions: guards beside the owner's expression, and a mention is never a fact.
  {
    id: 'protocol-version',
    root: 'APV',
    ancestors: ['TLSv1.3 握手'],
    title: 'TLS 握手',
    expect: { product: APV, version: null, line: null, train: null, module: null, source: 'none', confidence: 'none', verdict: 'unknown' },
  },
  {
    id: 'quantity',
    root: 'APV',
    ancestors: ['1.5倍压力测试'],
    title: '压力',
    expect: { product: APV, version: null, line: null, train: null, module: null, source: 'none', confidence: 'none', verdict: 'unknown' },
  },
  {
    id: 'address',
    root: 'APV',
    ancestors: ['192.0.2.10 地址测试'],
    title: '地址',
    expect: { product: APV, version: null, line: null, train: null, module: null, source: 'none', confidence: 'none', verdict: 'unknown' },
  },
  {
    id: 'standard-number-in-a-folder',
    root: 'APV',
    ancestors: ['网络', '802.1Q VLAN'],
    title: 'VLAN',
    expect: { product: APV, version: '802.1', line: null, train: null, module: null, source: 'folders', confidence: 'low', verdict: 'unknown', brief: '版本只是目录名里提到的' },
  },
  {
    id: 'software-version-in-a-folder',
    root: 'APV',
    ancestors: ['Chrome 120.0 兼容'],
    title: '兼容',
    expect: { product: APV, version: '120.0', line: null, train: null, module: null, source: 'folders', confidence: 'low', verdict: 'unknown' },
  },
  {
    id: 'library-version-in-a-folder',
    root: 'APV',
    ancestors: ['OpenSSL 1.1.1 升级'],
    title: '升级',
    expect: { product: APV, version: '1.1.1', line: null, train: null, module: null, source: 'folders', confidence: 'low', verdict: 'unknown' },
  },
  // Build names: only the names written in the tree, verbatim, of the line's name families; never made up.
  {
    id: 'written-build-name',
    root: 'NSAE',
    ancestors: [P0, 'Rel_NSAE_10_6_1_57 回归'],
    title: '回归',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support', build_names: ['Rel_NSAE_10_6_1_57'] },
  },
  {
    id: 'older-line-build-name',
    root: 'NSAE',
    ancestors: [P0, '040：10.9.1', 'Rel_NSAE_10_9_1_37 回归'],
    title: '回归',
    expect: { product: NSAE, version: '10.9.1', line: '10.9.1', train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support', build_names: ['Rel_NSAE_10_9_1_37'] },
  },
  { id: 'build-name-of-another-product', root: 'NSAE', ancestors: [...FULL, 'Rel_OTHERPROD_9_1_0_3 对比'], title: 'SSL 对比', expect: { ...LOCATED, build_names: [], note: '不是这条产品线的名称族' } },
  {
    id: 'platform-build-name',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1', '004：10.6.1-R2-2026/7', 'HA', 'Rel_APV-HG-K_10_6_1_8_4_129 验证'],
    title: 'HA',
    expect: { ...LOCATED, module: 'HA', build_names: ['Rel_APV-HG-K_10_6_1_8_4_129'] },
  },
  // Ids: marked kinds are facts of the text; the caller's id ranges are a declaration, reported apart.
  {
    id: 'id-ranges',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1'],
    title: '33001-SSL证书链 bug to case 90101',
    id_ranges: { story: { min: 10000, max: 49999 }, bug: { min: 50000 } },
    expect: {
      product: NSAE,
      version: '10.6.1',
      line: '10.6.1',
      train: null,
      module: null,
      source: 'folders',
      confidence: 'high',
      verdict: 'support',
      unclassified: ['90101', '33001'],
      ranged: { requirements: ['33001'], defects: ['90101'] },
    },
  },
  {
    id: 'story-range-alone',
    root: 'NSAE',
    ancestors: FULL,
    title: '33001-SSL证书链 bug to case 74001',
    id_ranges: { story: { min: 10000, max: 49999 } },
    expect: { ...LOCATED, unclassified: ['74001', '33001'], ranged: { requirements: ['33001'], defects: [] } },
  },
  {
    id: 'inner-marker-wins',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1'],
    title: 'bug to case-需求20931 证书',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support', requirements: ['20931'] },
  },
  {
    id: 'listed-defects',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1'],
    title: 'Bug 118000&118001 内存泄漏',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support', defects: ['118000', '118001'] },
  },
  {
    id: 'dates-and-versions-are-no-ids',
    root: 'NSAE',
    ancestors: [P0, '060：10.6.1'],
    title: '2026/7 回归 10.6.1.32 验证 20260531',
    expect: { product: NSAE, version: '10.6.1', line: '10.6.1', train: null, module: null, source: 'folders', confidence: 'high', verdict: 'support' },
  },
  { id: 'leading-quantity-is-no-id', root: 'NSAE', ancestors: FULL, title: '10000并发压力测试', expect: LOCATED },
  { id: 'short-leading-number-is-no-id', root: 'NSAE', ancestors: FULL, title: '8080 端口测试', expect: LOCATED },
  // Declarations fill what the tree does not give and are refuted where they contradict it.
  {
    id: 'declared-line-conflict',
    root: 'NSAE',
    ancestors: FULL,
    title: 'SSL',
    declared: { line: '10.7.3' },
    expect: { ...LOCATED, verdict: 'refute', conflicts: [{ field: 'line', declared: '10.7.3', tree: '10.6.1' }] },
  },
  { id: 'declared-line-agrees', root: 'NSAE', ancestors: FULL, title: 'SSL', declared: { line: '10.6' }, expect: LOCATED },
  {
    id: 'declared-line-fills-apv-root',
    root: 'APV',
    ancestors: ['通用用例', '基础功能'],
    title: '设备基础配置',
    declared: { line: '10.6.1' },
    expect: { product: APV, version: '10.6.1', line: '10.6.1', train: null, module: null, source: 'parameter', confidence: 'low', verdict: 'unknown', declared: ['line', 'version'], brief: '版本是声明的' },
  },
  {
    id: 'declared-line-beside-title-version',
    root: 'NSAE',
    ancestors: [P0, '专项', 'SSL'],
    title: 'NSAE 10.6.2.31 升级兼容',
    declared: { line: '10.6.2' },
    expect: { product: NSAE, version: '10.6.2.31', line: '10.6.2', train: null, module: null, source: 'title', confidence: 'low', verdict: 'unknown', build_names: [], declared: ['line'] },
  },
  {
    id: 'declared-reported-version-on-a-contradicting-tree',
    root: 'NSAE',
    ancestors: NESTED,
    title: '负载均衡',
    declared: { line: '9.8' },
    expect: {
      product: NSAE,
      version: '9.8',
      line: '10.6',
      train: '10.6-主线-2026/01',
      module: 'SLB',
      source: 'folders',
      confidence: 'low',
      verdict: 'refute', conflict_code: 'case-location.version_conflict',
      conflicts: [],
    },
  },
  {
    id: 'declared-line-node-on-a-contradicting-tree',
    root: 'NSAE',
    ancestors: NESTED,
    title: '负载均衡',
    declared: { line: '10.6' },
    expect: {
      product: NSAE,
      version: '9.8',
      line: '10.6',
      train: '10.6-主线-2026/01',
      module: 'SLB',
      source: 'folders',
      confidence: 'low',
      verdict: 'refute', conflict_code: 'case-location.version_conflict',
      conflicts: [],
    },
  },
  {
    id: 'declared-product-beside-another-root',
    root: '合成平台',
    ancestors: FULL,
    title: 'SSL',
    declared: { product: 'nsae' },
    expect: { ...LOCATED, product: [null, '合成平台'], verdict: 'refute', conflicts: [{ field: 'product', declared: 'nsae', tree: '合成平台' }] },
  },
  { id: 'declared-product-equal-to-another-root', root: '合成平台', ancestors: FULL, title: 'SSL', declared: { product: '合成平台' }, expect: { ...LOCATED, product: [null, '合成平台'], verdict: 'unknown' } },
  {
    id: 'declared-product-fills-a-missing-root',
    root: null,
    ancestors: FULL,
    title: 'SSL',
    declared: { product: 'nsae' },
    expect: { ...LOCATED, verdict: 'unknown', declared: ['product_name', 'product_line'], brief: '产品线是声明的' },
  },
  {
    id: 'declared-product-conflict',
    root: 'NSAE',
    ancestors: FULL,
    title: 'SSL',
    declared: { product: '合成平台' },
    expect: { ...LOCATED, verdict: 'refute', conflicts: [{ field: 'product', declared: '合成平台', tree: 'NSAE' }] },
  },
  { id: 'declared-product-of-the-same-line', root: 'NSAE', ancestors: FULL, title: 'SSL', declared: { product: 'APV' }, expect: { ...LOCATED, note: '同属产品线 apv' } },
  // A case item: the map path below the title is deeper still; the case texts name ids only after a marker word.
  {
    id: 'case-item',
    root: 'NSAE',
    ancestors: FULL,
    title: 'SSL 卸载',
    kind: 'case',
    path: ['基本功能', '10.7.3 兼容'],
    case_title: 'bug 61500 证书链加载',
    expect: { ...LOCATED, defects: ['61500'], from: { 'bug:61500': ['map'] } },
  },
  { id: 'case-path-quantities', root: 'NSAE', ancestors: FULL, title: 'SSL 卸载', kind: 'case', path: ['4094 VLAN 上限'], case_title: '1024 位 RSA 证书导入', expect: LOCATED },
  {
    id: 'case-path-marked-ids',
    root: 'NSAE',
    ancestors: FULL,
    title: 'SSL 卸载',
    kind: 'case',
    path: ['需求20931 证书', '10000 并发握手'],
    case_title: '61001-会话保持',
    expect: { ...LOCATED, requirements: ['20931'], from: { 'story:20931': ['map'] } },
  },
  // The system pack listed the root as the first folder too.
  { id: 'root-repeated-as-folder', root: 'NSAE', ancestors: ['NSAE', ...FULL], title: 'SSL', expect: LOCATED },
];

function inputOf(row: Row, overrides: Partial<LocateInput> = {}): LocateInput {
  return {
    case_id: row.id,
    root: row.root,
    ancestors: row.ancestors,
    title: row.title,
    ...(row.kind ? { kind: row.kind, path: row.path ?? [], case_title: row.case_title ?? null } : {}),
    names: row.unbound ? [] : LINE.names,
    product: row.unbound ? null : LINE.product,
    declared: { product: row.declared?.product ?? null, line: row.declared?.line ?? null },
    id_ranges: row.id_ranges ?? null,
    ...overrides,
  };
}

/** The fields of an answer the table states. */
function stated(answer: LocateAnswer, verdict: string): Record<string, unknown> {
  return {
    product: [answer.product_line, answer.product_name],
    version: answer.version,
    line: answer.line,
    train: answer.train,
    module: answer.module,
    source: answer.version_source,
    confidence: answer.confidence,
    verdict,
    build: answer.build,
    build_source: answer.build_source,
    patch: answer.patch,
    patch_source: answer.patch_source,
    build_names: answer.build_names,
    requirements: answer.requirements,
    defects: answer.defects,
    unclassified: answer.unclassified,
    ranged: answer.ranged,
    declared: answer.declared,
    conflicts: answer.conflicts,
  };
}

function expected(row: Row): Record<string, unknown> {
  const e = row.expect;
  const build = e.build ?? null;
  const patch = e.patch ?? null;
  return {
    product: e.product,
    version: e.version,
    line: e.line,
    train: e.train,
    module: e.module,
    source: e.source,
    confidence: e.confidence,
    verdict: e.verdict,
    build,
    build_source: e.build_source ?? (build === null ? 'none' : 'folders'),
    patch,
    patch_source: e.patch_source ?? (patch === null ? 'none' : 'folders'),
    build_names: e.build_names ?? [],
    requirements: e.requirements ?? [],
    defects: e.defects ?? [],
    unclassified: e.unclassified ?? [],
    ranged: e.ranged ?? { requirements: [], defects: [] },
    declared: e.declared ?? [],
    conflicts: e.conflicts ?? [],
  };
}

const fromOf = (answer: LocateAnswer): Record<string, string[]> => Object.fromEntries(answer.id_sources.map((s) => [`${s.kind ?? '?'}:${s.id}`, s.from]));

describe('the attribution scheme on invented ancestor paths', () => {
  it('has rows covering every form of the brief and of the review', () => {
    assert.ok(ROWS.length >= 60, `${ROWS.length} rows`);
    const sources = new Set(ROWS.map((r) => r.expect.source));
    for (const source of ['folders', 'title', 'none', 'parameter']) assert.ok(sources.has(source as VersionSource), source);
    assert.ok(ROWS.some((r) => r.root === 'NSAE') && ROWS.some((r) => r.root === 'APV'));
    assert.ok(ROWS.some((r) => r.expect.build) && ROWS.some((r) => r.expect.patch));
    for (const verdict of ['support', 'unknown', 'refute']) assert.ok(ROWS.some((r) => r.expect.verdict === verdict), verdict);
    assert.equal(new Set(ROWS.map((r) => r.id)).size, ROWS.length);
  });

  for (const row of ROWS) {
    it(row.id, () => {
      const { answer, judgment } = locateItem(inputOf(row));
      assert.deepEqual(stated(answer, judgment.verdict), expected(row));
      assert.equal(answer.case_id, row.id);
      if (row.expect.note) assert.ok(answer.notes.some((n) => n.includes(row.expect.note!)), `${row.id}: no note with “${row.expect.note}” in ${JSON.stringify(answer.notes)}`);
      if (row.expect.from) assert.deepEqual(fromOf(answer), row.expect.from);
      if (row.expect.brief) assert.ok(judgment.brief.includes(row.expect.brief), `${row.id}: brief “${judgment.brief}” lacks “${row.expect.brief}”`);
      if (judgment.verdict === 'unknown') assert.equal(judgment.reason, 'missing_input');
      if (judgment.verdict === 'refute') assert.equal(judgment.code, row.expect.conflict_code ?? 'case-location.declaration_conflict');
      if (judgment.verdict === 'support') assert.deepEqual([answer.confidence, answer.declared, judgment.brief], ['high', [], '']);
      assert.ok(judgment.statement.length > 0 && /\p{Script=Han}/u.test(judgment.statement));
    });
  }

  it('reports the path from the root to the item, root first', () => {
    assert.deepEqual(locate(inputOf(ROWS[0])).ancestor_path, ['NSAE', ...FULL]);
    const repeated = ROWS.find((r) => r.id === 'root-repeated-as-folder')!;
    assert.deepEqual(locate(inputOf(repeated)).ancestor_path, ['NSAE', ...FULL]);
    const item = ROWS.find((r) => r.id === 'case-item')!;
    assert.deepEqual(locate(inputOf(item)).ancestor_path, ['NSAE', ...FULL, 'SSL 卸载', '基本功能', '10.7.3 兼容']);
    assert.deepEqual(locate(inputOf(ROWS.find((r) => r.id === 'no-root')!)).ancestor_path, ['060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL']);
  });

  it('says why an answer is uncertain or a declaration conflicts, and where the folders come from', () => {
    const row = (id: string) => locateItem(inputOf(ROWS.find((r) => r.id === id)!)).judgment;
    assert.match(row('title-only').statement, /版本只在标题里（参考版本 10\.6\.2\.31）/);
    assert.match(row('apv-root').statement, /目录里没有版本层，版本未知/);
    assert.match(row('other-root').statement, /目录树的根“合成平台”不是产品线的名称/);
    assert.match(row('unbound-run').statement, /运行没有绑定产品线/);
    assert.match(row('declared-line-conflict').statement, /调用方声明的版本线 10\.7\.3 与目录给出的版本 10\.6\.1 矛盾/);
    assert.match(row('declared-product-fills-a-missing-root').statement, /产品线来自调用方声明，未经目录树核对/);
    assert.match(row('several-line-nodes').statement, /目录里有几个版本线节点（9\.8、10\.6）/);
    assert.match(row('train-of-another-line').statement, /发布火车 10\.6\.2-R2-2026\/7 的版本与版本线 10\.6\.1 不一致/);
    assert.match(row('folder-with-build-number').statement, /版本只是目录名里顺带提到的（10\.6\.1\.57）/);
    assert.match(row('declared-line-node-on-a-contradicting-tree').statement, /目录版本层自相矛盾：目录里有几个版本线节点/);
    // The folders are the system pack's metadata of the read, not a cited fragment.
    for (const id of ['full-nsae', 'other-root', 'declared-line-conflict']) assert.match(row(id).statement, /目录是敏捷平台读取时列出的，取自系统包的元数据，没有引用片段/, id);
  });

  it('gives one summary line with the answer, its confidence and what is only a reference', () => {
    const summary = (id: string, overrides: Partial<LocateInput> = {}) => {
      const { answer, judgment } = locateItem(inputOf(ROWS.find((r) => r.id === id)!, overrides));
      return summaryOf(answer, judgment);
    };
    assert.equal(summary('full-nsae'), '产品线 apv（NSAE）；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R2-2026/7；模块 SSL；未分类编号 90101');
    assert.match(summary('title-only'), /^不确定（版本只在标题里）：产品线 apv（NSAE）；版本 10\.6\.2\.31（标题，置信度低）/);
    assert.match(summary('declared-line-conflict'), /^与声明矛盾（声明的版本线 10\.7\.3 与目录的 10\.6\.1 矛盾）：产品线 apv（NSAE）/);
    assert.match(summary('other-root'), /^不确定（根“合成平台”不是产品名称）：产品 合成平台（产品线未定）；版本 10\.6\.1/);
    assert.equal(
      summary('several-line-nodes'),
      '目录版本层自相矛盾（目录里有几个版本线：9.8、10.6）：产品线 apv（NSAE）；版本 9.8（目录，置信度低）；版本线 10.6；发布火车 10.6-主线-2026/01；模块 SLB',
    );
    assert.equal(summary('title-build-date-beside-a-title-version'), '不确定（版本只在标题里）：产品线 apv（NSAE）；版本 10.6.2.31（标题，置信度低）；构建日期 20260315（标题，参考）');
    assert.equal(summary('older-line-build-name'), '产品线 apv（NSAE）；版本 10.9.1（目录，置信度高）；写出的构建名 Rel_NSAE_10_9_1_37');
    assert.equal(summary('requirement-in-a-deeper-folder'), '产品线 apv（NSAE）；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R2-2026/7；模块 SSL；需求 20931（目录）');
    assert.equal(summary('story-range-alone'), '产品线 apv（NSAE）；版本 10.6.1（目录，置信度高）；发布火车 10.6.1-R2-2026/7；模块 SSL；未分类编号 74001、33001（声明的范围：需求）');
  });
});

describe('the associated ids in the conclusion', () => {
  const answer = (ids: { requirements?: string[]; defects?: string[]; unclassified?: string[] }): LocateAnswer => ({
    case_id: 'doc-1:n1',
    product_line: 'apv',
    product_name: 'NSAE',
    version: '10.6.1',
    version_values: [],
    missing: [],
    build: null,
    patch: null,
    line: '10.6.1',
    train: null,
    module: null,
    ancestor_path: [],
    version_source: 'folders',
    confidence: 'high',
    build_source: 'title',
    patch_source: 'title',
    source: null,
    build_names: [],
    requirements: ids.requirements ?? [],
    defects: ids.defects ?? [],
    unclassified: ids.unclassified ?? [],
    id_sources: [],
    ranged: { requirements: [], defects: [] },
    declared: [],
    conflicts: [],
    notes: [],
  });
  const ids = (prefix: string, count: number, from = 1): string[] => Array.from({ length: count }, (_, i) => `${prefix}${String(from + i).padStart(3, '0')}`);

  it('lists every id grouped by kind when there are 6 across the three kinds', () => {
    const text = described(answer({ requirements: ids('31', 2), defects: ids('61', 2), unclassified: ids('71', 2) }));
    assert.match(text, /需求 31001、31002(；|$)/);
    assert.match(text, /缺陷 61001、61002(；|$)/);
    assert.match(text, /未分类编号 71001、71002(；|$)/);
    assert.ok(!text.includes('另有'), text);
    assert.ok(!text.includes('等 6 个'), text);
    // every id of every kind is present, in kind order
    assert.ok(text.indexOf('需求') < text.indexOf('缺陷') && text.indexOf('缺陷') < text.indexOf('未分类编号'), text);
  });

  it('lists every id when there are exactly 20', () => {
    const text = described(answer({ requirements: ids('31', 8), defects: ids('61', 7), unclassified: ids('71', 5) }));
    for (const id of [...ids('31', 8), ...ids('61', 7), ...ids('71', 5)]) assert.ok(text.includes(id), `${id} in ${text}`);
    assert.ok(!text.includes('另有'), text);
  });

  it('lists the first 20 and writes 另有 N 个 when there are 21', () => {
    const text = described(answer({ requirements: ids('31', 8), defects: ids('61', 7), unclassified: ids('71', 6) }));
    for (const id of [...ids('31', 8), ...ids('61', 7), ...ids('71', 5)]) assert.ok(text.includes(id), `${id} in ${text}`);
    assert.ok(!text.includes('71006'), `the 21st id is not listed: ${text}`);
    assert.match(text, /另有 1 个$/, text);
    assert.match(text, /未分类编号 71001、71002、71003、71004、71005；另有 1 个$/, 'the cap cuts inside the last shown group');
  });

  it('keeps the source marks of an id in the full listing', () => {
    const withSources = answer({ unclassified: ['71001', '71002', '71003'] });
    withSources.id_sources = [
      { id: '71001', kind: null, from: ['title'] },
      { id: '71002', kind: null, from: ['folders'] },
      { id: '71003', kind: null, from: ['map'] },
    ];
    withSources.ranged = { requirements: ['71003'], defects: [] };
    const text = described(withSources);
    assert.match(text, /未分类编号 71001、71002（目录）、71003（脑图；声明的范围：需求）/);
  });
});

describe('metamorphic properties', () => {
  const comparable = (answer: LocateAnswer, hasRoot: boolean): Record<string, unknown> => {
    const { product_line: _l, product_name: _n, notes: _o, ancestor_path, ...rest } = answer;
    return { ...rest, ancestor_path: ancestor_path.slice(hasRoot ? 1 : 0) };
  };
  const plain = ROWS.filter((r) => r.declared?.product === undefined && r.id !== 'root-repeated-as-folder');

  it('the same path under another root name changes only the product', () => {
    for (const row of plain) {
      const before = locate(inputOf(row));
      for (const root of ['APV', 'NSAE', '合成平台', 'ＡＰＶ']) {
        const after = locate(inputOf(row, { root }));
        assert.deepEqual(comparable(after, true), comparable(before, row.root !== null), `${row.id} under ${root}`);
        if (root !== '合成平台' && !row.unbound) assert.equal(after.product_line, 'apv', `${row.id} under ${root}`);
        if (root === '合成平台') assert.deepEqual([after.product_line, after.product_name], [null, '合成平台']);
      }
    }
  });

  it('adding a deeper folder that mentions another version changes neither the version nor its confidence', () => {
    const versioned = ROWS.filter((r) => r.expect.source === 'folders');
    assert.ok(versioned.length >= 30);
    for (const row of versioned) {
      const before = locate(inputOf(row));
      for (const quote of ['9.9.9 迁移引用', 'SSL（11.0.1 引入）', '兼容 10.2.8.3 升级']) {
        // At the end: nothing but the path and the notes change.
        const appended = locate(inputOf(row, { ancestors: [...row.ancestors, quote] }));
        const { ancestor_path: _a, notes: _n, ...rest } = appended;
        const { ancestor_path: _b, notes: _m, ...expectedRest } = before;
        assert.deepEqual(rest, expectedRest, `${row.id} + ${quote}`);
        // Anywhere below the folder that gives the version: the version, its source and its confidence stay.
        const labels = row.ancestors.filter((a) => a !== row.root);
        const versionLabel = before.version_values.find(value => value.version === before.version);
        const at = versionLabel ? versionLabel.level - 1 : labels.findIndex((label) => label.normalize('NFKC').includes(before.version!));
        assert.ok(at >= 0, row.id);
        for (let k = at + 1; k <= labels.length; k++) {
          const inserted = locate(inputOf(row, { ancestors: [...labels.slice(0, k), quote, ...labels.slice(k)] }));
          assert.deepEqual([inserted.version, inserted.version_source, inserted.confidence], [before.version, before.version_source, before.confidence], `${row.id}: ${quote} at ${k}`);
        }
      }
    }
  });

  it('a version mentioned above the version level is a quote; a version label above it that disagrees proves a conflict', () => {
    const row = ROWS[0];
    const mentioned = locateItem(inputOf(row, { ancestors: ['APV 9.9 系列', ...row.ancestors] }));
    assert.deepEqual([mentioned.answer.version, mentioned.answer.confidence, mentioned.judgment.verdict], ['10.6.1', 'high', 'support']);
    const labelled = locateItem(inputOf(row, { ancestors: ['010：9.9', ...row.ancestors] }));
    assert.deepEqual([labelled.answer.version, labelled.answer.line, labelled.answer.confidence, labelled.judgment.verdict], ['9.9', '10.6.1', 'low', 'refute']);
    const agreeing = locateItem(inputOf(row, { ancestors: ['061：10.6.1', ...row.ancestors] }));
    assert.deepEqual([agreeing.answer.version, agreeing.judgment.verdict], ['10.6.1', 'support']);
    // Without a version level the mention nearest the root is the reference version.
    const nearest = locate(inputOf(row, { ancestors: [P0, 'APV 9.9 系列', '专项 10.5 回归'] }));
    assert.deepEqual([nearest.version, nearest.version_source, nearest.confidence], ['9.9', 'folders', 'low']);
  });

  it('a case item locates like its document; its map path and title add ids but never a version', () => {
    const row = ROWS.find((r) => r.id === 'case-item')!;
    const asCase = locate(inputOf(row));
    const asDocument = locate(inputOf({ ...row, kind: undefined }));
    for (const key of ['product_line', 'product_name', 'version', 'line', 'train', 'module', 'version_source', 'confidence', 'build', 'patch'] as const) {
      assert.deepEqual(asCase[key], asDocument[key], key);
    }
    const versionless = locate(inputOf({ ...row, ancestors: [P0, '专项'], title: '专项回归', path: ['10.6.1 功能'], case_title: 'NSAE 10.6.1.57 验证' }));
    assert.deepEqual([versionless.version, versionless.version_source], [null, 'none']);
  });

  it('does not depend on the order of the names of the line', () => {
    for (const row of ROWS) {
      if (row.unbound) continue;
      const a = locate(inputOf(row));
      const b = locate(inputOf(row, { names: ['NSAE', 'APV'] }));
      assert.deepEqual({ ...b, notes: [] }, { ...a, notes: [] }, row.id);
    }
  });

  it('never lists a build name that is not written in the item texts', () => {
    const random = seeded(11);
    const parts = ['Rel_NSAE_10_9_1_37 回归', 'Rel_APV_10_6_1_57', 'NSAE_10.9.1.37_专项', '060：10.6.4', '004：10.6.4-R2-2026/7', 'HA', 'Rel_FOO_1_2_3_4', 'V10.6.1.57'];
    for (let i = 0; i < 200; i++) {
      const ancestors = [P0, ...Array.from({ length: random.int(5) }, () => random.pick(parts))];
      const title = random.pick(['NSAE 10.6.2.31 升级', 'Rel_APV_10_7_0_3 对比', '回归', 'build20260315']);
      const answer = locate({ case_id: `b${i}`, root: 'NSAE', ancestors, title, ...LINE });
      const written = [...ancestors, title].join(' ');
      for (const name of answer.build_names) assert.ok(written.includes(name), `${name} is not written in ${written}`);
      assert.ok(!answer.build_names.some((n) => n.includes('FOO')));
    }
  });
});

describe('the scheme on bad input', () => {
  it('is total and deterministic on hostile and random input', () => {
    for (const [k, input] of hostileInputs().entries()) {
      const result = assertTotal(locateFunction, input, `hostile ${k}`) as { answer: LocateAnswer; judgment: { verdict: string } };
      assert.ok(['support', 'unknown', 'refute'].includes(result.judgment.verdict));
    }
    const random = seeded(7);
    const labels = ['060：10.6.1', '004：10.6.1-R2-2026/7', 'SSL', P0, 'bug to case 61001', '10.6', '：', '000-001-002：HA', 'patch1.2', 'build20260101', 'Rel_APV_10_6_1_5', '\u0000', '０６０：', 'TLS1.3', '010：9.8', 'V10.7.0'];
    for (let i = 0; i < 400; i++) {
      const ancestors = Array.from({ length: random.int(7) }, () => random.pick(labels));
      const input = { case_id: `r${i}`, root: random.pick(['NSAE', 'APV', null, '']), ancestors, title: random.pick([null, '需求20931 x', 'NSAE 10.6.2.31', '']), names: LINE.names, product: LINE.product };
      const result = assertTotal(locateFunction, input, JSON.stringify(input)) as { answer: LocateAnswer; judgment: { verdict: string } };
      if (result.answer.version !== null) assert.match(result.answer.version, /^[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}$/);
      // A fact always has a consistent version level: high confidence and no declaration.
      if (result.judgment.verdict === 'support') assert.deepEqual([result.answer.confidence, result.answer.version_source, result.answer.declared], ['high', 'folders', []]);
      assert.ok(result.answer.notes.every((n) => !n.startsWith('内部错误')), JSON.stringify(result.answer.notes));
    }
  });

  it('reads declarations by the parameter rules, also on a direct call', () => {
    const row = ROWS[0];
    for (const declared of [{ line: 'abc' }, { line: '10.6.x' }, { product: '   ' }, { line: 7 }, { product: ['NSAE'] }]) {
      const { answer, judgment } = locateItem(inputOf(row, { declared: declared as never }));
      assert.deepEqual([answer.conflicts, answer.declared, judgment.verdict], [[], [], 'support'], JSON.stringify(declared));
    }
    assert.equal(locate(inputOf(row, { declared: { line: 'V10.7.3' } })).conflicts[0]?.declared, '10.7.3');
    // An unbound run is the reason the product line stays open, whatever else was declared; it cannot tell whether a declared
    // name and the root name one line, so it reports no conflict.
    const unbound = locateItem(inputOf(row, { names: [], product: null, declared: { product: '合成平台' } }));
    assert.match(unbound.judgment.statement, /产品线定不出（运行没有绑定产品线）/);
    assert.deepEqual([unbound.judgment.verdict, unbound.answer.conflicts, unbound.answer.product_name], ['unknown', [], 'NSAE']);
  });

  it('bounds what it reads and what it returns', () => {
    const many = Array.from({ length: 200 }, (_, k) => `${String(k).padStart(3, '0')}：10.6.${k % 9}${'x'.repeat(3000)}`);
    const answer = locate({ case_id: 'big', root: 'NSAE', ancestors: many, title: `${'需求20931 '.repeat(500)}`, ...LINE });
    assert.ok(answer.notes.some((n) => n.includes('只看前 64 层')));
    assert.ok(answer.ancestor_path.length <= 65 && answer.ancestor_path.every((t) => [...t].length <= 200));
    assert.ok(answer.notes.length <= 16 && answer.requirements.length <= 50 && answer.id_sources.length <= 150);
    const names = locate({ case_id: 'names', root: 'NSAE', ancestors: [P0, Array.from({ length: 40 }, (_, k) => `Rel_APV_10_6_1_${k}`).join(' ')], title: 'x', ...LINE });
    assert.equal(names.build_names.length, 24);
  });

  it('reads the item fields and the run facts the check and the projection pass', () => {
    const input = locateInputOf('d1', { kind: 'document', root: 'NSAE', ancestors: FULL, title: 'SSL', source: 'agile:mindmap:24001@1', path: [], case_title: null }, { ...LINE, parameters: { line: 'V10.6', product: 'APV', id_ranges: { bug: { min: 50000 } } } });
    assert.deepEqual(input, {
      case_id: 'd1',
      kind: 'document',
      root: 'NSAE',
      ancestors: FULL,
      title: 'SSL',
      path: [],
      case_title: null,
      source: 'agile:mindmap:24001@1',
      names: ['APV', 'NSAE'],
      product: 'apv',
      declared: { product: 'APV', line: '10.6' },
      id_ranges: { bug: { min: 50000 } },
    });
    assert.equal(locate(input).source, 'agile:mindmap:24001@1');
    assert.deepEqual(locateInputOf('x', null, {}).names, []);
  });
});
