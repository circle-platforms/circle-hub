// The reason's definition change, written after the real-data finding: a path whose later build has a definition
// entry the earlier lacks is a new command (added), one the earlier build had and the later lacks is removed, both
// with different digests is modified, and equal definitions (only behaviour texts moved) is none. The path's own
// change (entries coming and going on the path) stays as it was, for the other packs.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scopeOf } from './scope.ts';
import { buildImpact, type ChangeSpec } from './test-support.ts';
import { parseView } from './view.ts';

const PARAMETERS = { priorities: null as number[] | null, includeAdded: true };
const CASE = { document: 'doc-1', node: 'n1', title: '甲', priority: 1 };

const scopeOfChanges = (changes: readonly ChangeSpec[]) => {
  const parsed = parseView(buildImpact(changes));
  if (!parsed.ok) throw new Error(parsed.message);
  return scopeOf(parsed.view, PARAMETERS);
};

describe('definition_change of a reason', () => {
  // The definition change rides the run-level detail row the reason indexes; the reason itself only carries the
  // index and the path's change kind.
  const reasonDetail = (scope: ReturnType<typeof scopeOfChanges>, at = 0) => scope.note.details[scope.items[0].reasons[at].detail];

  it('a command the earlier build lacked is added, even when the path already carried behaviour entries (modified)', () => {
    // The view says modified (behaviour texts came and went); the definitions say the command itself is new.
    const scope = scopeOfChanges([
      { path: '/commands/new', change: 'modified', behaviourBefore: ['旧手册说明'], behaviourAfter: ['新手册说明'], after: [{ name: 'new' }], to: [CASE] },
    ]);
    assert.equal(scope.items.length, 1);
    assert.equal(reasonDetail(scope).definition_change, 'added');
    assert.equal(scope.items[0].reasons[0].change, 'modified', 'the path change stays as the view said');
    assert.ok(/新增命令/.test(reasonDetail(scope).conclusion), JSON.stringify(scope.note.details));
  });

  it('a command only the earlier build had is removed', () => {
    const scope = scopeOfChanges([
      { path: '/commands/gone', change: 'modified', behaviourBefore: ['旧说明'], behaviourAfter: ['新说明'], before: [{ name: 'gone' }], to: [CASE] },
    ]);
    assert.equal(reasonDetail(scope).definition_change, 'removed');
    assert.match(reasonDetail(scope).conclusion, /删除命令|命令已删除/);
  });

  it('definitions on both sides with different digests is modified', () => {
    const scope = scopeOfChanges([
      { path: '/commands/changed', change: 'modified', before: [{ name: 'changed', args: [{ name: 'n', type: 'string' }] }], after: [{ name: 'changed', args: [{ name: 'n', type: 'integer' }] }], to: [CASE] },
    ]);
    assert.equal(reasonDetail(scope).definition_change, 'modified');
    assert.match(reasonDetail(scope).conclusion, /命令定义有变更/);
  });

  it('equal definitions (only behaviour texts changed) is none', () => {
    // Hand-built addition to the builder's view: one definition entry whose digest is the same on both sides (an
    // unchanged entry is one entry the two builds share). The builder always mints new digests, so the equal case
    // cannot go through buildImpact alone.
    const shared = 'a'.repeat(64);
    const view = buildImpact([{ path: '/commands/text', change: 'modified', behaviourBefore: ['说明甲'], behaviourAfter: ['说明乙'], to: [CASE] }]);
    const entries = view.entries as Record<string, unknown>;
    entries[shared] = { entry: shared, kind: 'definition', statement: '定义', data: { name: 'text' }, reference: `tree:${'ab'.repeat(32)}/commands/text@${shared}` };
    (view.changes as Array<{ before: string[]; after: string[] }>)[0].before.push(shared);
    (view.changes as Array<{ before: string[]; after: string[] }>)[0].after.push(shared);
    const parsed = parseView(view);
    assert.ok(parsed.ok);
    const scope = scopeOf(parsed.view, PARAMETERS);
    assert.equal(reasonDetail(scope).definition_change, 'none');
  });

  it('a path with no definition entry on either side is none (no command definition to compare)', () => {
    const scope = scopeOfChanges([
      { path: '/commands/bare', change: 'added', behaviourAfter: ['只有行为说明'], to: [CASE] },
    ]);
    assert.equal(reasonDetail(scope).definition_change, 'none');
  });

  it('the item summary names the definition change of its first reason', () => {
    const scope = scopeOfChanges([
      { path: '/commands/new', change: 'modified', behaviourBefore: ['旧手册说明'], behaviourAfter: ['新手册说明'], after: [{ name: 'new' }], to: [CASE] },
    ]);
    assert.match(scope.items[0].summary, /新增命令/);
  });
});
