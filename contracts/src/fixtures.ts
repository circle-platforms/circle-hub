// Synthetic examples of the contract shapes, shared by the contracts tests. Not part of the API; every value is made up.
import { createHash } from 'node:crypto';
import { PARTITION, type Partition } from '../generated/vocabulary.ts';
import { partitionCountsOf, type Partitions } from './validation.ts';

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const H = sha('one');
export const H2 = sha('two');
export const H3 = sha('three');
export const RUN = 'run_01jacd5z8q3w7v9h2k4m6n8p0r';
export const USER = 'usr_01jacd5z8q3w7v9h2k4m6n8p0s';
export const ADMIN = 'usr_01jacd5z8q3w7v9h2k4m6n8p0t';
export const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
export const TRACE2 = '00f067aa0ba902b74bf92f3577b34da6';

/** A JSON copy, so a test can change it freely. */
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A manifest with the given partitions filled and every other partition empty. */
export function partitions(filled: Partial<Record<Partition, unknown[]>>): Record<Partition, unknown[]> {
  return Object.fromEntries(PARTITION.map((p) => [p, filled[p] ?? []])) as Record<Partition, unknown[]>;
}

export const claim = {
  item: 'doc-1:n7',
  requirement: 'catalog',
  pointer: '/items/0/slots/findings/0',
  statement: { text: '参数取值超出目录声明的范围', verdict: 'refute', code: 'core.catalog.param_out_of_range', data: { parameter: 'port' } },
  qualifier: {
    nature: 'fact',
    provenance: 'projected',
    basis_rank: 'rule_over_observation',
    source_role: 'expected',
    marks: [],
    coverage: { complete: true, examined: 3, total: 3 },
    collected_at: '2026-10-21T08:00:00.000Z',
    discriminating_power: 'not_established',
  },
  grounds: [`tree:${H}/commands/show`, `src:${H2}/mindmap@1/n7`],
  warrant: { producer: 'function', id: 'catalog@1' },
  resolution: 'resolved',
  resolutions: [
    { pointer: '/items/0/slots/findings/0/command', text: 'show item', resolution: 'resolved', references: [`tree:${H}/commands/show@${H3}`] },
    { pointer: '/items/0/slots/findings/0/quotes/0', text: '端口 70000', resolution: 'resolved', references: [`src:${H2}/mindmap@1/n7:0-12`] },
  ],
  validity: { status: 'valid', bound: [H, H2], premises: [] },
};

export const judgment = {
  statement: { text: '期望结果没有写清楚判定条件', code: 'review.unclear_expectation', rank: 'major' },
  qualifier: { nature: 'judgment', provenance: 'declared', basis_rank: 'judgment', marks: ['semantics_unasserted', 'independence_declared'] },
  grounds: [`src:${H2}/mindmap@1/n7`],
  warrant: { producer: 'model', id: 'scripted-model@test', independence: 'judge_not_author' },
  validity: { status: 'valid', bound: [H2], premises: [], expires_at: '2026-12-31T00:00:00Z' },
};

export const submission = {
  run: RUN,
  model: 'scripted-model@test temperature=0',
  items: [
    { item: 'doc-1:n7', handling: 'handled', slots: { findings: [{ code: 'unclear_expectation', rank: 'major' }] }, context: H },
    { item: 'doc-1:n8', handling: 'skipped', reason: '用例已废弃' },
    { item: 'doc-1:n9', handling: 'handled', reuse: `rec:${H3}#/partitions/delivered/0` },
  ],
  cross_item: [
    { nature: 'fact', statement: '三个用例共用同一前置条件', grounds: [`src:${H2}/mindmap@1/n1`] },
    { nature: 'judgment', statement: '前置条件应抽到父节点', grounds: [], premises: ['/cross_item/0'], code: 'structure_hint', rank: 'minor' },
  ],
  notes: '合成样例',
};

export const RECOVERY = {missing:'合成的待补工作',exit:{action:'request',request_kind:'repair',audience:{user:USER},due:'2026-11-01T12:00:00.000Z'}} as const;

const delivered = {
  item: 'doc-1:n7',
  label: '端口越界',
  location: `src:${H2}/mindmap@1/n7`,
  requirements: [
    { requirement: 'structure', layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', claims: [] },
    {
      requirement: 'catalog',
      layers: [{ layer: 'static', terminal: 'violation', code: 'core.catalog.param_out_of_range', tier: 'advisory' }],
      status: 'satisfied',
      claims: [claim],
    },
    {
      requirement: 'findings',
      layers: [{ layer: 'static', terminal: 'violation', code: 'core.catalog.membership_contradicted', attribution: 'producer_error' }],
      status: 'unsatisfied',
      unsatisfied_reason: 'outcome_mismatch',
      claims: [judgment],
    },
  ],
};
const carried = {
  item: 'doc-1:n9',
  label: '未改动的用例',
  location: `src:${H2}/mindmap@1/n9`,
  carried_over: `rec:${H3}#/partitions/delivered/0`,
  requirements: [
    { requirement: 'structure', layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', claims: [] },
    { requirement: 'catalog', layers: [{ layer: 'static', terminal: 'unchecked', reason: 'no_check', ...RECOVERY,missing:'包中未安装的合成检查',exit:{...RECOVERY.exit,audience:{user:ADMIN}} }], status: 'pending', claims: [] },
  ],
};
const skipped = {
  item: 'doc-1:n8',
  label: '已废弃',
  location: `src:${H2}/mindmap@1/n8`,
  reason: 'declared_skip',
  requirements: [{ requirement: 'structure', layers: [{ layer: 'static', terminal: 'incomplete', reason: 'declared_skip', ...RECOVERY,missing:'被跳过条目的合成提交' }], status: 'pending', claims: [] }],
};

export const accepted = {
  schema: 'validation@1',
  run: RUN,
  submission: H,
  acceptance: 'accepted',
  errors: [],
  rounds: { used: 1, max: 3 },
  partitions: partitions({ delivered: [delivered, carried], incomplete: [skipped] }),
  cross_item: [judgment],
  coverage: { complete: true, examined: 3, total: 3 },
  locks: { pack: 'review@1.0.0', pack_digest: H, root: H2 },
  trace: TRACE,
};

export const notAccepted = {
  ...accepted,
  acceptance: 'not_accepted',
  errors: [
    {
      code: 'QUOTE_MISMATCH',
      message: '原文与引用对不上',
      fix: '按原文逐字引用',
      path: '/items/0/slots/findings/0/quotes/0',
      item: 'doc-1:n7',
      requirement: 'findings',
      rounds_left: 2,
    },
  ],
  partitions: partitions({}),
  cross_item: [],
};

export const summary = {
  run: RUN,
  pack: 'review@1.0.0',
  pack_digest: H,
  product: 'line-a',
  version: '2.1',
  build: 'build-2.1-7',
  target_basis: [
    {
      statement: { text: '按包规则选定该版本线最新的已发布构建', data: { field: 'build', value: 'build-2.1-7' } },
      qualifier: { nature: 'fact', provenance: 'projected', basis_rank: 'rule_over_observation', marks: [], collected_at: '2026-10-21T08:00:00Z' },
      grounds: [`src:${H2}`],
      warrant: { producer: 'function', id: 'latest-release@1' },
      validity: { status: 'valid', bound: [H2], premises: [] },
    },
  ],
  root: H2,
  sources: [
    { reference: `src:${H}`, role: 'subject', slot: 'mindmap', external: 'mind-map:document:1@3', media_type: 'application/json' },
    { reference: `src:${H2}`, role: 'expected', external: 'tracker:story:42@7', label: '合成需求' },
  ],
  requirements: [{ key: 'structure', name: '结构', description: '用例结构', layers: ['static'], done_rule: 'bookkeeping', accepted_producer: 'fact', repair_rounds: 2, rules: [], run_interpreters: [] }],
  items: [{ id: 'doc-1:n7', label: '端口越界', location: `src:${H}/mindmap@1/n7`, fields: { priority: 1 }, digest: H2, reuse: `rec:${H}#/partitions/delivered/0` }],
  slots: {
    schema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { findings: { type: 'array' } }, additionalProperties: false },
    sha256: H3,
  },
  instructions: '按规程评审每个用例。',
  instructions_digest: sha('按规程评审每个用例。'),
  session: 'session-1',
  started_at: '2026-10-21T08:00:00Z',
};

export const runRecord = {
  ...summary,
  runner: USER,
  host: 'local_circle',
  trigger: 'session',
  parameters: { strict: true },
  client_key: 'k-1',
  request_digest: H3,
  client_key_expires_at: '2026-10-21T09:00:00Z',
};

/** A standing obligation the Hub executes itself: no runner, an admin configured it. */
export const hubRun = { ...summary, host: 'hub', trigger: 'standing_obligation', configurer: ADMIN, parameters: {} };

export const packSummary = {
  pack: 'review@1.0.0',
  id: 'review',
  version: '1.0.0',
  kind: 'workflow',
  title: '用例评审',
  description: '合成的评审包',
  products: ['line-a', 'line-a-alias'],
  inputs: [{ slot: 'mindmap', role: 'subject', description: '被评审的脑图', accepts: ['application/json', 'mind-map:document'], required: true, many: false }],
  parameters: [{ name: 'strict', description: '严格模式', required: false }],
  requirements: summary.requirements,
};

export const unavailable = { code: 'SOURCE_UNAVAILABLE', message: '对你不可用', fix: '无；真实原因只在管理员日志里' };

/** Counts of the accepted fixture, derived the only way they may be. */
export const acceptedCounts = (): ReturnType<typeof partitionCountsOf> => partitionCountsOf(accepted.partitions as unknown as Partitions);
