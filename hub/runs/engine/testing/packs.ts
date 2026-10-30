// Synthetic packs of a toy domain (an irrigation controller with zones and valves), written into temporary directories with a
// real pack.json manifest and real function files, so that the engine's tests run the real sandbox, the real interpreters and
// the real boundary. Nothing here names a real product, command or customer.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LAYER, type PackKind } from '../../../../contracts/generated/vocabulary.ts';
import type { ChecksFile, PackManifest, RequirementsFile, RequirementTemplate, SlotsFile, WorkflowFile } from '../../../../contracts/src/pack.ts';
import type { ProductDeclaration } from '../../../../contracts/src/product.ts';

const FUNCTIONS = new URL('./functions/', import.meta.url);

/** File content: text, JSON, or a synthetic pack function copied from testing/functions. */
export type PackFile = string | { json: unknown } | { function: string };

export interface PackSpec {
  id: string;
  version: string;
  kind: PackKind;
  title: string;
  description: string;
  files: Record<string, PackFile>;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Writes the pack files and its pack.json manifest (files sorted by path with SHA-256 and size); returns the directory. */
export async function writePack(root: string, spec: PackSpec): Promise<string> {
  const dir = join(root, `${spec.id}-${spec.version}`);
  const files: PackManifest['files'] = [];
  for (const [path, content] of Object.entries(spec.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    if (typeof content === 'string') await writeFile(target, content);
    else if ('json' in content) await writeFile(target, `${JSON.stringify(content.json, null, 2)}\n`);
    else await copyFile(new URL(content.function, FUNCTIONS), target);
    const bytes = new Uint8Array(await readFile(target));
    files.push({ path, sha256: sha256(bytes), size: bytes.length });
  }
  const manifest: PackManifest = { schema: 'pack@1', id: spec.id, version: spec.version, kind: spec.kind, title: spec.title, description: spec.description, files };
  await writeFile(join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

// ---------------------------------------------------------------- the draft review pack

const PROBES = [
  { code: 'literal_issue', label: '字面问题' },
  { code: 'coverage_gap', label: '覆盖缺口' },
  { code: 'differentiation_gap', label: '区分缺口' },
  { code: 'edge_case_gap', label: '边界缺口' },
  { code: 'negative_gap', label: '反向缺口' },
  { code: 'block_structure_mismatch', label: '分块与行为不符' },
  { code: 'self_contradiction', label: '自相矛盾' },
];
const SEVERITY = [
  { code: 'critical', label: '严重' },
  { code: 'major', label: '一般' },
  { code: 'minor', label: '轻微' },
];
export const LEVELS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'].map((code) => ({ code, label: `等级 ${code}` }));
const NEGATIVE_CODES = ['core.catalog.param_out_of_range', 'core.catalog.param_type_mismatch', 'core.catalog.arity_mismatch'];

const requirement = (r: Partial<RequirementTemplate> & Pick<RequirementTemplate, 'key' | 'name' | 'accepted_producer' | 'checks'>): RequirementTemplate => ({
  description: `${r.name}（合成）`,
  target: 'item',
  required: true,
  done_rule: 'bookkeeping',
  layers: ['static'],
  error_handling: [],
  ...r,
  ...(r.accepted_producer==='fact'&&r.layers?.includes('dynamic')?{observation:r.observation??'synthetic-observation@1'}:{}),
});

export interface ReviewOptions {
  version?: string;
  /** Add a fact requirement whose check throws, times out or returns a synthetic unknown reason. */
  fragile?: 'boom' | 'spin' | 'output_failed' | 'bogus_reason';
  /** Accept the independence the client declares on findings (default true). */
  acceptsDeclared?: boolean;
  /** Declare the dynamic layer on the catalog requirement too. */
  dynamic?: boolean;
  /** Declare the dynamic layer on the findings requirement too. */
  dynamicFindings?: boolean;
  /** Give the structure requirement (a check on the target) a `*` repair row, which never applies to the target. */
  subjectRepair?: boolean;
  /** Ship one externally retained delivered sample for each named check (clears the author-only mark, T02 R[1]). */
  externalSamples?: string[];
  /** Add the data_quotes check: a quote@1 table reaching a reference deep inside slot data. */
  dataQuotes?: boolean;
  /** Add the self_cited check: a pack function that cites the item's own location as the ground of a support. */
  selfCited?: boolean;
  /** Give the data_quotes check a read declaration with this byte cap (it reads the hint sources). */
  dataQuotesMaxBytes?: number;
  /** Replace the JSON Schema of the findings' `data`. */
  findingsData?: Record<string, unknown>;
  /** Replace the JSON Schema of the `strict` parameter. */
  parameterSchema?: Record<string, unknown>;
}

export function reviewPack(options: ReviewOptions = {}): PackSpec {
  const requirements: RequirementTemplate[] = [
    requirement({ key: 'structure', name: '结构', accepted_producer: 'fact', checks: ['structure'], ...(options.subjectRepair ? { error_handling: [{ code: '*', action: 'repair', max_rounds: 1 }] } : {}) }),
    requirement({
      key: 'catalog',
      name: '命令目录',
      accepted_producer: 'fact',
      checks: ['catalog'],
      ...(options.dynamic ? { layers: [...LAYER] } : {}),
      expected: { overrides: [{ when: { pointer: '/negative', equals: true }, outcome: 'refute', codes: NEGATIVE_CODES }] },
    }),
    requirement({
      key: 'findings',
      name: '评审发现',
      accepted_producer: 'independent_judgment',
      independent_of: 'predecessor',
      ...(options.acceptsDeclared === false ? {} : { accepts_declared_independence: true }),
      ...(options.dynamicFindings ? { layers: [...LAYER] } : {}),
      checks: ['findings_quotes', 'findings_catalog', 'findings_rank', 'findings_grounds', ...(options.dataQuotes ? ['data_quotes'] : []), ...(options.selfCited ? ['self_cited'] : [])],
      error_handling: [
        { code: 'core.catalog.membership_contradicted', action: 'repair', max_rounds: 2 },
        { code: 'toy-review.rank_too_low', action: 'reject' },
      ],
    }),
    requirement({ key: 'level', name: '初评等级', target: 'run', accepted_producer: 'judgment', checks: [] }),
  ];
  if (options.fragile) requirements.push(requirement({ key: 'fragile', name: '易坏的检查', accepted_producer: 'fact', checks: ['fragile'] }));
  const checks: ChecksFile = {
    schema: 'checks@1',
    checks: [
      { id: 'structure', interpreter: 'structure@1', table: 'tables/structure.json', applies: 'run', judges: 'subject', tier: 'blocking' },
      { id: 'catalog', interpreter: 'catalog@1', table: 'tables/catalog.json', applies: 'item', catalog: 'commands@1', judges: 'subject', tier: 'blocking' },
      { id: 'findings_quotes', interpreter: 'quote@1', table: 'tables/findings-quotes.json', applies: 'item', judges: 'artifact_under_verification', tier: 'blocking' },
      ...(options.dataQuotes
        ? [{ id: 'data_quotes', interpreter: 'quote@1' as const, table: 'tables/data-quotes.json', applies: 'item' as const, judges: 'artifact_under_verification' as const, tier: 'blocking' as const, ...(options.dataQuotesMaxBytes ? { reads: { roles: ['hint' as const], max_bytes: options.dataQuotesMaxBytes } } : {}) }]
        : []),
      { id: 'findings_catalog', interpreter: 'catalog@1', table: 'tables/findings-catalog.json', applies: 'item', catalog: 'commands@1', judges: 'artifact_under_verification', tier: 'blocking' },
      {
        id: 'findings_rank',
        function: { module: 'functions/rank.ts' },
        applies: 'item',
        judges: 'artifact_under_verification',
        tier: 'blocking',
        basis: '要求项 findings：自相矛盾的发现至少是一般等级',
      },
      {
        id: 'findings_grounds',
        function: { module: 'functions/grounds.ts' },
        applies: 'item',
        judges: 'artifact_under_verification',
        tier: 'blocking',
        basis: '要求项 findings：关于产品行为的发现要有线索以外的根据',
      },
      ...(options.fragile ? [{ id: 'fragile', function: { module: `functions/${options.fragile}.ts` }, applies: 'item' as const, judges: 'subject' as const, tier: 'advisory' as const }] : []),
      ...(options.selfCited ? [{ id: 'self_cited', function: { module: 'functions/self-cited.ts' }, applies: 'item' as const, judges: 'artifact_under_verification' as const, tier: 'advisory' as const, basis: '要求项 findings：条目原文可读（合成，引用条目自身作根据）' }] : []),
    ],
  };
  const workflow: WorkflowFile = {
    schema: 'workflow@1',
    inputs: [
      { slot: 'map', role: 'subject', description: '被评审的脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false },
      { slot: 'notes', role: 'hint', description: '历史用例清单（线索）', accepts: ['text/markdown', 'text/plain'], required: false, many: true },
    ],
    parameters: [{ name: 'strict', description: '严格模式（合成参数）', required: false, schema: options.parameterSchema ?? { type: 'boolean' } }],
    product: { catalogs: ['commands@1'] },
    subject: 'map',
    projection: { module: 'functions/project.ts' },
    expected_sources: { module: 'functions/expected.ts' },
  };
  const slots: SlotsFile = {
    schema: 'slots@1',
    item: {
      findings: {
        codes: PROBES,
        ranks: SEVERITY,
        min: 0,
        max: 10,
        evidence: true,
        data: options.findingsData ?? { type: 'object', properties: { suggestion: { type: 'string' }, ...(options.dataQuotes ? { expected_quote: { type: 'object', properties: { text: { type: 'string' }, reference: { type: 'string' } }, required: ['text', 'reference'], additionalProperties: false } } : {}) }, additionalProperties: false },
      },
    },
    run: { level: { codes: [{ code: 'draft_level', label: '初评等级' }], ranks: LEVELS, min: 1, max: 1 } },
  };
  const files: Record<string, PackFile> = {
    'workflow.json': { json: workflow },
    'requirements.json': { json: { schema: 'requirements@1', requirements } satisfies RequirementsFile },
    'checks.json': { json: checks },
    'slots.schema.json': { json: slots },
    'SKILL.md': '# 合成用例评审\n\n逐条用例给出发现：位置、描述、逐字引文和等级；最后给出整份的初评等级。\n',
    'tables/structure.json': {
      json: {
        schema: 'structure@1',
        origin: '决定：合成测试包 toy-review 的 structure 要求项',
        tier: 'blocking',
        basis: '要求项 structure：标题非空、至少一个期望结果、同一路径下标题不重复',
        nodes: '$.items[*]',
        item: '/id',
        location: '/location',
        rules: [
          {
            fields: [
              { path: '/fields/title', required: true, type: 'string' },
              { path: '/fields/expected', required: true, type: 'array', minItems: 1, items: { required: true, type: 'string' } },
            ],
            unique: [{ key: ['/fields/title'], within: 'group', group: ['/fields/path'] }],
          },
        ],
      },
    },
    'tables/catalog.json': {
      json: {
        schema: 'catalog@1',
        origin: '决定：合成测试包 toy-review 的 catalog 要求项',
        tier: 'blocking',
        basis: '要求项 catalog：用例命令解析到锁定构建的目录，参数在范围内',
        item: '/item',
        location: '/location',
        catalog: 'commands',
        commands: ['$.fields.commands'],
        scope: 'resolved',
        negative: { flag: '/fields/negative', expect: NEGATIVE_CODES, tier: 'advisory' },
      },
    },
    'tables/data-quotes.json': {
      json: {
        schema: 'quote@1',
        origin: '合成：槽位数据深处（data.expected_quote）的引文，边界不解析它',
        tier: 'blocking',
        basis: '要求项 findings：引文逐字出现在所引片段里（引用只出现在槽位数据里）',
        item: '/item',
        quotes: [{ select: '$.slots.findings[*].data.expected_quote', text: '/text', reference: '/reference' }],
      },
    },
    'tables/findings-quotes.json': {
      json: {
        schema: 'quote@1',
        origin: '决定：合成测试包 toy-review 的 findings 引文',
        tier: 'blocking',
        basis: '要求项 findings：引文逐字出现在所引片段里',
        item: '/item',
        quotes: [{ select: '$.slots.findings[*].quotes[*]', text: '/text', reference: '/reference' }],
      },
    },
    'tables/findings-catalog.json': {
      json: {
        schema: 'catalog@1',
        origin: '决定：合成测试包 toy-review 的 findings 命令陈述',
        tier: 'blocking',
        basis: '要求项 findings：关于命令是否存在的陈述与目录一致',
        item: '/item',
        catalog: 'commands',
        claims: { select: '$.slots.findings[*].commands[*]', command: '/command', present: '/present' },
      },
    },
    'functions/project.ts': { function: 'review/project.ts' },
    'functions/expected.ts': { function: 'review/expected.ts' },
    'functions/rank.ts': { function: 'review/rank.ts' },
    'functions/grounds.ts': { function: 'review/grounds.ts' },
  };
  if (options.fragile) files[`functions/${options.fragile}.ts`] = { function: `review/${options.fragile}.ts` };
  if (options.selfCited) files['functions/self-cited.ts'] = { function: 'review/self-cited.ts' };
  for (const check of options.externalSamples ?? []) {
    files[`samples/external/${check}.json`] = {
      json: { id: `external_${check}`, source: 'retained_delivery', check, note: '合成外部留存交付样例（占位，发布校验只数来源）', subject: {}, expect: [] },
    };
  }
  return { id: 'toy-review', version: options.version ?? '1.0.0', kind: 'workflow', title: '合成用例评审', description: '测试用的合成评审包', files };
}

// ---------------------------------------------------------------- the verification pack

export function verifyPack(options: { acceptsDeclared?: boolean } = {}): PackSpec {
  const accepts = options.acceptsDeclared === false ? {} : { accepts_declared_independence: true };
  const requirements: RequirementTemplate[] = [
    requirement({
      key: 'verification',
      name: '逐条复核',
      accepted_producer: 'independent_judgment',
      independent_of: 'predecessor',
      ...accepts,
      checks: ['consistency'],
      error_handling: [{ code: 'toy-verify.inconsistent', action: 'repair', max_rounds: 1 }],
    }),
    requirement({ key: 'final', name: '复核结论', target: 'run', accepted_producer: 'independent_judgment', independent_of: 'predecessor', ...accepts, checks: [] }),
  ];
  return {
    id: 'toy-verify',
    version: '1.0.0',
    kind: 'workflow',
    title: '合成独立复核',
    description: '测试用的合成复核包',
    files: {
      'workflow.json': {
        json: {
          schema: 'workflow@1',
          inputs: [
            { slot: 'draft', role: 'artifact_under_verification', description: '初评的校验结果（Hub 记录引用）', accepts: ['application/json'], required: true, many: false },
            { slot: 'map', role: 'subject', description: '被评审的脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false },
          ],
          parameters: [],
          product: { catalogs: ['commands@1'] },
          subject: 'map',
          projection: { module: 'functions/project.ts' },
        } satisfies WorkflowFile,
      },
      'requirements.json': { json: { schema: 'requirements@1', requirements } satisfies RequirementsFile },
      'checks.json': {
        json: {
          schema: 'checks@1',
          checks: [
            {
              id: 'consistency',
              function: { module: 'functions/consistency.ts' },
              applies: 'run',
              judges: 'artifact_under_verification',
              tier: 'blocking',
              basis: '要求项 verification：PASS 不能同时列出被反驳的发现或新发现',
            },
          ],
        } satisfies ChecksFile,
      },
      'slots.schema.json': {
        json: {
          schema: 'slots@1',
          item: {
            verification: {
              codes: [
                { code: 'verified', label: '核实' },
                { code: 'refuted', label: '反驳' },
                { code: 'partially_correct', label: '部分正确' },
                { code: 'new_finding', label: '新发现' },
              ],
              ranks: SEVERITY,
              min: 0,
              evidence: true,
            },
          },
          run: {
            final: {
              codes: [{ code: 'verdict', label: '复核结论' }],
              ranks: [
                { code: 'PASS', label: '通过' },
                { code: 'PARTIAL', label: '部分通过' },
                { code: 'FAIL', label: '不通过' },
              ],
              min: 1,
              max: 1,
            },
          },
        } satisfies SlotsFile,
      },
      'SKILL.md': '# 合成独立复核\n\n逐条复核初评的发现，给出核实、反驳或部分正确，并给出结论。\n',
      'functions/project.ts': { function: 'verify/project.ts' },
      'functions/consistency.ts': { function: 'verify/consistency.ts' },
    },
  };
}

// ---------------------------------------------------------------- a fact-only pack (a production run)

export function locatePack(): PackSpec {
  const requirements: RequirementTemplate[] = [
    requirement({ key: 'located', name: '用例定位', accepted_producer: 'fact', checks: ['located'], required: false }),
    requirement({ key: 'tidy', name: '结构', accepted_producer: 'fact', checks: ['tidy'] }),
    requirement({ key: 'overview', name: '整份概况', target: 'run', accepted_producer: 'fact', checks: ['overview'] }),
  ];
  return {
    id: 'toy-locate',
    version: '1.0.0',
    kind: 'workflow',
    title: '合成用例定位',
    description: '只含事实要求项的合成包',
    files: {
      'workflow.json': {
        json: {
          schema: 'workflow@1',
          inputs: [{ slot: 'map', role: 'subject', description: '要定位的脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: false }],
          parameters: [],
          product: { catalogs: [] },
          subject: 'map',
          projection: { module: 'functions/project.ts' },
        } satisfies WorkflowFile,
      },
      'requirements.json': { json: { schema: 'requirements@1', requirements } satisfies RequirementsFile },
      'checks.json': {
        json: {
          schema: 'checks@1',
          checks: [
            { id: 'located', function: { module: 'functions/located.ts' }, applies: 'item', judges: 'subject', tier: 'advisory' },
            { id: 'tidy', interpreter: 'structure@1', table: 'tables/structure.json', applies: 'run', judges: 'subject', tier: 'advisory' },
            { id: 'overview', function: { module: 'functions/overview.ts' }, applies: 'run', judges: 'subject', tier: 'advisory' },
          ],
        } satisfies ChecksFile,
      },
      'slots.schema.json': { json: { schema: 'slots@1', item: {}, run: {} } satisfies SlotsFile },
      'SKILL.md': '# 合成用例定位\n\nHub 直接算出每个用例所在的分组，不需要模型填写。\n',
      'tables/structure.json': {
        json: {
          schema: 'structure@1',
          origin: '决定：合成测试包 toy-locate 的结构要求项',
          nodes: '$.items[*]',
          item: '/id',
          location: '/location',
          rules: [{ fields: [{ path: '/fields/expected', required: true, type: 'array', minItems: 1 }] }],
        },
      },
      'functions/project.ts': { function: 'review/project.ts' },
      'functions/located.ts': { function: 'locate/located.ts' },
      'functions/overview.ts': { function: 'locate/overview.ts' },
    },
  };
}

// ---------------------------------------------------------------- product packs

export function productPack(product: ProductDeclaration, withSelect: boolean): PackSpec {
  return {
    id: product.id,
    version: '1.0.0',
    kind: 'product',
    title: product.title,
    description: `${product.title}（合成）`,
    files: {
      'product.json': { json: product },
      ...(withSelect ? { 'functions/select-build.ts': { function: 'product/select-build.ts' } as PackFile } : {}),
    },
  };
}
