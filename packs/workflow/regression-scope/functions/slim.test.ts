import { facetInput } from './test-support.ts';
// The slim impact view (attached_fields): the scope reads only document, node, title, priority, negative of a case, so the
// slimmed view gives the same scope as the full one. And the guard: a scope that would not fit the sandbox's output budget
// is a clean refusal (regression-scope.too_large), never a sandbox memory failure.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { callPackFunction } from '../../../../hub/rules/api.ts';
import { osIsolationAvailable } from '../../../../hub/rules/api.ts';
import { LIMITS, projectItems } from './test-support.ts';
import { buildImpact, reversedView, reviewChanges, reviewOptions, type ChangeSpec } from './test-support.ts';

const packDir = fileURLToPath(new URL('../', import.meta.url));
const available = await osIsolationAvailable();

/** The view with its case entries as attached_fields=document,node,title,priority,negative serves them: only those data
 * fields, an empty statement. */
function slimmed(view: { [key: string]: unknown }): { [key: string]: unknown } {
  const copy = structuredClone(view);
  const entries = copy.entries as Record<string, { kind: string; statement: string; data: Record<string, unknown> }>;
  for (const entry of Object.values(entries)) {
    if (entry.kind !== 'case') continue;
    const data: Record<string, unknown> = {};
    for (const field of ['document', 'node', 'title', 'priority', 'negative']) if (Object.hasOwn(entry.data, field)) data[field] = entry.data[field];
    entry.statement = '';
    entry.data = data;
  }
  copy.attached_fields = ['document', 'negative', 'node', 'priority', 'title'];
  return copy;
}

/** A synthetic corpus: `paths` changed paths with `perPath` in-scope cases each. */
function bigChanges(paths: number, perPath: number): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let k = 0;
  for (let p = 0; p < paths; p++) {
    const to = [];
    for (let i = 0; i < perPath; i++) {
      k++;
      to.push({ document: `doc-${k % 100}`, node: `n${k}`, title: `用例 ${k}：设置参数后查看结果，含较长的标题文字以贴近真实`, priority: (k % 3) + 1 });
    }
    changes.push({ path: `/commands/g${p}`, change: 'modified', before: [{ name: `c${p}` }], after: [{ name: `c${p}`, args: [{ name: 'a', type: 'int' }] }], to });
  }
  return changes;
}

describe('the slim impact view (attached_fields)', () => {
  it('gives the same scope as the full view, in either member order', () => {
    const full = buildImpact(reviewChanges(), reviewOptions());
    const slim = slimmed(full);
    const same = (v: unknown) => (projectItems({ inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: v, meta: null }], parameters: {}, context: {} }) as { items: unknown[] }).items;
    assert.deepEqual(same(slim), same(full), 'the slim view gives the same items');
    assert.deepEqual(same(slimmed(reversedView(full) as { [key: string]: unknown })), same(slim), 'and does not depend on order');
  });

  it('the projection output is identical with the slim view, whose model is smaller', () => {
    const full = buildImpact(bigChanges(50, 100));
    const slim = slimmed(full);
    const sizeOf = (v: unknown) => JSON.stringify(projectItems({ inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: v, meta: null }], parameters: {}, context: {} })).length;
    assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length, `${JSON.stringify(slim).length} < ${JSON.stringify(full).length}`);
    assert.deepEqual(sizeOf(slim), sizeOf(full), 'the pack reads only the five fields, so the outputs are identical');
  });

  it('a scope beyond the output budget is a clean refusal, never a sandbox failure', () => {
    const view = buildImpact(bigChanges(40, 200));
    // Over the item cap.
    const byCount = projectItems({ inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: view, meta: null }, facetInput(view)], parameters: {}, context: {} }, { maxItems: 100, outputBytes: 64 * 1024 * 1024 }) as { error?: { code: string; fix: string } };
    assert.equal(byCount.error?.code, 'regression-scope.too_large');
    // Under the item cap but over the output budget.
    const byBytes = projectItems({ inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: view, meta: null }, facetInput(view)], parameters: {}, context: {} }, { maxItems: 9000, outputBytes: 1024 * 1024 }) as { error?: { code: string } };
    assert.equal(byBytes.error?.code, 'regression-scope.too_large');
    assert.match(byCount.error?.fix ?? '', /priorities/);
    // Under the limits it goes through.
    const ok = projectItems({ inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: view, meta: null }, facetInput(view)], parameters: {}, context: {} }, { maxItems: 9000, outputBytes: 16 * 1024 * 1024 }) as { items?: unknown[] };
    assert.equal(Array.isArray(ok.items) ? ok.items.length : -1, 8000);
  });

  it('the largest admitted scope (4,000 in-scope cases of a slim view) completes within the sandbox memory of 256 MB', { skip: available ? false : 'no OS network isolation on this machine (sandbox-exec)', timeout: 300_000 }, async () => {
    const view = slimmed(buildImpact(bigChanges(100, 40)));
    const out = await callPackFunction(
      { packDir, module: 'functions/project.ts' },
      { inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: view, meta: null }, facetInput(view)], parameters: {}, context: {} },
      { timeoutMs: 120_000 },
    );
    assert.equal((out.output as { items?: unknown[] }).items?.length ?? -1, 4_000, JSON.stringify(out.output).slice(0, 300));
  });

  it('a scope past the guard is refused by the pack, so the sandbox never dies on memory (the incident shape)', { skip: available ? false : 'no OS network isolation on this machine (sandbox-exec)', timeout: 300_000 }, async () => {
    // 33,000 slim cases: past the guard; the refusal is small and fast, not a 256 MB memory failure.
    const view = slimmed(buildImpact(bigChanges(200, 165)));
    const out = await callPackFunction(
      { packDir, module: 'functions/project.ts' },
      { inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: view, meta: null }, facetInput(view)], parameters: {}, context: {} },
      { timeoutMs: 120_000, inputBytes: 48 * 1024 * 1024 },
    );
    assert.equal((out.output as { error?: { code: string } }).error?.code, 'regression-scope.too_large');
  });
});
