import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLinearGrowth, measureGrowth } from './growth.ts';

// Synthetic workloads with a known cost: `steps` iterations of a loop the compiler cannot remove.
let sink = 0;
function work(steps: number): void {
  let x = sink;
  for (let i = 0; i < steps; i++) x = (x * 1_103_515_245 + 12_345) % 2_147_483_647;
  sink = x;
}

test('a linear cost passes and reports the measured ratio', () => {
  const growth = assertLinearGrowth('linear', (n) => n, (n) => work(n), { small: 500_000 });
  assert.equal(growth.large, 4_000_000);
  assert.equal(growth.belowNoise, false, `the large run must be above the noise floor: ${growth.largeMs} ms`);
  assert.ok(growth.ratio > 2 && growth.ratio <= growth.maxRatio, `ratio ${growth.ratio}`);
});

test('a quadratic cost fails with the sizes, times and ratio in the message', () => {
  assert.throws(
    () => assertLinearGrowth('quadratic', (n) => n, (n) => work(n * n), { small: 400 }),
    (error: unknown) => error instanceof assert.AssertionError && /super-linear growth: quadratic: 400 → 3200 took .* ms of CPU, ratio [\d.]+ \(limit 16\)/.test(error.message),
  );
});

test('a refusal is timed like any other outcome', () => {
  const growth = measureGrowth((n) => n, (n) => { work(n); throw new Error('refused'); }, { small: 500_000, factor: 4, runs: 1 });
  assert.equal(growth.large, 2_000_000);
  assert.equal(growth.maxRatio, 8);
  assert.ok(growth.largeMs > 0);
});

test('a cost below the noise floor is not judged by its ratio', () => {
  const growth = assertLinearGrowth('constant', (n) => n, (n) => work(n * n), { small: 10, noiseFloorMs: 1_000 });
  assert.equal(growth.belowNoise, true);
  assert.throws(() => measureGrowth((n) => n, () => undefined, { small: 1, factor: 1 }), /factor > 1/);
});
