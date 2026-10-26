// Decision 36: permanent defects refute with distinct correction paths; retained and temporarily unreadable text stays unknown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FragmentRead } from '../../../contracts/generated/vocabulary.ts';
import type { SourceView } from '../types.ts';
import { CheckOutcome as OutcomeSchema, type CheckOutcome } from '../../../contracts/src/tables.ts';
import { runCheck } from '../check.ts';
import { sourcesFrom } from '../api.ts';
import { getInterpreter } from './registry.ts';

const interpreter = 'quote@1';
const table = { schema: 'quote@1' as const, origin: '合成', quotes: [{ select: '$.q[*]', text: '/t', reference: '/r' }] };
const FRAGMENT = `src:${'a'.repeat(64)}/mindmap@1/n1`;
const run = (sources: SourceView, subject: unknown): CheckOutcome[] => {
  const registered = getInterpreter(interpreter);
  if (registered === undefined) throw new Error(`interpreter ${interpreter} not registered`);
  return registered.run({ interpreter, table, subject, sources, context: {} }) as CheckOutcome[];
};

/** A graded view: text() for the bound fragments, and why() for everything else. */
const graded = (texts: Record<string, string>, why: (reference: string) => FragmentRead): SourceView => {
  const view = sourcesFrom(texts);
  return {
    text: (reference) => view.text(reference),
    why: (reference) => (view.text(reference) === undefined ? why(reference) : 'bound'),
  };
};

describe('quote@1 over the graded source view', () => {
  it('verbatim passes and a non-verbatim quote is refuted, for a reference that appears only in slot data', () => {
    const view = graded({ [FRAGMENT]: '点击"登录"按钮后，页面跳转到\n首页。' }, () => 'bound');
    const ok = run(view, { q: [{ t: '页面跳转到\n首页', r: FRAGMENT }] });
    assert.equal(ok[0].verdict, 'support');
    const folded = run(view, { q: [{ t: '页面跳转到 首页', r: FRAGMENT }] });
    assert.equal(folded[0].verdict, 'refute');
    assert.equal(folded[0].code, 'QUOTE_MISMATCH');
    const bad = run(view, { q: [{ t: '页面跳转到登录页', r: FRAGMENT }] });
    assert.equal(bad[0].verdict, 'refute');
    assert.equal(bad[0].code, 'QUOTE_MISMATCH');
  });

  it('a reference whose source is not an input is refuted with a repair path', () => {
    const view = graded({}, () => 'not_bound');
    const out = run(view, { q: [{ t: '片段', r: FRAGMENT }] });
    assert.equal(out[0].verdict, 'refute');
    assert.equal(out[0].code, 'QUOTE_MISMATCH');
    assert.match(out[0].statement, /不是这次运行的输入.*改引.*输入/);
  });

  it('a selector that resolves to no fragment in a bound source is refuted as 片段不存在', () => {
    const view = graded({}, () => 'no_fragment');
    const out = run(view, { q: [{ t: '片段', r: FRAGMENT }] });
    assert.equal(out[0].verdict, 'refute');
    assert.match(out[0].statement, /片段不存在/);
  });

  it('a genuinely unreadable source stays unknown, with the honest reason', () => {
    for (const [why, expected] of [['retain_only', /含凭据，原文不可读/], ['unavailable', /取不回/]] as const) {
      const view = graded({}, () => why);
      const out = run(view, { q: [{ t: '片段', r: FRAGMENT }] });
      assert.equal(out[0].verdict, 'unknown', why);
      assert.match(out[0].statement, expected, why);
    }
  });

  it('a plain view without grading keeps the old unknown for anything it cannot read', () => {
    const out = run(sourcesFrom({}), { q: [{ t: '片段', r: FRAGMENT }] });
    assert.equal(out[0].verdict, 'unknown');
  });
});

it('retain-only quotes wait for administrator acceptance with generated source evidence',()=>{
  for(const sources of [graded({},()=> 'retain_only'),{text:()=>undefined,unread:()=>({reason:'credential_unreadable' as const,missing_fact:'管理员尚未接受此来源',next_action:'请求管理员接受来源，接受后重新核验'})}]) {
    const [out]=run(sources,{q:[{t:'合成引文',r:FRAGMENT}]});
    assert.equal(out.verdict,'unknown');assert.equal(out.reason,'awaiting_step');
    assert.equal(OutcomeSchema.safeParse(out).success,true);
    const unread=(out.data?.unread_sources as Array<Record<string,unknown>>)[0];
    assert.equal(unread.reference,FRAGMENT);assert.equal(unread.reason,'credential_unreadable');
    assert.match(String(unread.missing_fact),/管理员.*接受/);assert.match(String(unread.next_action),/请求管理员.*接受.*重新核验/);
    assert.match(out.statement,/含凭据，原文不可读.*管理员.*接受.*重新核验/);
  }
});

// Type checking guards the stored grading vocabulary as well as the runtime cases above.
const invalidGrade: SourceView = { text: () => undefined,
  // @ts-expect-error The model owns fragment read states; free-form grades cannot enter claims.
  why: () => 'invented_grade',
};
void invalidGrade;

it('permanent quote defects have distinct grades and actionable refutations', () => {
 for (const [why, remedy] of [['not_groundable', /B01.*结果.*动作.*效果/], ['entry_unaddressed', /tree:<根>\/<路径>@<条目>/], ['malformed', /src:<摘要>/], ['too_large', /更小的片段/]] as const) {
 const out = run(graded({}, () => why), {q:[{t:'片段',r:FRAGMENT}]})[0];
 assert.equal(out.verdict,'refute'); assert.equal(out.code,'QUOTE_MISMATCH'); assert.equal(out.data?.why,why); assert.match(out.statement,remedy);
 }
 for (const [why,remedy] of [['retain_only',/管理员.*接受.*重评/],['unavailable',/重读/]] as const) assert.match(run(graded({},()=>why),{q:[{t:'片段',r:FRAGMENT}]})[0].statement,remedy);
 const malformed=run(graded({},()=> 'malformed'),{q:[{t:'片段',r:'src:bad'}]})[0]; assert.equal(malformed.verdict,'refute'); assert.equal(malformed.data?.why,'malformed');
});
