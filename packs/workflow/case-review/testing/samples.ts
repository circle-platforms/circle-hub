// The publish-check samples of the case-review pack (pack-sample@1), written by the pack author: every check gets positive
// and negative samples whose subject is what the check receives after its subject builder (built here with the pack's own
// builders, so the samples follow the real subject shape) and whose expectations are written out by hand. Not part of the
// pack; `node packs/workflow/case-review/testing/samples.ts write` writes samples/ and the tests compare the files with this.
// Everything is invented: the command catalog is a tiny synthetic one.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackSample } from '../../../../contracts/src/pack.ts';
import { commandSubject, scanSubject, structureSubject } from '../functions/subjects.ts';

const SHA = 'c'.repeat(64);
const ROOT = 'd'.repeat(64);
const SPEC = 'e'.repeat(64);
const HISTORY = 'f'.repeat(64);
const loc = (node: string): string => `src:${SHA}/kityminder@1/n/${node}`;

type Fields = Record<string, unknown>;
type Item = { id: string; label: string; location: string; fields: Fields };

/** A case item as the projection gives it, with what the samples change. */
export function caseItem(node: string, changes: Fields = {}): Item {
  const fields: Fields = {
    document: 'sample',
    nodeId: node,
    path: ['示例文档', '池管理'],
    title: `设置池 ${node} 的探测间隔`,
    priority: 2,
    degree: null,
    tags: ['functional'],
    tagsNormalized: ['functional'],
    expected: ['显示的探测间隔与设置一致'],
    expectedCount: 1,
    steps: [],
    preconditions: [],
    autoid: null,
    automated: false,
    negative: false,
    hasNote: false,
    nested: false,
    ...changes,
  };
  return { id: `sample:${node}`, label: String(fields.title), location: loc(node), fields };
}

const context = { product: 'sample', names: ['Sample'], line: '1.0', build: 'Rel_1_0_1', root: ROOT, parameters: {}, groups: [] };

function runSubject(items: Item[]): unknown {
  return structureSubject({ applies: 'run', items, context });
}

function itemSubject(builder: (input: unknown) => unknown, item: Item, slots: Record<string, unknown> | null): unknown {
  return builder({ applies: 'item', item, slots, evidence: [], context });
}

/** The default item subject the Hub builds for a check without a subject builder. */
function defaultSubject(item: Item, slots: Record<string, unknown> | null, evidence: unknown[]): unknown {
  return { item: item.id, label: item.label, location: item.location, fields: item.fields, slots, evidence };
}

/** A synthetic catalog (CatalogSpec of hub/rules): three commands with typed parameters. */
export const CATALOG = {
  root: ROOT,
  complete: true,
  entries: [
    { head: 'pool create', signatures: [[{ name: 'name', type: 'string', maxLength: 32 }]] },
    { head: 'health interval', signatures: [[{ name: 'pool', type: 'string' }, { name: 'seconds', type: 'int', minimum: 1, maximum: 300 }]] },
    { head: 'show pool', signatures: [[], [{ name: 'name', type: 'string' }]] },
  ],
};

const finding = (changes: Record<string, unknown> = {}): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    text: '缺少探测间隔为最大值 300 的用例',
    code: 'edge_case_gap',
    rank: 'minor',
    location: loc('c1'),
    quotes: [{ reference: `src:${SPEC}/markdown@1/s/interval`, text: '取值范围 1-300 秒' }],
    ...changes,
  };
  // A change to undefined leaves the member out (a sample is JSON).
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
};

const evidence = (reference: string, role: string, text: string | null = null) => ({ reference, resolved: true, source: reference.slice(4, 68), role, text });

type Entry = { folder: 'positive' | 'negative'; sample: PackSample };

function sample(folder: Entry['folder'], id: string, check: string, note: string, subject: unknown, expect: PackSample['expect'], extra: Partial<PackSample> = {}): Entry {
  return { folder, sample: { id, source: 'author', check, note, subject, ...extra, expect } };
}

export function samples(): Entry[] {
  const good = [caseItem('c1'), caseItem('c2', { title: '设置池 c2 的探测间隔为最大值', expected: ['探测间隔显示为 300'] })];
  const negativeCase = caseItem('n1', { tags: ['Negative'], tagsNormalized: ['Negative'], negative: true, title: '探测间隔超出范围时报错', steps: [{ text: 'health interval pool1 0', expected: ['提示取值超出范围'] }], expected: ['提示取值超出范围'] });
  const withLine = (node: string, line: string): Item => caseItem(node, { steps: [{ text: line, expected: ['显示的探测间隔与设置一致'] }] });
  const leaf=loc('e1'),quality={item:'sample:c1',location:loc('c1'),fields:{expected:['合成期望'],expectedCount:1,expectedSelectors:['n/e1']},slots:{expected_quality:[{code:'expected_quality',text:'脚本化模型主张',quotes:[{reference:leaf,text:'合成期望'}],data:{schema:'expected-quality@1',vague:false,source_sha256:SHA,expected_count:1,expected_references:[leaf]}}]}};
  const badQuality=structuredClone(quality);badQuality.slots.expected_quality[0].quotes[0].text='改写引文';
  return [
    sample('positive','expected_quality_exact','expected_quality_evidence','全部期望叶子的逐字身份匹配',quality,[{verdict:'support',item:'sample:c1',tier:'blocking'}],{sources:{[leaf]:'合成期望'}}),
    sample('negative','expected_quality_changed','expected_quality_evidence','引文不是原件逐字文本',badQuality,[{verdict:'refute',code:'case-review.quote_missing',item:'sample:c1',tier:'blocking'}],{sources:{[leaf]:'合成期望'}}),
    sample('positive','negative_command_present','negative_commands','反向用例从自身取命令行',itemSubject(commandSubject,negativeCase,{findings:[]}),[{verdict:'support',item:'sample:n1',tier:'advisory'}],{catalog:CATALOG}),
    sample('negative','negative_command_missing','negative_commands','反向用例自身没有目录命令行',itemSubject(commandSubject,caseItem('n1',{tags:['Negative'],tagsNormalized:['Negative'],negative:true,title:'拒绝非法输入',steps:[],expected:['拒绝非法输入']}),{findings:[]}),[{verdict:'refute',code:'case-review.negative_command_missing',item:'sample:n1',tier:'advisory'}],{catalog:CATALOG}),

    // structure (literal): fields, ranges and duplicates of the whole run.
    sample('positive', 'structure_clean', 'structure', '两个字段齐全、内容不同的用例', runSubject(good), [
      { verdict: 'support', item: 'sample:c1' },
      { verdict: 'support', item: 'sample:c2' },
    ]),
    sample(
      'negative',
      'structure_defects',
      'structure',
      '一个没有期望结果的用例，两个同一路径下内容完全相同的用例',
      runSubject([caseItem('c1'), caseItem('c2', { expected: [], expectedCount: 0 }), caseItem('c3', { title: '设置池 c1 的探测间隔' })]),
      [
        { verdict: 'refute', code: 'core.structure.duplicate_key', item: 'sample:c1', tier: 'blocking' },
        { verdict: 'refute', code: 'core.structure.required_empty', item: 'sample:c2', tier: 'blocking' },
        { verdict: 'refute', code: 'core.structure.duplicate_key', item: 'sample:c3', tier: 'blocking' },
      ],
    ),
    sample('negative', 'structure_priority', 'structure', '优先级写成文字、超出 1 到 3', runSubject([caseItem('c1', { priority: '高' }), caseItem('c2', { priority: 7 })]), [
      { verdict: 'refute', code: 'core.structure.type_mismatch', item: 'sample:c1' },
      { verdict: 'refute', code: 'core.structure.type_mismatch', item: 'sample:c2' },
    ]),
    // node_ids (literal, advisory): every case has its own node id.
    sample('positive', 'node_ids_unique', 'node_ids', '每个用例有自己的节点编号', runSubject(good), [
      { verdict: 'support', item: 'sample:c1', tier: 'advisory' },
      { verdict: 'support', item: 'sample:c2', tier: 'advisory' },
    ]),
    sample('negative', 'node_ids_shared', 'node_ids', '两个用例共用一个节点编号', runSubject([caseItem('c1'), { ...caseItem('c2'), fields: { ...caseItem('c2').fields, nodeId: 'c1' } }]), [
      { verdict: 'refute', code: 'core.structure.duplicate_key', item: 'sample:c1', tier: 'advisory' },
      { verdict: 'refute', code: 'core.structure.duplicate_key', item: 'sample:c2', tier: 'advisory' },
    ]),
    // R2: every resource value must equal a declared text; variants are advisory structural violations.
    sample('positive', 'tags_consistent', 'tags', '整份文档同一类别用同一种写法', runSubject(good), [
      { verdict: 'support', item: 'sample:c1', tier: 'advisory' },
      { verdict: 'support', item: 'sample:c2', tier: 'advisory' },
    ]),
    sample('negative', 'tags_variant', 'tags', 'R2：保留原始变体 Functional、function；它们均不等于闭集原文 functional，逐条反驳为提示档结构违规，不能按大小写或同义词归一化后支持', runSubject([caseItem('c1', { tags: ['Functional'] }), caseItem('c2', { tags: ['Functional'] }), caseItem('c3', { tags: ['function'] })]), [
      { verdict: 'refute', code: 'case-review.tag_variant', item: 'sample:c1', tier: 'advisory' },
      { verdict: 'refute', code: 'case-review.tag_variant', item: 'sample:c2', tier: 'advisory' },
      { verdict: 'refute', code: 'case-review.tag_variant', item: 'sample:c3', tier: 'advisory' },
    ]),
    // cited_commands (catalog): command lines the findings quote from the case; only lines the case writes are judged.
    sample('positive', 'cited_valid', 'cited_commands', '发现照用例原样引用的命令行（用例的步骤里有这一行）参数合法', itemSubject(commandSubject, withLine('c1', 'health interval pool1 30'), { findings: [finding({ commands: [{ command: 'health interval pool1 30' }] })] }), [{ verdict: 'support', item: 'sample:c1' }], { catalog: CATALOG }),
    sample('positive', 'cited_none', 'cited_commands', '普通用例的发现没有引用命令行：没有要核对的', itemSubject(commandSubject, caseItem('c1'), { findings: [] }), [{ verdict: 'support', item: 'sample:c1' }], { catalog: CATALOG }),
    sample('positive', 'cited_not_in_case', 'cited_commands', '发现引用了用例里没有的命令行（越界的 999）：那是模型的陈述，不是用例的事实，这里没有要核对的（findings_sources 送回修复）', itemSubject(commandSubject, withLine('c1', 'health interval pool1 30'), { findings: [finding({ commands: [{ command: 'health interval pool1 999' }] })] }), [{ verdict: 'support', item: 'sample:c1' }], { catalog: CATALOG }),
    sample('negative', 'cited_out_of_range', 'cited_commands', '普通用例自己写的命令行参数越界，发现照原样引用了它', itemSubject(commandSubject, withLine('c1', 'health interval pool1 999'), { findings: [finding({ code: 'literal_issue', commands: [{ command: 'health interval pool1 999' }] })] }), [
      { verdict: 'refute', code: 'core.catalog.param_out_of_range', item: 'sample:c1', tier: 'blocking' },
    ], { catalog: CATALOG }),
    sample('negative', 'cited_negative_case', 'cited_commands', '反向用例引用的非法命令行：预期的反驳，提示档', itemSubject(commandSubject, negativeCase, { findings: [finding({ location: loc('n1'), commands: [{ command: 'health interval pool1 0' }] })] }), [
      { verdict: 'refute', code: 'core.catalog.param_out_of_range', item: 'sample:n1', tier: 'advisory' },
    ], { catalog: CATALOG }),
    // command_claims (catalog and findings): statements that a command exists or does not.
    sample('positive', 'claims_agree', 'command_claims', '说存在的命令在目录里，说不存在的命令不在目录里', itemSubject(commandSubject, caseItem('c1'), { findings: [finding({ code: 'coverage_gap', commands: [{ command: 'show pool', present: true }, { command: 'pool delete', present: false }] })] }), [
      { verdict: 'support', item: 'sample:c1' },
      { verdict: 'support', item: 'sample:c1' },
    ], { catalog: CATALOG }),
    sample('negative', 'claims_contradicted', 'command_claims', '说 show pool 不存在，目录里有', itemSubject(commandSubject, caseItem('c1'), { findings: [finding({ code: 'coverage_gap', commands: [{ command: 'show pool', present: false }] })] }), [
      { verdict: 'refute', code: 'core.catalog.membership_contradicted', item: 'sample:c1', tier: 'blocking' },
    ], { catalog: CATALOG }),
    // findings_quotes (findings): quotations verbatim in the cited fragment.
    sample('positive', 'quotes_verbatim', 'findings_quotes', '引文逐字出现在所引片段里', defaultSubject(caseItem('c1'), { findings: [finding()] }, []), [{ verdict: 'support', item: 'sample:c1' }], {
      sources: { [`src:${SPEC}/markdown@1/s/interval`]: '探测间隔的取值范围 1-300 秒，默认 5 秒。' },
    }),
    sample('negative', 'quotes_changed', 'findings_quotes', '引文改了字，所引片段里没有', defaultSubject(caseItem('c1'), { findings: [finding({ quotes: [{ reference: `src:${SPEC}/markdown@1/s/interval`, text: '取值范围 1-600 秒' }] })] }, []), [
      { verdict: 'refute', code: 'QUOTE_MISMATCH', item: 'sample:c1' },
    ], { sources: { [`src:${SPEC}/markdown@1/s/interval`]: '探测间隔的取值范围 1-300 秒，默认 5 秒。' } }),
    // findings_sources (findings): a location, and a ground beyond the hints.
    sample('positive', 'sources_product', 'findings_sources', '发现写了位置，引用规格书（期望来源）', defaultSubject(caseItem('c1'), { findings: [finding()] }, [evidence(loc('c1'), 'subject'), evidence(`src:${SPEC}/markdown@1/s/interval`, 'expected')]), [
      { verdict: 'support', item: 'sample:c1', tier: 'blocking' },
    ]),
    sample('positive', 'sources_cited_line', 'findings_sources', '原文为 health interval pool1 30，发现逐字引用同一整行才支持；R4 不允许大小写或空白折叠。show pool 带 present:true，属于另行核对的成员主张', defaultSubject(withLine('c1', 'health interval pool1 30'), { findings: [finding({ commands: [{ command: 'health interval pool1 30' }, { command: 'show pool', present: true }] })] }, [evidence(`src:${SPEC}/markdown@1/s/interval`, 'expected')]), [
      { verdict: 'support', item: 'sample:c1', tier: 'blocking' },
    ]),
    sample('negative', 'sources_cited_line_variant', 'findings_sources', 'Health  Interval pool1 30 与原文 health interval pool1 30 不逐字相等；没有 present 的引用必须退回修正，不能按大小写和空白归一化', defaultSubject(withLine('c1', 'health interval pool1 30'), { findings: [finding({ commands: [{ command: 'Health  Interval pool1 30' }] })] }, [evidence(`src:${SPEC}/markdown@1/s/interval`, 'expected')]), [
      { verdict: 'refute', code: 'case-review.command_not_in_case', item: 'sample:c1', tier: 'blocking' },
    ]),
    sample(
      'negative',
      'sources_hint_only',
      'findings_sources',
      '一条发现只引用历史测试清单，另一条没有写位置',
      defaultSubject(caseItem('c1'), { findings: [finding({ quotes: [{ reference: `src:${HISTORY}/kityminder@1/n/h1`, text: '间隔 1-300' }] }), finding({ location: undefined })] }, [
        evidence(`src:${HISTORY}/kityminder@1/n/h1`, 'hint'),
        evidence(`src:${SPEC}/markdown@1/s/interval`, 'expected'),
      ]),
      [
        { verdict: 'refute', code: 'case-review.hint_only', item: 'sample:c1', tier: 'blocking' },
        { verdict: 'refute', code: 'case-review.location_missing', item: 'sample:c1', tier: 'blocking' },
      ],
    ),
    sample('negative', 'sources_quote_missing', 'findings_sources', '一条发现只有 grounds、没有逐字引文', defaultSubject(caseItem('c1'), { findings: [finding({ quotes: undefined, grounds: [`src:${SPEC}/markdown@1/s/interval`] })] }, [evidence(`src:${SPEC}/markdown@1/s/interval`, 'expected')]), [
      { verdict: 'refute', code: 'case-review.quote_missing', item: 'sample:c1', tier: 'blocking' },
    ]),
    sample('negative', 'sources_command_not_in_case', 'findings_sources', '发现引用的命令行在用例里没有：一条改了取值，一条删了参数', defaultSubject(withLine('c1', 'health interval pool1 30'), { findings: [finding({ commands: [{ command: 'health interval pool1 999' }, { command: 'health interval pool1' }] })] }, [evidence(`src:${SPEC}/markdown@1/s/interval`, 'expected')]), [
      { verdict: 'refute', code: 'case-review.command_not_in_case', item: 'sample:c1', tier: 'blocking' },
      { verdict: 'refute', code: 'case-review.command_not_in_case', item: 'sample:c1', tier: 'blocking' },
    ]),
    // case_commands (optional, off by default): command phrases in the case's own text.
    sample('positive', 'scan_valid', 'case_commands', '用例文字里的命令参数合法，其余行不是命令', itemSubject(scanSubject, caseItem('c1', { steps: [{ text: 'health interval pool1 30', expected: ['显示的探测间隔为 30 秒'] }] }), null), [
      { verdict: 'support', item: 'sample:c1', tier: 'advisory' },
    ], { catalog: CATALOG }),
    sample('negative', 'scan_out_of_range', 'case_commands', '普通用例文字里的命令参数越界', itemSubject(scanSubject, caseItem('c1', { steps: [{ text: 'health interval pool1 999', expected: [] }] }), null), [
      { verdict: 'refute', code: 'core.catalog.param_out_of_range', item: 'sample:c1', tier: 'advisory' },
    ], { catalog: CATALOG }),
  ];
}

/** JSON text of a sample file, as written to samples/. */
export function sampleText(entry: Entry): string {
  return `${JSON.stringify(entry.sample, null, 2)}\n`;
}

export const SAMPLES_DIR = fileURLToPath(new URL('../samples/', import.meta.url));

export async function writeSamples(dir: string = SAMPLES_DIR): Promise<string[]> {
  await rm(dir, { recursive: true, force: true });
  const written: string[] = [];
  for (const entry of samples()) {
    const folder = join(dir, entry.folder);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${entry.sample.id}.json`), sampleText(entry));
    written.push(`${entry.folder}/${entry.sample.id}.json`);
  }
  return written;
}

export async function listSamples(dir: string = SAMPLES_DIR): Promise<string[]> {
  const out: string[] = [];
  for (const folder of ['negative', 'positive']) {
    try {
      for (const name of (await readdir(join(dir, folder))).sort()) out.push(`${folder}/${name}`);
    } catch {
      // a missing folder lists nothing
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'write') {
  console.log((await writeSamples()).join('\n'));
}
