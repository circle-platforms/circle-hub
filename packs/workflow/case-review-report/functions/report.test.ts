// The tests of case-review-report: the projection (the worst verdict wins, per-item delivery merges, an overlap refuses,
// an item nobody delivered marks the whole unfinished with the missing items named, a missing final makes the overall
// unknown) and the two checks (the overall fact and the report agreement over cross_item claims), driven on the same
// synthetic two-block shape the samples use. Pure functions, no Hub, no database.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { describe, it } from 'node:test';
import {kityminderParser} from '../../../../hub/refs/api.ts';
import type { ProjectedItem } from '../../../../contracts/src/pack.ts';
import projection from './projection.ts';
import { overallCheck, reportCheck } from './checks.ts';

const A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const DIGEST = 'a'.repeat(64);

interface Entry { item: string; kind?: string; text?: string; rank?: string }
type Block = { verdict: string | null; level: string | null; entries: Entry[]; partition?: string; hub?: 'support' | 'refute' | 'unknown' };

/** A synthetic verification result: delivered entries with one claim each, a cross_item final (Claim-shaped), one source. */
function block(spec: Block): Record<string, unknown> {
  const delivered = spec.entries.map((entry, index) => ({
    item: entry.item,
    label: `用例 ${entry.item}`,
    location: `src:${DIGEST}/kityminder@1/n/${entry.item}`,
    requirements: [
      { requirement: 'verification', status:'satisfied', claims: [{ qualifier:{nature:'judgment'},warrant:{producer:'model',id:'synthetic-verifier@1',independence:'model_family_declared'},statement: { code: entry.kind ?? 'verified', text: entry.text ?? `发现 ${entry.item}`, rank: entry.rank ?? 'minor' }, data: {} }] },
      { requirement: 'final', status:'satisfied', claims: [] },
    ],
  }));
  // The real-data shape: a block that carries entries it did not deliver lists them unfinished (the first half), the
  // rest of its entries stay delivered. 分区只有 delivered、rejected、quarantined、incomplete。
  for(const entry of delivered)entry.requirements[0].claims.push({qualifier:{nature:'fact'},warrant:{producer:'function',id:'case-review-verify@1'},statement:{verdict:'support',data:{source_facts:[]}}} as any);
  const halved = spec.partition !== undefined && spec.partition !== 'delivered' ? spec.entries.slice(0, Math.ceil(spec.entries.length / 2)) : [];
  const unfinished = halved.map((entry) => ({ item: entry.item, label: `用例 ${entry.item}`, location: `src:${DIGEST}/kityminder@1/n/${entry.item}`, requirements: [] }));
  const partitions: Record<string, unknown[]> = { delivered: spec.partition !== undefined && spec.partition !== 'delivered' ? delivered.slice(halved.length) : delivered };
  if (unfinished.length > 0) partitions[spec.partition as string] = unfinished;
  return {
    schema: 'validation@1',acceptance:'accepted',
    locks: { pack: 'case-review-verify@1.0.3', pack_digest: '0'.repeat(64), subject: { digest: DIGEST } },
    partitions,
    ...(spec.verdict === null
      ? {}
      : {
          cross_item: [
            // 存储的真实形状：模型的结论主张 pointer 在顶层、code/rank 在 statement 里；Hub 的事实主张可能排在它
            // 前面，所以按 pointer 对照；Hub 的 final 事实主张带 requirement、pointer 和 statement.verdict。
            { qualifier:{nature:'judgment'},warrant:{producer:'model',id:'synthetic-verifier@1',independence:'model_family_declared'},statement: { code: spec.verdict, rank: spec.level, text: '结论' }, grounds: [], pointer: '/cross_item/0', requirement: 'final' },
            { requirement: 'final', pointer: '/cross_item/0', statement: { verdict: spec.hub ?? 'support', text: '与处置一致', data: {} }, grounds: [] },
          ],
        }),
  };
}

type ProjectionAnswer={items?:ProjectedItem[];error?:{code?:string;message?:string;fix?:string}};
function run(blocks:Array<{result:Record<string,unknown>;record?:string}>,options:{omitTarget?:boolean;parser?:string;digest?:string;priority?:number|null;model?:unknown}={}):ProjectionAnswer{
  let n=0;
  const ids=[...new Set(blocks.flatMap(block=>Object.values((block.result.partitions??{}) as Record<string,any[]>).flatMap(entries=>entries.map(entry=>String(entry.item)))))];
  const source=kityminderParser.parse(Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成文档'},children:ids.map(id=>({data:{id,text:'用例 '+id,priority:2,resource:['Functional']},children:[{data:{id:id+'-pre',text:'准备',priority:3}},{data:{id:id+'-e',text:'成功'}}]}))}}))).model;
  const inputs:unknown[]=blocks.map(block=>({slot:'verifications',external:null,sha256:'0'.repeat(64),media_type:'application/json',parser:'json@1',model:{kind:'validation_result',schema:'record@1',body:block.result},meta:{record:block.record??String(++n).repeat(64)}}));
  if(!options.omitTarget)inputs.push({slot:'target',external:null,sha256:options.digest??DIGEST,media_type:'application/json',parser:options.parser??'kityminder@1',model:options.model??source,meta:null});
  return projection({inputs,parameters:options.priority===undefined?{}:{precondition_priority:options.priority},context:{}}) as ProjectionAnswer;
}

const reportItemOf = (out: { items?: ProjectedItem[]; error?: { code?: string; message?: string } }): { summary?: string; fields: Record<string, unknown> } => {
  const item = out.items?.find((i) => i.id === 'report');
  assert.ok(item !== undefined, 'the report item exists');
  return item as unknown as { summary?: string; fields: Record<string, unknown> };
};

describe('the projection of case-review-report', () => {
  it('the worst verdict wins and takes that block\'s level and its real reference', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PARTIAL', level: 'P5', entries: [{ item: 'c2' }, { item: 'c3' }] }) },
    ]);
    const report = reportItemOf(out);
    assert.deepEqual(report.fields.overall, { verdict: 'PARTIAL', level: 'P5', reference: `rec:${'2'.repeat(64)}#/cross_item/0` });
    assert.match(report.summary??'', /^整体结论码 PARTIAL、等级 P5（最差那块的，照抄）；评审表/);
    assert.deepEqual((out.items ?? []).filter((i) => i.id !== 'report').map((i) => i.id), ['c1', 'c2', 'c3']);
    const c1 = out.items?.find((i) => i.id === 'c1');
    assert.match(c1?.summary??'',/^复核发现 1 条；推翻 0 条/);assert.doesNotMatch(c1?.summary??'',/rec:/);
  });

  it('joins by the submission pointer but cites the model final at its stored index after Hub facts', () => {
    const result = block({verdict:'PARTIAL',level:'P5',entries:[{item:'c1'}]});
    result.cross_item = [
      {requirement:'final',pointer:'/cross_item/4',statement:{verdict:'support'}},
      {requirement:'final',pointer:'/cross_item/3',statement:{code:'PASS',rank:'P3'}},
      {requirement:'final',pointer:'/cross_item/4',statement:{code:'PARTIAL',rank:'P5'}},
    ];
    const out = run([{result}]);
    assert.deepEqual(reportItemOf(out).fields.overall,{verdict:'PARTIAL',level:'P5',reference:`rec:${'1'.repeat(64)}#/cross_item/2`});
    result.cross_item = (result.cross_item as Record<string,unknown>[]).slice(0,2);
    assert.equal(run([{result}]).error?.code,'case-review-report.incomplete_blocks');
  });

  it('an item unfinished in one block and delivered in another counts as delivered (that block wins)', () => {
    // The real-data shape: block B carried all 62 entries, its first half unfinished; A delivered them.
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PASS', level: 'P3', partition: 'incomplete', entries: [{ item: 'c1' }, { item: 'c2' }] }) },
    ]);
    assert.deepEqual((out.items ?? []).filter((i) => i.id !== 'report').map((i) => i.id), ['c1', 'c2']);
    assert.deepEqual(reportItemOf(out).fields.missing_items, []);
  });

  it('an item delivered in two blocks refuses the run with the overlapping items named', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }, { item: 'c2' }] }) },
    ]);
    assert.equal(out.error?.code, 'case-review-report.overlap');
    assert.match(out.error?.message ?? '', /c1/);
  });

  it('an item delivered in no block refuses the report with the missing item named',()=>{
    const out=run([{result:block({verdict:'PASS',level:'P3',entries:[{item:'c1'}]})},{result:block({verdict:'PASS',level:'P3',partition:'incomplete',entries:[{item:'c9'}]})}]);
    assert.equal(out.error?.code,'case-review-report.incomplete_blocks');assert.match(out.error?.message ?? '',/c9/);assert.match(out.error?.fix ?? '',/复核.*重交/);assert.ok(!out.items);
  });

  it('a rejected-only item also refuses report projection',()=>{
    const out=run([{result:block({verdict:'PASS',level:'P3',entries:[{item:'c1'}]})},{result:block({verdict:'PASS',level:'P3',partition:'rejected',entries:[{item:'c8'},{item:'c7'}]})}]);
    assert.equal(out.error?.code,'case-review-report.incomplete_blocks');assert.match(out.error?.message ?? '',/c8/);
  });

  it('a final not supported by Hub must be reverified before a report can start',()=>{
    for(const hub of ['refute','unknown'] as const){const out=run([{result:block({verdict:'PASS',level:'P3',entries:[{item:'c1'}]})},{result:block({verdict:'PARTIAL',level:'P5',hub,entries:[{item:'c2'}]})}]);assert.equal(out.error?.code,'case-review-report.incomplete_blocks');assert.match(out.error?.message ?? '',/第 2 块/);}
  });

  it('a block without a readable final refuses startup',()=>{
    const out=run([{result:block({verdict:'PASS',level:'P3',entries:[{item:'c1'}]})},{result:block({verdict:null,level:null,entries:[{item:'c2'}]})}]);assert.equal(out.error?.code,'case-review-report.incomplete_blocks');assert.match(out.error?.message ?? '',/第 2 块/);
  });

  it('real shape (two blocks, 45 findings, 1 refuted): summaries expose all citable references and overall, checks pass on first attempt', () => {
    const block1Entries: Entry[] = Array.from({ length: 23 }, (_, i) => ({
      item: `case-1-${i + 1}`,
      kind: 'verified',
      text: `发现 1-${i + 1}`,
      rank: 'minor',
    }));
    const block2Entries: Entry[] = Array.from({ length: 22 }, (_, i) => ({
      item: `case-2-${i + 1}`,
      kind: i === 0 ? 'refuted' : (i === 1 ? 'partial' : 'verified'),
      text: `发现 2-${i + 1}`,
      rank: 'minor',
    }));

    const out = run([
      { result: block({ verdict: 'PARTIAL', level: 'P4', entries: block1Entries }) },
      { result: block({ verdict: 'PASS', level: 'P2', entries: block2Entries }) },
    ]);

    const report = reportItemOf(out);
    assert.deepEqual(report.fields.overall, { verdict: 'PARTIAL', level: 'P4', reference: `rec:${'1'.repeat(64)}#/cross_item/0` });
    assert.match(report.summary??'', /^整体结论码 PARTIAL、等级 P4（最差那块的，照抄）；评审表/);

    // Parse overall verdict and level from report summary
    const overallMatch = /整体结论码\s+(\w+)、等级\s+(\w+)/.exec(report.summary ?? '');
    assert.ok(overallMatch !== null, 'report summary contains verdict and level');
    const [, parsedVerdict, parsedLevel] = overallMatch;

    const items = (out.items ?? []).filter((i) => i.id !== 'report');
    assert.equal(items.length, 45);

    const refutedItem = items.find((i) => i.id === 'case-2-1');
    assert.ok(refutedItem !== undefined);
    assert.match(refutedItem.summary??'',/^复核发现 0 条；推翻 1 条/);

    const partialItem = items.find((i) => i.id === 'case-2-2');
    assert.ok(partialItem !== undefined);
    assert.match(partialItem.summary??'',/^复核发现 1 条；推翻 0 条/);

    // Extract all citable references from items' summaries
    const citedRefs: string[] = [];
    for (const it of items) {
      const matches = it.summary?.match(/rec:[0-9a-f]{64}#[^\s；、]+/g) ?? [];
      citedRefs.push(...matches);
    }
    // 45 findings total - 1 refuted = 44 citable references
    assert.equal(citedRefs.length,0,'the final reporter reads the deterministic table instead of retranscribing 44 finding references');
    assert.equal((report.fields.review_counts as any).total.findings,44);assert.equal((report.fields.review_counts as any).total.refuted,1);

    // Verify against overallCheck and reportCheck: passes on first attempt!
    const subject = {
      applies: 'run',
      items: out.items,
      context: {},
      cross_item: [{
        nature: 'judgment',
        statement: '终稿：两块合成，共 45 条处置，推翻 1 条，各块发现逐条核对一致',
        grounds: citedRefs,
        code: parsedVerdict,
        rank: parsedLevel,
      }],
    };

    const overallOut = overallCheck({ subject });
    assert.equal(overallOut[0]?.verdict, 'support');

    const reportOut = reportCheck({ subject });
    assert.equal(reportOut[0]?.verdict, 'support');
  });

  it('blocks on two different sources refuse the run', () => {
    const second = block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c2' }] });
    (second.partitions as Record<string, { item: string; label: string; location: string; requirements: unknown[] }[]>).delivered = (second.partitions as Record<string, { item: string; label: string; location: string; requirements: unknown[] }[]>).delivered.map((entry) => ({ ...entry, location: entry.location.replace(DIGEST, 'b'.repeat(64)) }));
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: second },
    ]);
    assert.equal(out.error?.code, 'case-review-report.sources_differ');
  });
});

describe('the checks of case-review-report', () => {
  const findings = [
    { kind: 'verified', reference: `rec:${A}#/partitions/delivered/0/requirements/0/claims/0`, block: 0, text: 'A 证实', rank: 'minor' },
    { kind: 'partial', reference: `rec:${B}#/partitions/delivered/0/requirements/0/claims/0`, block: 1, text: 'B 部分正确', rank: 'major' },
    { kind: 'new_finding', reference: `rec:${B}#/partitions/delivered/0/requirements/0/claims/1`, block: 1, text: 'B 新增', rank: 'minor' },
    { kind: 'refuted', reference: `rec:${B}#/partitions/delivered/0/requirements/0/claims/2`, block: 1, text: 'B 推翻', rank: 'minor' },
  ];
  const refs = findings.filter((f) => f.kind !== 'refuted').map((f) => f.reference);
  const refutedRef = findings[3]!.reference;
  const subjectWith = (crossItem: Record<string, unknown>[]): Record<string, unknown> => ({
    applies: 'run',
    items: [{ id: 'report', label: '评审终稿', location: `src:${DIGEST}/kityminder@1/n/c1`, fields: { overall: { verdict: 'PARTIAL', level: 'P5' }, findings } }],
    context: {},
    cross_item: crossItem,
  });
  // The verdict claim: its code IS the verdict, its rank the level (the verification pack's own final shape).
  const verdictClaim = (verdict: string, rank: string | undefined, grounds: string[]): Record<string, unknown> => ({ nature: 'judgment', statement: '终稿（中文全文略）：两块合成，各块发现逐条核对', grounds, code: verdict, ...(rank === undefined ? {} : { rank }) });

  it('the overall check compares the claim code and rank with the computed worst, no text matching', () => {
    const good = subjectWith([verdictClaim('PARTIAL', 'P5', refs)]);
    assert.equal(overallCheck({ subject: good })[0]!.verdict, 'support');
    const wrongVerdict = subjectWith([verdictClaim('PASS', 'P3', refs)]);
    const wrongOut = overallCheck({ subject: wrongVerdict });
    assert.equal(wrongOut[0]!.verdict, 'refute');
    assert.equal(wrongOut[0]!.code, 'case-review-report.verdict_mismatch');
    const wrongLevel = subjectWith([verdictClaim('PARTIAL', 'P3', refs)]);
    const levelOut = overallCheck({ subject: wrongLevel });
    assert.equal(levelOut[0]!.code, 'case-review-report.level_mismatch');
    assert.equal(overallCheck({ subject: subjectWith([{ nature: 'judgment', statement: '只有建议', grounds: [], code: 'suggestion' }]) })[0]!.code, 'case-review-report.report_missing', 'no verdict claim at all');
  });

  it('the overall check records unknown (missing input), not a refusal, when a final was unreadable or items missing', () => {
    const items = [{ id: 'report', label: '评审终稿', location: `src:${DIGEST}/kityminder@1/n/c1`, fields: { overall: null, findings } }];
    const claimsAny = { applies: 'run', items, context: {}, cross_item: [verdictClaim('PARTIAL', 'P4', refs)] };
    const out = overallCheck({ subject: claimsAny })[0]!;
    assert.equal(out.verdict, 'refute');
    assert.equal(out.code, 'case-review-report.report_missing');
    const withMissing = { applies: 'run', items: [{ id: 'report', label: '评审终稿', location: `src:${DIGEST}/kityminder@1/n/c1`, fields: { overall: null, findings, missing_items: ['c9', 'c10'] } }], context: {}, cross_item: [verdictClaim('PARTIAL', 'P4', refs)] };
    const outMissing = overallCheck({ subject: withMissing })[0]!;
    assert.deepEqual([outMissing.verdict, outMissing.code], ['refute', 'case-review-report.report_missing']);
    assert.match(outMissing.statement, /c9/);
  });

  it('the report check verifies the overall and level without demanding individual finding citations',()=>{
    for(const grounds of [[],refs,[...refs,refutedRef]]){
      assert.equal(reportCheck({subject:subjectWith([verdictClaim('PARTIAL','P5',grounds)])})[0]!.verdict,'support');
    }
    assert.equal(reportCheck({subject:subjectWith([verdictClaim('PASS','P5',[])])})[0]!.code,'case-review-report.verdict_mismatch');
    assert.equal(reportCheck({subject:subjectWith([verdictClaim('PARTIAL','P1',[])])})[0]!.code,'case-review-report.level_mismatch');
  });

  it('the report slot no longer accepts suggestion codes',()=>{
    const slots=JSON.parse(readFileSync(new URL('../slots.schema.json',import.meta.url),'utf8'));
    assert.ok(!slots.run.report.codes.some((code:{code:string})=>code.code==='suggestion'),'suggestions must be made by the verifier and placed in the verified table');
  });

});

describe('the table projection binding',()=>{
  const blocks=()=>[{result:block({verdict:'PARTIAL',level:'P5',entries:[{item:'c1'}]})}];
  it('refuses missing, non-map and different-byte targets with the required source reference',()=>{
    for(const options of [{omitTarget:true},{parser:'json@1'},{digest:'b'.repeat(64)}]){
      const out=run(blocks(),options);assert.ok(out.error);assert.match(out.error.fix??'',new RegExp('src:'+DIGEST));
    }
  });
  it('puts the report first, retains full and folded strings and counts, and distinguishes preconditions',()=>{
    const out=run(blocks()),report=out.items![0];
    assert.equal(report.id,'report');assert.equal(typeof report.fields.review_tables,'string');assert.equal(typeof (report.fields.review_tables_full??report.fields.review_tables),'string');
    assert.ok(report.fields.review_counts);assert.match(report.summary??'',/#\/items\/0\/fields\/review_tables/);
    assert.match(String(report.fields.review_tables_full??report.fields.review_tables),/；前置：准备/);
    const noPriority=run(blocks(),{priority:null});assert.match(String(noPriority.items![0].fields.review_tables_full??noPriority.items![0].fields.review_tables),/；期望：准备/);assert.doesNotMatch(String(noPriority.items![0].fields.review_tables_full??noPriority.items![0].fields.review_tables),/；前置：/);
  });
  it('does not produce tables until missing conclusions and undelivered items are repaired',()=>{
    for(const entries of [[{result:block({verdict:null,level:null,entries:[{item:'c1'}]})}],[{result:block({verdict:'PASS',level:'P3',entries:[{item:'c1'}],partition:'incomplete'})}]]){
      const out=run(entries);assert.equal(out.error?.code,'case-review-report.incomplete_blocks');assert.ok(!out.items);assert.match(out.error?.fix??'',/复核.*重交/);
    }
  });
});

it('an older verification without the original Hub fact snapshot cannot imply no Hub issues',()=>{
  const result=block({verdict:'PARTIAL',level:'P5',entries:[{item:'c1'}]});
  for(const requirement of (result.partitions as any).delivered[0].requirements)requirement.claims=requirement.claims.filter((claim:any)=>claim.warrant?.producer!=='function');
  const report=reportItemOf(run([{result}]));
  assert.equal(report.fields.review_tables,undefined);assert.equal(report.fields.overall,null);
  assert.match(report.summary??'',/^下一步.*新版独立复核.*终稿.*初评 Hub 核对快照/);
});

it('the initial reviewer procedure ends both single-block and multi-block reviews through the table report',()=>{
  const skill=readFileSync(new URL('../../case-review/SKILL.md',import.meta.url),'utf8');
  const final=skill.split('## 7. 报告')[1].split('## 参数')[0];
  assert.match(skill.split('## 2.')[0],/不分块也.*case-review-report/);
  assert.match(final,/case-review-report/);assert.match(final,/review_tables/);assert.match(final,/原样/);
  assert.doesNotMatch(final,/每条已证实和新增的发现（位置、说明、引文）/);
});

it('the final procedure reads and preserves every table page before the accepted overall prose',()=>{
  const skill=readFileSync(new URL('../SKILL.md',import.meta.url),'utf8');
  assert.match(skill,/不分块也/);assert.match(skill,/#\/items\/0\/fields\/review_tables/);
  assert.match(skill,/有下一页.*读完/);assert.match(skill,/原文.*追踪/);
  assert.match(skill,/一个字不改/);assert.match(skill,/## 评审意见/);
  assert.doesNotMatch(skill,/不需要这个包|每条建议另立|grounds.*一条不漏/);
});

it('the user guide includes the mandatory table report and its raw-field continuation protocol',()=>{
  const guide=readFileSync(new URL('../../../../docs/hub-r4-guide.md',import.meta.url),'utf8');
  const section=guide.split('## 用例评审')[1].split('\n## ')[0];
  assert.match(section,/case-review-report/);assert.match(section,/#\/items\/0\/fields\/review_tables/);
  assert.match(section,/不分块也/);assert.match(section,/有下一页.*读完/);
});

it('a settled independent block may carry an ungraded cross item suggestion',()=>{
  const result=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});
  (result.cross_item as any[]).push({qualifier:{nature:'judgment'},warrant:{producer:'model',id:'synthetic-verifier@1',independence:'unknown'},statement:{code:'suggestion',rank:'minor',text:'补：合成边界；因为：缺下界；期望：拒绝非法输入'},grounds:[`src:${DIGEST}/kityminder@1/n/c1`]});
  const output=run([{result}]);assert.ok(!output.error,JSON.stringify(output.error));assert.match(String(output.items![0].fields.review_tables),/补：合成边界/);
});

it('refuses a block still carrying repair errors or an unsatisfied independence requirement',()=>{
  const repair=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});repair.errors=[{code:'case-review-verify.suggestion_target_missing',item:'c1',requirement:'verification',rounds_left:2}];
  const independent=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});Object.assign((independent.partitions as any).delivered[0].requirements[0],{status:'unsatisfied',unsatisfied_reason:'independence_unknown'});
  for(const result of [repair,independent]){const out=run([{result}]);assert.equal(out.error?.code,'case-review-report.block_unsettled');assert.match(out.error?.fix??'',/修复.*重交|不同.*家族/);assert.ok(!out.items);}
});

it('tied worst verdicts use the worst declared rank and a stable record reference',()=>{
  const source=kityminderParser.parse(Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成同级'},children:['c1','c2'].map(id=>({data:{id,text:id,priority:2},children:[]}))}}))).model;
  const a={record:'b'.repeat(64),result:block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]})};
  const b={record:'a'.repeat(64),result:block({verdict:'PARTIAL',level:'P6',entries:[{item:'c2'}]})};
  const first=reportItemOf(run([a,b],{model:source})),second=reportItemOf(run([b,a],{model:source}));
  assert.equal((first.fields.overall as any).level,'P6');assert.deepEqual(first.fields.overall,second.fields.overall);assert.equal(first.fields.review_tables,second.fields.review_tables);
  (a.result.cross_item as any[])[0].statement.rank='P6';
  const tie=reportItemOf(run([a,b],{model:source}));assert.equal((tie.fields.overall as any).reference,`rec:${'a'.repeat(64)}#/cross_item/0`);
});

it('shared target nodes under different item identities produce an overlap refusal with both owners',()=>{
  const a=block({verdict:'PARTIAL',level:'P5',entries:[{item:'draft:c1'}]}),b=block({verdict:'PARTIAL',level:'P5',entries:[{item:'upload:c1'}]});
  (a.partitions as any).delivered[0].location=`src:${DIGEST}/kityminder@1/n/c1`;(b.partitions as any).delivered[0].location=`src:${DIGEST}/kityminder@1/i/0`;
  const model=kityminderParser.parse(Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成节点'},children:[{data:{id:'c1',text:'合成用例',priority:2},children:[]}]}}))).model;
  const result=run([{result:a},{result:b}],{model});assert.equal(result.error?.code,'case-review-report.overlap');assert.match(result.error?.message??'',/draft:c1.*upload:c1/);assert.match(result.error?.fix??'',/分块.*复核/);
});

function crowdedReport(length:number){
  return run(Array.from({length:5},(_,group)=>{
    const result=block({verdict:'PARTIAL',level:'P5',entries:Array.from({length:100},(_,index)=>({item:`large-${group*100+index}`}))});
    for(const entry of (result.partitions as any).delivered){const requirement=entry.requirements[0];const original=requirement.claims[0];requirement.claims=[...Array.from({length:3},(_,index)=>({...original,statement:{...original.statement,code:'new_finding',text:`合成发现${index} `+'甲'.repeat(length)}})),requirement.claims[1]];}
    return {result};
  }));
}
it('the complete 500 case projection budget includes every populated field rather than one markdown string',()=>{
  const output=crowdedReport(600);assert.ok(output.items,JSON.stringify(output.error));assert.ok(Buffer.byteLength(JSON.stringify(output),'utf8')<=8*1024*1024);
  const fields=output.items[0].fields;assert.equal(fields.findings,undefined);
  assert.ok(output.items.slice(1).every(item=>item.fields.dispositions===undefined));
  assert.ok(fields.review_tables_full===undefined||fields.review_tables_full!==fields.review_tables);
});
it('oversized complete projections return a measured typed refusal and a smaller-block next action',()=>{
  const output=crowdedReport(2000);assert.equal(output.error?.code,'case-review-report.too_large');assert.match(output.error?.message??'',/\d+.*字节.*8388608/);assert.match(output.error?.fix??'',/分块.*复核.*终稿/);
});

it('modern missing disposition support asks for the current receipt instead of a fictitious upgrade',()=>{
  const result=block({verdict:'PARTIAL',level:'P5',entries:[{item:'c1'}]});(result.locks as any).pack='case-review-verify@1.1.1';
  for(const requirement of (result.partitions as any).delivered[0].requirements)requirement.claims=requirement.claims.filter((claim:any)=>claim.warrant?.producer!=='function');
  const report=reportItemOf(run([{result}]));assert.equal(report.fields.overall,null);assert.match(report.summary??'',/^下一步：.*处置.*重交/);assert.doesNotMatch(report.summary??'',/新版|升级/);
  const checked=overallCheck({subject:{items:[{id:'report',fields:report.fields}],cross_item:[{code:'PARTIAL',rank:'P5'}]}});assert.equal(checked[0].verdict,'refute');assert.equal(checked[0].code,'case-review-report.report_missing');assert.doesNotMatch(checked[0].statement,/新版|升级/);
});

it('records the authorization provenance of the generic core string field renderer',()=>{
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');assert.match(readme,/决定 42/);
  const source=readFileSync(new URL('../../../../hub/server/console/pages.ts',import.meta.url),'utf8');assert.doesNotMatch(source,/review_tables|case-review-report/);
});

it('final answer capacity limits disclose pasted table and character counts with authoritative recovery links',()=>{
  const skill=readFileSync(new URL('../SKILL.md',import.meta.url),'utf8');assert.match(skill,/部分：已贴.*子项表.*原文字符/);assert.match(skill,/review_counts\.characters/);assert.match(skill,/review_tables_full/);assert.match(skill,/一张完整表也放不下.*0\//);assert.match(skill,/控制台运行页/);
});

it('the initial reviewer final step also marks capacity-limited tables as partial',()=>{
  const skill=readFileSync(new URL('../../case-review/SKILL.md',import.meta.url),'utf8').split('## 7. 报告')[1].split('## 参数')[0];assert.match(skill,/部分/);assert.match(skill,/review_counts\.characters/);
});

it('requires established model independence and refuses absent unknown negative or foreign warrants',()=>{
  for(const independence of [undefined,'unknown','not_independent','judge_not_author','synthetic-new-code']){
    const result=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});
    const warrant=(result.partitions as any).delivered[0].requirements[0].claims[0].warrant;
    if(independence===undefined)delete warrant.independence;else warrant.independence=independence;
    assert.equal(run([{result}]).error?.code,'case-review-report.block_unsettled',String(independence));
  }
  for(const independence of ['human_non_author','model_family_declared']){
    const result=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});
    (result.partitions as any).delivered[0].requirements[0].claims[0].warrant.independence=independence;
    assert.ok(run([{result}]).items);
  }
});

it('rejects initial review receipts as the wrong package before inspecting verification independence or status',()=>{
  for(const pending of [false,true]){
    const result=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});
    (result.locks as any).pack='case-review@1.0.7';
    delete (result.partitions as any).delivered[0].requirements[0].claims[0].warrant.independence;
    if(pending)Object.assign((result.partitions as any).delivered[0].requirements[0],{status:'unsatisfied',unsatisfied_reason:'outcome_mismatch'});
    const out=run([{result}]);assert.equal(out.error?.code,'case-review-report.block_invalid');assert.match(out.error?.message??'',/不是复核任务包/);assert.match(out.error?.fix??'',/case-review-verify.*rec:/);
  }
});

it('documents report behavior by version without private review narration or commit identities',()=>{
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
  const version=readme.split('## 2.0.1')[1]?.split('\n## ')[0];assert.ok(version);assert.match(version,/准入/);assert.match(version,/8 MiB/);assert.match(version,/dispositions/);
  const testing=readme.split('## 测试')[1];assert.doesNotMatch(testing,/本轮第|私有提交|完整投影/);
  assert.match(readme,/决定 42/);assert.doesNotMatch(readme,/\b[0-9a-f]{8,40}\b/);
});

it('pending verification names its unsettled layer reason and missing fact before requesting evidence recovery',()=>{
  const result=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});
  Object.assign((result.partitions as any).delivered[0].requirements[0],{status:'pending',layers:[{layer:'static',terminal:'unchecked',reason:'integrity_unproven'}],claims:[{qualifier:{nature:'fact'},statement:{verdict:'unknown',text:'合成目录未声明完整'}}]});
  const out=run([{result}]);assert.equal(out.error?.code,'case-review-report.block_unsettled');assert.match(out.error?.message??'',/未决.*静态.*未核对.*完整性未证明.*合成目录未声明完整/);assert.match(out.error?.fix??'',/复核回答.*缺失事实.*下一步.*重新核对/);assert.doesNotMatch(out.error?.fix??'',/换.*家族|修复并重交/);
});
it('no producer and independence unknown refusals request the missing contribution rather than generic repairs',()=>{
  for(const [reason,expected]of [['no_producer',/提交.*缺失.*判断/],['independence_unknown',/另开会话.*不同模型家族.*复核/]] as const){
    const result=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});Object.assign((result.partitions as any).delivered[0].requirements[0],{status:'unsatisfied',unsatisfied_reason:reason});
    const out=run([{result}]);assert.match(out.error?.fix??'',expected);assert.doesNotMatch(out.error?.fix??'',/先按.*修复/);assert.doesNotMatch(out.error?.message??'',new RegExp(reason));
  }
});
it('repair refusals preserve the first stored error corrective action',()=>{
  const result=block({verdict:'PARTIAL',level:'P4',entries:[{item:'c1'}]});result.errors=[{code:'case-review-verify.synthetic_error',fix:'请修正合成位置并保留原文',item:'c1'}];
  const out=run([{result}]);assert.match(out.error?.fix??'',/请修正合成位置并保留原文.*重交.*复核/);
});

it('pack findings refuses missing block finals and uncovered items before starting a report',()=>{
 for(const result of [block({verdict:null,level:null,entries:[{item:'c1'}]}),block({verdict:'PASS',level:'P4',partition:'incomplete',entries:[{item:'c9'}]})]){
  const out=run([{result}]);assert.ok(out.error);assert.match(out.error.message ?? '',/第.*块|条目.*c9/);assert.match(out.error.fix ?? '',/复核|重交/);assert.ok(!out.items);
 }
});
