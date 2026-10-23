import { facetInput } from './test-support.ts';
// The maintenance-sweep guard: a pair whose maintenance list would not fit the sandbox's output budget is a clean refusal
// (maintenance-sweep.too_large), never a sandbox memory failure. Measured before the guard: 25,000 items died in the
// sandbox at about 640 MB (resident watch, 256 MB limit); the pack reads the definition entries whole for the diff, so the
// slimming of attached case entries is not its lever.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { callPackFunction, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import { LIMITS, projectItems } from './test-support.ts';
import { buildImpact, type ChangeSpec } from './test-support.ts';

const packDir = fileURLToPath(new URL('../', import.meta.url));
const available = await osIsolationAvailable();

/** A synthetic corpus: `paths` modified paths with `perPath` earlier-build cases each (all maintenance items). */
function bigChanges(paths: number, perPath: number): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  let k = 0;
  for (let p = 0; p < paths; p++) {
    const from = [];
    for (let i = 0; i < perPath; i++) {
      k++;
      from.push({ document: `doc-${k % 100}`, node: `n${k}`, title: `用例 ${k}：设置参数后查看结果，含较长的标题文字以贴近真实`, priority: (k % 3) + 1 });
    }
    changes.push({ path: `/commands/g${p}`, change: 'modified', before: [{ name: `c${p}`, args: [{ name: 'a', type: 'string' }] }], after: [{ name: `c${p}`, args: [{ name: 'a', type: 'int' }] }], from });
  }
  return changes;
}

describe('the maintenance-sweep guard', () => {
  it('a sweep beyond the limits is a clean refusal (too_large), under them it answers', () => {
    const view = buildImpact(bigChanges(40, 200));
    const byCount = projectItems({ inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: view, meta: null }, facetInput(view)], parameters: {}, context: {} }, { maxItems: 100, outputBytes: 64 * 1024 * 1024 }) as { error?: { code: string; fix?: string } };
    assert.equal(byCount.error?.code, 'maintenance-sweep.too_large');
    assert.match(byCount.error?.fix ?? '', /更近|少跨/);
    const ok = projectItems({ inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: view, meta: null }, facetInput(view)], parameters: {}, context: {} }, { maxItems: 9000, outputBytes: 16 * 1024 * 1024 }) as { items?: unknown[] };
    assert.equal(Array.isArray(ok.items) ? ok.items.length : -1, 8000);
  });

  it('the largest admitted sweep (4,000 items) completes within the sandbox memory of 256 MB', { skip: available ? false : 'no OS network isolation on this machine (sandbox-exec)', timeout: 300_000 }, async () => {
    const view = buildImpact(bigChanges(100, 40));
    const out = await callPackFunction(
      { packDir, module: 'functions/project.ts' },
      { inputs: [{ slot: 'impact', sha256: 'ab'.repeat(32), parser: 'json@1', model: view, meta: null }, facetInput(view)], parameters: {}, context: {} },
      { timeoutMs: 120_000 },
    );
    assert.equal((out.output as { items: unknown[] }).items.length, 4_000);
  });
});
