// A recomposition the plan run cannot admit is refused with the condition that failed (decision 163, run 13: both slots bound to the
// same result record and the old sentence sent the model to wait for an "independent reviewer"). Synthetic records only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admittedRecomposition, recompositionProblem } from './recomposition.ts';
import { checkContractShape } from './checks.ts';
import { goodData, subjectOf } from './test-support.ts';
import { bound, pair } from '../testing/recompose.ts';

const context = { product: 'orbit', root: 'b'.repeat(64), product_pack_digest: 'c'.repeat(64) };

test('the same record bound in both slots is named as such, with what each slot takes', () => {
  const p = pair('recompose', [], [], { root: context.root, product_pack_digest: context.product_pack_digest });
  assert.equal(admittedRecomposition(p.result, p.result, context, 'src:x', 'n/1'), null);
  const message = recompositionProblem(p.result, p.result, context, 'src:x', 'n/1');
  assert.match(message, /recomposition_run 绑的是 validation_result 记录 rec:e{12}…，不是重组运行的运行记录：两个槽写成了同一个引用/);
  assert.match(message, /recomposition_result 绑重组运行号（run_…，Hub 换成该运行已受理的结果）/);
});

test('each later condition is named in the order the admission checks it', () => {
  const p = pair('recompose', [], [], { root: context.root, product_pack_digest: context.product_pack_digest });
  assert.match(recompositionProblem(p.run, bound('run', {}), context, 'src:x', 'n/1'), /recomposition_result 绑的是 run /);
  const other = pair('recompose-authority', [], [], { root: context.root, product_pack_digest: context.product_pack_digest });
  assert.match(recompositionProblem(other.run, other.result, context, 'src:x', 'n/1'), /是 recompose-authority@1\.1\.1 的运行，不是 recompose@1\.1\.1 的重组运行/);
  assert.match(recompositionProblem(p.run, p.result, { ...context, root: 'f'.repeat(64) }, 'src:x', 'n/1'), /产品、版本根或产品包与本运行不同/);
  assert.match(recompositionProblem(p.run, p.result, context, 'src:x', 'n/1'), /里没有这条用例（脑图节点 n\/1）/);
});

test('the plan checks refuse with the named condition instead of waiting for a reviewer', () => {
  const input = subjectOf(goodData()) as unknown as { subject: Record<string, unknown> };
  input.subject.recomposition_requested = true;
  input.subject.recomposition_problem = 'recomposition_run 绑的是 validation_result 记录 rec:aaaaaaaaaaaa…，不是重组运行的运行记录：两个槽写成了同一个引用';
  const outcomes = checkContractShape(input) as Array<{ verdict: string; missing?: string }>;
  const gap = outcomes.find((o) => o.verdict === 'unknown');
  assert.ok(gap, JSON.stringify(outcomes));
  assert.match(String(gap!.missing), /重组记录不可受理：recomposition_run 绑的是 validation_result 记录/);
  assert.doesNotMatch(String(gap!.missing), /核对方/);
});
