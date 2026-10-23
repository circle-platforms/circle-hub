// quote@1 with the graded source view: the interpreter asks for a fragment by reference and the view answers with why
// the text is missing — not bound to this run (the model can fix the reference: refute), no such fragment in a bound
// source (the model can fix the selector or the quote: refute), or genuinely unreadable (retain-only, over the size
// cap, the source cannot be fetched: unknown, honestly). The run's own lazy fallback (evaluate.ts) supplies the same
// grading for references that appear only inside slot data, parsed by the boundary's own parser.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SourceView } from '../types.ts';
import type { CheckOutcome } from '../../../contracts/src/tables.ts';
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
const graded = (texts: Record<string, string>, why: (reference: string) => string): SourceView => {
  const view = sourcesFrom(texts);
  return {
    text: (reference) => view.text(reference),
    why: (reference) => (view.text(reference) === undefined ? why(reference) : 'bound'),
  };
};

describe('quote@1 over the graded source view', () => {
  it('verbatim passes and a non-verbatim quote is refuted, for a reference that appears only in slot data', () => {
    const view = graded({ [FRAGMENT]: '点击"登录"按钮后，页面跳转到\n首页。' }, () => 'bound');
    const ok = run(view, { q: [{ t: '页面跳转到 首页', r: FRAGMENT }] });
    assert.equal(ok[0].verdict, 'support');
    const bad = run(view, { q: [{ t: '页面跳转到登录页', r: FRAGMENT }] });
    assert.equal(bad[0].verdict, 'refute');
    assert.equal(bad[0].code, 'QUOTE_MISMATCH');
  });

  it('a reference whose source is not an input of this run is refuted, with the reason the model can act on', () => {
    const view = graded({}, () => 'not_bound');
    const out = run(view, { q: [{ t: '片段', r: FRAGMENT }] });
    assert.equal(out[0].verdict, 'refute');
    assert.match(out[0].statement, /不是这次运行的输入/);
  });

  it('a selector that resolves to no fragment in a bound source is refuted as 片段不存在', () => {
    const view = graded({}, () => 'no_fragment');
    const out = run(view, { q: [{ t: '片段', r: FRAGMENT }] });
    assert.equal(out[0].verdict, 'refute');
    assert.match(out[0].statement, /片段不存在/);
  });

  it('a genuinely unreadable source stays unknown, with the honest reason', () => {
    for (const [why, expected] of [['retain_only', /含凭据，原文不可读/], ['too_large', /超过大小上限/], ['unavailable', /取不回/]] as const) {
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
