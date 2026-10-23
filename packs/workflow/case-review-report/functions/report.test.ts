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
      { requirement: 'verification', claims: [{ qualifier:{nature:'judgment'},warrant:{producer:'model',id:'synthetic-verifier@1'},statement: { code: entry.kind ?? 'verified', text: entry.text ?? `发现 ${entry.item}`, rank: entry.rank ?? 'minor' }, data: {} }] },
      { requirement: 'final', claims: [] },
    ],
  }));
  // The real-data shape: a block that carries entries it did not deliver lists them unfinished (the first half), the
  // rest of its entries stay delivered. 分区只有 delivered、rejected、quarantined、incomplete。
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
            { qualifier:{nature:'judgment'},warrant:{producer:'model',id:'synthetic-verifier@1'},statement: { code: spec.verdict, rank: spec.level, text: '结论' }, grounds: [], pointer: '/cross_item/0', requirement: 'final' },
            { requirement: 'final', pointer: '/cross_item/0', statement: { verdict: spec.hub ?? 'support', text: '与处置一致', data: {} }, grounds: [] },
          ],
        }),
  };
}

type ProjectionAnswer={items?:ProjectedItem[];error?:{code?:string;message?:string;fix?:string}};
function run(blocks:Array<{result:Record<string,unknown>}>,options:{omitTarget?:boolean;parser?:string;digest?:string;priority?:number|null;model?:unknown}={}):ProjectionAnswer{
  let n=0;
  const ids=[...new Set(blocks.flatMap(block=>Object.values((block.result.partitions??{}) as Record<string,any[]>).flatMap(entries=>entries.map(entry=>String(entry.item)))))];
  const source=kityminderParser.parse(Buffer.from(JSON.stringify({root:{data:{id:'root',text:'合成文档'},children:ids.map(id=>({data:{id,text:'用例 '+id,priority:2,resource:['Functional']},children:[{data:{id:id+'-pre',text:'准备',priority:3}},{data:{id:id+'-e',text:'成功'}}]}))}}))).model;
  const inputs:unknown[]=blocks.map(block=>({slot:'verifications',external:null,sha256:'0'.repeat(64),media_type:'application/json',parser:'json@1',model:{kind:'validation_result',schema:'record@1',body:block.result},meta:{record:String(++n).repeat(64)}}));
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
    assert.match(c1?.summary ?? '', /^证实 rec:[0-9a-f]{64}#.+；推翻 0 条$/);
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
    assert.equal(reportItemOf(run([{result}])).fields.overall,null,'an unmatched submission pointer cannot supply a final');
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

  it('an item delivered in no block makes the overall unknown with the missing items named (no verdict code)', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PASS', level: 'P3', partition: 'incomplete', entries: [{ item: 'c9' }] }) },
    ]);
    const report = reportItemOf(out);
    assert.deepEqual(report.fields.missing_items, ['c9']);
    assert.equal(report.fields.overall, null, '有缺漏条目时整体记未知，不给结论码');
    assert.match(report.summary ?? '', /覆盖不完整/);
    assert.match(report.summary ?? '', /c9/);
    assert.doesNotMatch(report.summary ?? '', /结论码/);
  });

  it('an item only ever in a non-delivered partition (rejected) counts as missing too', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PASS', level: 'P3', partition: 'rejected', entries: [{ item: 'c8' }, { item: 'c7' }] }) },
    ]);
    const report = reportItemOf(out);
    assert.deepEqual(report.fields.missing_items, ['c8']);
    assert.equal(report.fields.overall, null);
  });

  it('the Hub refuting (or not knowing) a block\'s final makes the block\'s conclusion unknown', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PARTIAL', level: 'P5', hub: 'refute', entries: [{ item: 'c2' }] }) },
    ]);
    assert.equal(reportItemOf(out).fields.overall, null, '被 Hub 驳回的结论不采信');
    assert.match(reportItemOf(out).summary??'', /第 2 块.*结论.*下一步/);
    const unknownHub = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: 'PARTIAL', level: 'P5', hub: 'unknown', entries: [{ item: 'c2' }] }) },
    ]);
    assert.equal(reportItemOf(unknownHub).fields.overall, null, 'Hub 记未知的结论不采信');
  });

  it('a block without a readable final makes the overall unknown', () => {
    const out = run([
      { result: block({ verdict: 'PASS', level: 'P3', entries: [{ item: 'c1' }] }) },
      { result: block({ verdict: null, level: null, entries: [{ item: 'c2' }] }) },
    ]);
    const report = reportItemOf(out);
    assert.equal(report.fields.overall, null);
    assert.match(report.summary??'', /第 2 块.*结论.*下一步/);
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
    assert.equal(refutedItem.summary, '没有要引用的发现；推翻 1 条');

    const partialItem = items.find((i) => i.id === 'case-2-2');
    assert.ok(partialItem !== undefined);
    assert.match(partialItem.summary ?? '', /^部分正确 rec:[0-9a-f]{64}#.+；推翻 0 条$/);

    // Extract all citable references from items' summaries
    const citedRefs: string[] = [];
    for (const it of items) {
      const matches = it.summary?.match(/rec:[0-9a-f]{64}#[^\s；、]+/g) ?? [];
      citedRefs.push(...matches);
    }
    // 45 findings total - 1 refuted = 44 citable references
    assert.equal(citedRefs.length, 44);

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
    assert.equal(out.verdict, 'unknown');
    assert.equal(out.reason, 'missing_input');
    const withMissing = { applies: 'run', items: [{ id: 'report', label: '评审终稿', location: `src:${DIGEST}/kityminder@1/n/c1`, fields: { overall: null, findings, missing_items: ['c9', 'c10'] } }], context: {}, cross_item: [verdictClaim('PARTIAL', 'P4', refs)] };
    const outMissing = overallCheck({ subject: withMissing })[0]!;
    assert.deepEqual([outMissing.verdict, outMissing.reason], ['unknown', 'missing_input']);
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
    assert.equal(report.id,'report');assert.equal(typeof report.fields.review_tables,'string');assert.equal(typeof report.fields.review_tables_full,'string');
    assert.ok(report.fields.review_counts);assert.match(report.summary??'',/#\/items\/0\/fields\/review_tables/);
    assert.match(String(report.fields.review_tables_full),/；前置：准备/);
    const noPriority=run(blocks(),{priority:null});assert.match(String(noPriority.items![0].fields.review_tables_full),/；期望：准备/);assert.doesNotMatch(String(noPriority.items![0].fields.review_tables_full),/；前置：/);
  });
  it('does not produce tables until missing conclusions and undelivered items are repaired',()=>{
    for(const entries of [[{result:block({verdict:null,level:null,entries:[{item:'c1'}]})}],[{result:block({verdict:'PASS',level:'P3',entries:[{item:'c1'}],partition:'incomplete'})}]]){
      const report=reportItemOf(run(entries));assert.equal(report.fields.overall,null);assert.equal(report.fields.review_tables,undefined);assert.match(report.summary??'',/下一步.*复核.*终稿/);
    }
  });
});
