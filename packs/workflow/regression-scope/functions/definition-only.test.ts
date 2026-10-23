// The scope counts only definition changes (decision 11): the impact view must be definition-only (changed_kinds =
// ['definition']) and a view that also counts behaviour refuses the whole run with the right form in the fix. A second,
// optional input — the behaviour view of the same pair of builds — never enters the scope or any count; it only adds a
// clue paragraph to the note (at most 5 paths named, then 另有 M 条). The over-4000 refusal keeps its message and adds
// one sentence: the definition change may already have narrowed the scope.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildImpact, reviewChanges } from './test-support.ts';
import { projectItems } from './test-support.ts';

const SOURCE = 'a'.repeat(64);
const BEHAVIOUR_SOURCE = 'b'.repeat(64);
const view = (changes: Parameters<typeof buildImpact> extends never ? never : ReturnType<typeof buildImpact>) => changes;

describe('the scope counts only definition changes', () => {
  it('refuses an impact view whose changed kinds are not definition-only, with the right form in the fix', () => {
    const both = buildImpact(reviewChanges(), { changedKinds: ['behaviour', 'definition'] }); // the old default
    const refused = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: both }], parameters: {}, context: {} }) as { error: { code: string; message: string; fix: string } };
    assert.equal(refused.error.code, 'regression-scope.changed_kinds');
    assert.match(refused.error.message, /只按命令定义/);
    assert.match(refused.error.fix, /changed=definition/);
  });

  it('accepts the definition-only view and never reads behaviour rows into the scope', () => {
    const definitionsOnly = { ...view(buildImpact(reviewChanges())), changed_kinds: ['definition'] };
    const answer = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: definitionsOnly }], parameters: {}, context: {} }) as { error?: { code: string }; items?: unknown[] };
    assert.equal(answer.error, undefined, JSON.stringify(answer.error));
    assert.ok(Array.isArray(answer.items), 'the scope projects');
  });

  it('the behaviour view of the same pair adds one clue paragraph to the note, never to the scope or the counts', () => {
    const definitionsOnly = { ...view(buildImpact(reviewChanges())), changed_kinds: ['definition'] };
    const behaviour = { ...view(buildImpact(reviewChanges())), changed_kinds: ['behaviour'] };
    const withClue = projectItems({
      inputs: [
        { slot: 'impact', sha256: SOURCE, model: definitionsOnly },
        { slot: 'behaviour', sha256: BEHAVIOUR_SOURCE, model: behaviour },
      ],
      parameters: {},
      context: {},
    }) as { groups: Array<{ message?: string }>; items: unknown[] };
    const note = withClue.groups.map((g) => g.message ?? '').join('');
    assert.match(note, /手册说明有变化的命令 5 条（只作线索，不算进范围）/);
    assert.match(note, /\/commands\/show/);
    const withoutClue = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: definitionsOnly }], parameters: {}, context: {} }) as { groups: Array<{ message?: string }>; items: unknown[] };
    assert.ok(!withoutClue.groups.map((g) => g.message ?? '').join('').includes('手册说明'), 'no clue paragraph without the optional input');
    assert.equal(withClue.items.length, withoutClue.items.length, 'the clue never changes the scope');
  });

  it('names at most 5 clue paths and counts the rest as 另有', () => {
    const changes = reviewChanges();
    const extras = Array.from({ length: 7 }, (_, i) => ({ path: `/commands/behaviour-${i}`, change: 'modified' as const, before: [{ name: `b${i}` }], after: [{ name: `b${i}` }], behaviourBefore: ['旧'], behaviourAfter: ['新'] }));
    const many = [...changes, ...extras];
    const definitionsOnly = { ...view(buildImpact(changes)), changed_kinds: ['definition'] };
    const behaviour = { ...view(buildImpact(many)), changed_kinds: ['behaviour'] };
    const withClue = projectItems({
      inputs: [
        { slot: 'impact', sha256: SOURCE, model: definitionsOnly },
        { slot: 'behaviour', sha256: BEHAVIOUR_SOURCE, model: behaviour },
      ],
      parameters: {},
      context: {},
    }) as { groups: Array<{ message?: string }> };
    const note = withClue.groups.map((g) => g.message ?? '').join('');
    assert.match(note, /另有 7 条/);
  });

  it('the over-4000 refusal adds the sentence about the definition change narrowing the scope', () => {
    const many = Array.from({ length: 4010 }, (_, i) => ({
      path: `/commands/c${i}`,
      change: 'added' as const,
      after: [{ name: `c${i}` }],
      to: [{ document: 'doc-1', node: `n${i}`, title: `用例 ${i}`, priority: 1 }],
    }));
    const definitionsOnly = { ...view(buildImpact(many)), changed_kinds: ['definition'] };
    const refused = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: definitionsOnly }], parameters: {}, context: {} }, { maxItems: 4000 }) as { error: { code: string; fix: string } };
    assert.equal(refused.error.code, 'regression-scope.too_large');
    assert.match(refused.error.fix, /先看定义变化是否已经把范围缩小/);
  });
});
