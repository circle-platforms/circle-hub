// The publish-check samples of the verification pack (pack-sample@1), written by the pack author with the expectations spelled
// out. The subjects are the default subjects the Hub builds (an item with its slot record; all items with the cross-item
// entries) and, for the catalog check, what its subject builder gives (built here with the pack's own builder). Not part of
// the pack: `node packs/workflow/case-review-verify/testing/samples.ts write` writes samples/. Everything is invented: the
// command catalog is a tiny synthetic one.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackSample } from '../../../../contracts/src/pack.ts';
import { claimSubject } from '../functions/subjects.ts';
import { createReviewScope, REVIEW_SCOPE_GROUP, reviewScopeSubject } from '../functions/review-scope.ts';

const TARGET = 'a'.repeat(64);
const DRAFT = 'b'.repeat(64);
const ROOT = 'd'.repeat(64);
const SPEC = 'e'.repeat(64);
const loc = (node: string): string => `src:${TARGET}/kityminder@1/n/${node}`;
const draftRef = (n: number, c: number): string => `rec:${DRAFT}#/partitions/delivered/${n}/requirements/2/claims/${c}`;
const LEVEL = { reference: `rec:${DRAFT}#/cross_item/3`, rank: 'P3', text: '等级理由：覆盖全部功能细节，有一些反向用例' };

type Claim = Record<string, unknown>;

function draftFinding(n: number, c: number, code: string, rank: string, node: string): Record<string, unknown> {
  return { reference: draftRef(n, c), code, rank, text: '初评的发现', location: loc(node), quotes: [{ reference: loc(node), text: '设置探测间隔' }], commands: [] };
}

function fields(node: string, findings: Record<string, unknown>[]): Record<string, unknown> {
  return { nodeId: node, path: ['示例文档', '池管理'], title: `设置池 ${node} 的探测间隔`, draft_partition: 'delivered', draft_findings: findings, draft_level: LEVEL };
}

/** A quotation of the verifier's own into the target: the expected result of the case, which the draft did not quote. */
const ownQuote = (node: string) => [{ reference: `src:${TARGET}/kityminder@1/n/${node}e`, text: '显示的探测间隔与设置一致' }];
/** The quotation the draft itself gave (the case title): copying it is no check of the verifier's. */
const draftQuote = (node: string) => [{ reference: loc(node), text: '设置探测间隔' }];
const specQuote = [{ reference: `src:${SPEC}/markdown@1/s/interval`, text: '取值范围 1-300 秒' }];

export function disposition(code: string, finding: string, node: string, changes: Claim = {}): Claim {
  return { text: '复核方的处置', code, rank: 'major', location: loc(node), quotes: ownQuote(node), data: { finding }, ...changes };
}

export function newFinding(probe: string, node: string, changes: Claim = {}): Claim {
  return { text: '初评遗漏：缺少探测间隔为 0 的反向用例', code: 'new_finding', rank: 'minor', location: loc(node), quotes: [{ reference: `src:${SPEC}/markdown@1/s/interval`, text: '取值范围 1-300 秒' }], data: { probe }, ...changes };
}

function itemSubject(node: string, findings: Record<string, unknown>[], claims: Claim[] | null): unknown {
  return { item: `sample:${node}`, label: `设置池 ${node} 的探测间隔`, location: loc(node), fields: fields(node, findings), slots: claims === null ? null : { verification: claims }, evidence: [] };
}

type RunItem = { node: string; findings: Record<string, unknown>[]; claims: Claim[] | null };

function runSubject(items: RunItem[], cross: Claim[]): unknown {
  return {
    items: items.map((it) => ({ id: `sample:${it.node}`, label: `设置池 ${it.node} 的探测间隔`, location: loc(it.node), fields: fields(it.node, it.findings), slots: it.claims === null ? null : { verification: it.claims } })),
    cross_item: cross,
  };
}

const final = (code: string, rank: string, grounds: string[] = []): Claim => ({ nature: 'judgment', statement: `结论 ${code}`, grounds, code, rank });

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

/** What the subject builder of the catalog check gives for an item with these statements. */
function claimsOf(node: string, claims: Claim[]): unknown {
  const item = { id: `sample:${node}`, label: `设置池 ${node} 的探测间隔`, location: loc(node), fields: fields(node, []) };
  const context = { product: 'sample', names: ['Sample'], line: '1.0', build: 'Rel_1_0_1', root: ROOT, parameters: {}, groups: [] };
  return claimSubject({ applies: 'item', item, slots: { verification: claims }, evidence: [], context });
}

type Entry = { folder: 'positive' | 'negative'; sample: PackSample };

function sample(folder: Entry['folder'], id: string, check: string, note: string, subject: unknown, expect: PackSample['expect'], extra: Partial<PackSample> = {}): Entry {
  return { folder, sample: { id, source: 'author', check, note, subject, ...extra, expect } };
}

export function samples(): Entry[] {
  const f1 = draftFinding(0, 0, 'coverage_gap', 'major', 'c1');
  const f2 = draftFinding(0, 1, 'literal_issue', 'minor', 'c1');
  const f3 = draftFinding(1, 0, 'negative_gap', 'critical', 'c2');
  const scope=createReviewScope({source:TARGET,document:'sample',parameters:{case_rule:'marked',case_priority:2,group_priority:1,precondition_priority:3},expected:[{item:'sample:c1',location:loc('c1')},{item:'sample:c2',location:loc('c2')}],selected:['sample:c1']});
  const scopeSubject=reviewScopeSubject({applies:'run',items:[],context:{groups:[{kind:REVIEW_SCOPE_GROUP,data:{review_scope:scope}}]}});
  return [
    sample('positive','scope_frozen','review_scope','复核保留初评的整份识别范围',scopeSubject,[{verdict:'support',tier:'blocking'}],{sources:{[`src:${TARGET}/kityminder@1/i/0`]:'合成根'}}),
    sample('negative','scope_conflict','review_scope','同次复核有两份识别范围不能任选一份',reviewScopeSubject({applies:'run',items:[],context:{groups:[{kind:REVIEW_SCOPE_GROUP,data:{review_scope:scope}},{kind:REVIEW_SCOPE_GROUP,data:{review_scope:scope}}]}}),[{verdict:'refute',code:'case-review-verify.scope_conflict',tier:'blocking'}]),
    sample('negative','verdict_severity_missing','verdict','新增发现缺严重程度时不能核最终等级',runSubject([{node:'c1',findings:[f1],claims:[disposition('verified',draftRef(0,0),'c1'),newFinding('edge_case_gap','c1',{rank:undefined})]}],[final('PARTIAL','P3')]),[{verdict:'refute',code:'case-review-verify.severity_missing',item:'sample:c1',tier:'blocking'}]),
    sample('negative','verdict_pass_partial','verdict','PASS 却有一条部分正确、需要修正的初评发现',runSubject([{node:'c1',findings:[f1],claims:[disposition('partial',draftRef(0,0),'c1')]}],[final('PASS','P3')]),[{verdict:'refute',code:'case-review-verify.pass_with_partial',item:'sample:c1',tier:'blocking'}]),
    sample('negative','verdict_level_severity_mismatch','verdict','新增 critical 发现却把最终等级写成 major 区间',runSubject([{node:'c1',findings:[f1],claims:[disposition('verified',draftRef(0,0),'c1'),newFinding('edge_case_gap','c1',{rank:'critical'})]}],[final('PARTIAL','P3')]),[{verdict:'refute',code:'case-review-verify.level_severity_mismatch',item:'sample:c1',tier:'blocking'}]),
    sample('positive', 'dispositions_complete', 'dispositions', '两条初评发现各一条处置，另有一条新发现，每条有位置和引文', itemSubject('c1', [f1, f2], [disposition('verified', draftRef(0, 0), 'c1'), disposition('partial', draftRef(0, 1), 'c1', { rank: 'minor' }), newFinding('edge_case_gap', 'c1')]), [
      { verdict: 'support', item: 'sample:c1', tier: 'blocking' },
    ]),
    sample('positive', 'dispositions_nothing', 'dispositions', '没有初评发现、也没有新发现的条目：空列表', itemSubject('c2', [], []), [{ verdict: 'support', item: 'sample:c2' }]),
    sample(
      'negative',
      'dispositions_broken',
      'dispositions',
      '一条处置指向别的条目的发现、另一条没有引文、新发现没有写探针；一条初评发现没有处置',
      itemSubject('c1', [f1, f2], [disposition('refuted', draftRef(1, 0), 'c1'), disposition('verified', draftRef(0, 0), 'c1', { quotes: [] }), newFinding('missing', 'c1')]),
      [
        { verdict: 'refute', code: 'case-review-verify.finding_unknown', item: 'sample:c1', tier: 'blocking' },
        { verdict: 'refute', code: 'case-review-verify.quote_missing', item: 'sample:c1' },
        { verdict: 'refute', code: 'case-review-verify.probe_missing', item: 'sample:c1' },
        { verdict: 'refute', code: 'case-review-verify.disposition_missing', item: 'sample:c1' },
      ],
    ),
    sample('negative', 'dispositions_twice', 'dispositions', '一条初评发现有两条处置，另一条处置没有位置', itemSubject('c2', [f3], [disposition('verified', draftRef(1, 0), 'c2'), disposition('refuted', draftRef(1, 0), 'c2', { location: undefined })]), [
      { verdict: 'refute', code: 'case-review-verify.location_missing', item: 'sample:c2' },
      { verdict: 'refute', code: 'case-review-verify.disposition_duplicate', item: 'sample:c2' },
    ]),
    // command_claims (verification): the verifier's statements that a command exists or does not, against the catalog.
    sample('positive', 'claims_agree', 'command_claims', '复核方说存在的命令在目录里，说不存在的命令不在目录里', claimsOf('c1', [disposition('verified', draftRef(0, 0), 'c1', { commands: [{ command: 'show pool', present: true }, { command: 'pool delete', present: false }] })]), [
      { verdict: 'support', item: 'sample:c1' },
      { verdict: 'support', item: 'sample:c1' },
    ], { catalog: CATALOG }),
    sample('negative', 'claims_contradicted', 'command_claims', '复核方推翻初评时说 health interval 不存在，目录里有：送回复核方修复', claimsOf('c1', [disposition('refuted', draftRef(0, 0), 'c1', { commands: [{ command: 'health interval', present: false }] })]), [
      { verdict: 'refute', code: 'core.catalog.membership_contradicted', item: 'sample:c1', tier: 'blocking' },
    ], { catalog: CATALOG }),
    sample(
      'positive',
      'verdict_pass',
      'verdict',
      'PASS：全部证实，没有新发现，等级不变，复核方有一段自己从被复核脑图里逐字引用的原文（初评没有引过的期望结果）',
      runSubject([{ node: 'c1', findings: [f1], claims: [disposition('verified', draftRef(0, 0), 'c1')] }, { node: 'c2', findings: [], claims: [] }], [final('PASS', 'P3')]),
      [{ verdict: 'support', item: 'sample:c1', tier: 'blocking' }],
    ),
    sample(
      'positive',
      'verdict_partial',
      'verdict',
      'PARTIAL：有一条新发现',
      runSubject([{ node: 'c1', findings: [f1], claims: [disposition('verified', draftRef(0, 0), 'c1'), newFinding('negative_gap', 'c1')] }], [final('PARTIAL', 'P3')]),
      [{ verdict: 'support', item: 'sample:c1' }],
    ),
    sample(
      'positive',
      'verdict_partial_refuted_minor',
      'verdict',
      'PARTIAL：只推翻了一条初评定为次要的发现，没有新发现，等级不变（这时 PASS 和 FAIL 都不对）',
      runSubject([{ node: 'c1', findings: [f1, f2], claims: [disposition('verified', draftRef(0, 0), 'c1'), disposition('refuted', draftRef(0, 1), 'c1', { rank: 'minor' })] }], [final('PARTIAL', 'P3')]),
      [{ verdict: 'support', item: 'sample:c1' }],
    ),
    sample(
      'positive',
      'verdict_fail',
      'verdict',
      'FAIL：推翻了一条初评定为严重的发现（复核方给推翻定的等级是次要，不影响），等级改了',
      runSubject([{ node: 'c2', findings: [f3], claims: [disposition('refuted', draftRef(1, 0), 'c2', { rank: 'minor' })] }], [final('FAIL', 'P5')]),
      [{ verdict: 'support', item: 'sample:c2' }],
    ),
    sample(
      'negative',
      'verdict_pass_inconsistent',
      'verdict',
      'PASS 却推翻了一条发现、列出了新发现、改了等级',
      runSubject([{ node: 'c1', findings: [f1], claims: [disposition('refuted', draftRef(0, 0), 'c1'), newFinding('coverage_gap', 'c1', { rank: 'major' })] }], [final('PASS', 'P4')]),
      [
        { verdict: 'refute', code: 'case-review-verify.pass_with_refuted', item: 'sample:c1', tier: 'blocking' },
        { verdict: 'refute', code: 'case-review-verify.pass_with_new_finding', item: 'sample:c1' },
        { verdict: 'refute', code: 'case-review-verify.pass_level_changed', item: 'sample:c1' },
      ],
    ),
    sample(
      'negative',
      'verdict_pass_without_evidence',
      'verdict',
      'PASS，但复核方只写了空列表，没有一条自己落在被复核脑图里的引用',
      runSubject([{ node: 'c2', findings: [], claims: [] }], [final('PASS', 'P3', [`src:${SPEC}/markdown@1/s/interval`])]),
      [{ verdict: 'refute', code: 'case-review-verify.pass_without_evidence', item: 'sample:c2' }],
    ),
    sample(
      'negative',
      'verdict_pass_location_only',
      'verdict',
      'PASS，处置的位置在被复核脑图里，引文却只引了规格书：位置是谁都能从条目列表抄的引用，不算复核方核对过被复核对象',
      runSubject([{ node: 'c1', findings: [f1], claims: [disposition('verified', draftRef(0, 0), 'c1', { quotes: specQuote })] }], [final('PASS', 'P3', [loc('c1')])]),
      [{ verdict: 'refute', code: 'case-review-verify.pass_without_evidence', item: 'sample:c1' }],
    ),
    sample(
      'negative',
      'verdict_pass_copied_quote',
      'verdict',
      'PASS，复核方的引文照抄了初评的那段引文：不是复核方自己的核对',
      runSubject([{ node: 'c1', findings: [f1], claims: [disposition('verified', draftRef(0, 0), 'c1', { quotes: draftQuote('c1') })] }], [final('PASS', 'P3')]),
      [{ verdict: 'refute', code: 'case-review-verify.pass_without_evidence', item: 'sample:c1' }],
    ),
    sample(
      'negative',
      'verdict_pass_unverified',
      'verdict',
      'PASS，但有一条初评发现所在的条目跳过了（没有槽位记录）：那条发现没有处置',
      runSubject([{ node: 'c1', findings: [f1], claims: [disposition('verified', draftRef(0, 0), 'c1')] }, { node: 'c2', findings: [f3], claims: null }], [final('PASS', 'P3')]),
      [{ verdict: 'refute', code: 'case-review-verify.pass_with_unverified', item: 'sample:c1' }],
    ),
    sample(
      'negative',
      'verdict_partial_without_change',
      'verdict',
      'PARTIAL，但全部证实，没有新发现，没有推翻或修正的发现，等级也没改',
      runSubject([{ node: 'c1', findings: [f1], claims: [disposition('verified', draftRef(0, 0), 'c1')] }], [final('PARTIAL', 'P3')]),
      [{ verdict: 'refute', code: 'case-review-verify.partial_without_change', item: 'sample:c1' }],
    ),
    sample(
      'negative',
      'verdict_fail_without_refutation',
      'verdict',
      'FAIL，但只推翻了一条初评定为次要的发现（复核方把推翻定为主要也不算）',
      runSubject([{ node: 'c1', findings: [f2], claims: [disposition('refuted', draftRef(0, 1), 'c1', { rank: 'major' })] }], [final('FAIL', 'P4')]),
      [{ verdict: 'refute', code: 'case-review-verify.fail_without_major_refutation', item: 'sample:c1' }],
    ),

    ...[
      {folder:'positive',id:'suggestion_case',grounds:[loc('c1')],statement:'补：间隔为 0 的用例；因为：只测上界；期望：拒绝非法值'},
      {folder:'positive',id:'suggestion_subitem',grounds:[loc('g1')],statement:'补：反向用例；因为：边界缺口；期望：拒绝非法值'},
      {folder:'positive',id:'suggestion_none',grounds:null,statement:''},
      {folder:'negative',id:'suggestion_no_target',grounds:[],statement:'补：反向用例；因为：边界缺口；期望：拒绝非法值',code:'suggestion_target_missing'},
      {folder:'negative',id:'suggestion_expected_only',grounds:[specQuote[0].reference],statement:'补：反向用例；因为：边界缺口；期望：拒绝非法值',code:'suggestion_target_missing'},
      {folder:'negative',id:'suggestion_no_expected',grounds:[loc('c1')],statement:'补：反向用例；因为：边界缺口',code:'suggestion_incomplete'},
      {folder:'negative',id:'suggestion_empty_part',grounds:[loc('c1')],statement:'补：；因为：边界缺口；期望：拒绝非法值',code:'suggestion_incomplete'},
    ].map(spec=>sample(spec.folder as Entry['folder'],spec.id,'suggestion_targets','建议落点和三段式的合成正反例',
      runSubject([{node:'c1',findings:[],claims:[]}],spec.grounds===null?[]:[{code:'suggestion',statement:spec.statement,grounds:spec.grounds,rank:'minor'}]),
      [{verdict:spec.code?'refute':'support',...(spec.code?{code:'case-review-verify.'+spec.code}:{}),item:'sample:c1',tier:'blocking'}])),
  ];
}

export const SAMPLES_DIR = fileURLToPath(new URL('../samples/', import.meta.url));

export function sampleText(entry: Entry): string {
  return `${JSON.stringify(entry.sample, null, 2)}\n`;
}

export async function writeSamples(dir: string = SAMPLES_DIR): Promise<string[]> {
  await rm(dir, { recursive: true, force: true });
  const written: string[] = [];
  for (const entry of samples()) {
    await mkdir(join(dir, entry.folder), { recursive: true });
    await writeFile(join(dir, entry.folder, `${entry.sample.id}.json`), sampleText(entry));
    written.push(`${entry.folder}/${entry.sample.id}.json`);
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'write') {
  console.log((await writeSamples()).join('\n'));
}
