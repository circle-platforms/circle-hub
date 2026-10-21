// Calibration math (K04 R[1]): the Wilson lower bound against values computed independently, and the threshold rule with
// known cases (at least 30 samples, lower bound at least 0.95, the lowest qualifying probability). Masking of literals.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CalibrationSample } from '../../contracts/src/knowledge.ts';
import { NONE_OPTION } from '../jev/api.ts';
import { CALIBRATION, maskLiterals, thresholdOf, wilsonLowerBound } from './calibration.ts';

const sample = (i: number, probability: number, correct: boolean): CalibrationSample => ({
  input: i.toString(16).padStart(64, '0'),
  expected: 'a',
  chosen: correct ? 'a' : 'b',
  probability,
});
const many = (n: number, probability: number, correct: boolean, offset = 0): CalibrationSample[] => Array.from({ length: n }, (_, i) => sample(offset + i, probability, correct));

describe('Wilson lower bound', () => {
  // Reference values computed outside this code with the closed formula (z = 1.959963984540054).
  const cases: Array<[number, number, number]> = [
    [81, 100, 0.7222115462093562],
    [30, 30, 0.8864866068260312],
    [72, 72, 0.9493488274035422],
    [73, 73, 0.9500079920442687],
    [43, 44, 0.8819229030178671],
    [98, 100, 0.9299882092714561],
    [290, 300, 0.9397381741959452],
    [0, 10, 0],
    [5, 10, 0.236593090512564],
    [10, 10, 0.7224672001371106],
  ];
  for (const [k, n, expected] of cases) {
    test(`${k} of ${n}`, () => assert.ok(Math.abs(wilsonLowerBound(k, n) - expected) < 1e-12, `${wilsonLowerBound(k, n)} vs ${expected}`));
  }
  test('no trials give 0 and impossible counts are refused', () => {
    assert.equal(wilsonLowerBound(0, 0), 0);
    assert.throws(() => wilsonLowerBound(3, 2));
    assert.throws(() => wilsonLowerBound(-1, 2));
    assert.throws(() => wilsonLowerBound(0.5, 2));
  });
});

describe('threshold', () => {
  test('the rule is 0.95 precision, 30 samples, z of the 95 % interval', () => {
    assert.deepEqual({ ...CALIBRATION }, { precision: 0.95, minSamples: 30, z: 1.959963984540054 });
  });

  test('no samples, or too few, leave the chain uncalibrated', () => {
    assert.equal(thresholdOf([]).threshold, null);
    assert.equal(thresholdOf(many(29, 0.99, true)).threshold, null);
  });

  test('30 right answers are not enough for a 0.95 lower bound; 73 are, 72 are not', () => {
    assert.equal(thresholdOf(many(30, 0.9, true)).threshold, null);
    assert.equal(thresholdOf(many(72, 0.9, true)).threshold, null);
    const ok = thresholdOf(many(73, 0.9, true));
    assert.equal(ok.threshold, 0.9);
    assert.equal(ok.samples, 73);
    assert.equal(ok.correct, 73);
    assert.ok((ok.lower as number) >= 0.95);
  });

  test('the lowest qualifying probability wins; wrong low-probability answers push the threshold up', () => {
    // 100 right at 0.95, 20 wrong at 0.6: the set from 0.6 up has precision 100/120, from 0.95 up 100/100.
    const samples = [...many(100, 0.95, true), ...many(20, 0.6, false, 1000)];
    assert.equal(thresholdOf(samples).threshold, 0.95);
    // With the wrong ones above the right ones, nothing qualifies.
    const inverted = [...many(100, 0.6, true), ...many(20, 0.95, false, 1000)];
    assert.equal(thresholdOf(inverted).threshold, null);
  });

  test('samples at the same probability enter or leave the set together', () => {
    // At 0.9: 40 right and 5 wrong; at 0.99: 80 right. From 0.9 up 120 of 125 (lower bound 0.910) does not qualify; dropping
    // only the wrong answers at 0.9 would leave 120 of 120 (0.969), which no threshold describes. From 0.99 up: 80 of 80.
    const samples = [...many(5, 0.9, false, 5000), ...many(40, 0.9, true), ...many(80, 0.99, true, 2000)];
    const result = thresholdOf(samples);
    assert.equal(result.threshold, 0.99);
    assert.equal(result.samples, 80);
  });

  test('only answers that would descend count: abstentions neither make nor block a threshold (K04 R[1])', () => {
    const none = (i: number, probability: number, expected: string): CalibrationSample => ({ input: i.toString(16).padStart(64, '0'), expected, chosen: NONE_OPTION, probability });
    const abstained = (n: number, probability: number, expected: string, offset: number) => Array.from({ length: n }, (_, i) => none(offset + i, probability, expected));
    // 1000 right abstentions do not hide 20 wrong descents at the same probability.
    assert.equal(thresholdOf([...abstained(1000, 0.99, NONE_OPTION, 10_000), ...many(20, 0.99, false)]).threshold, null);
    // 48 right and 2 wrong descents stay uncalibrated however many right abstentions sit beside them.
    assert.equal(thresholdOf([...many(48, 0.99, true), ...many(2, 0.99, false, 100), ...abstained(100, 0.99, NONE_OPTION, 20_000)]).threshold, null);
    // Confident abstentions on questions whose answer was a child do not block 100 right descents.
    const result = thresholdOf([...many(100, 0.99, true), ...abstained(10, 0.995, 'a', 30_000)]);
    assert.equal(result.threshold, 0.99);
    assert.deepEqual([result.samples, result.correct], [100, 100]);
  });

  test('a child chosen where none was right is a wrong descent', () => {
    const wrong = Array.from({ length: 10 }, (_, i): CalibrationSample => ({ input: (5000 + i).toString(16).padStart(64, '0'), expected: NONE_OPTION, chosen: 'a', probability: 0.99 }));
    assert.equal(thresholdOf([...many(100, 0.99, true), ...wrong]).threshold, null, '100 of 110 descents right');
    assert.equal(thresholdOf(many(100, 0.99, true)).threshold, 0.99);
  });

  test('a mixed realistic set: the threshold is where the precision bound first reaches 0.95', () => {
    const samples: CalibrationSample[] = [];
    let i = 0;
    for (const [p, right, wrong] of [
      [0.5, 10, 10],
      [0.7, 20, 5],
      [0.85, 40, 2],
      [0.92, 60, 1],
      [0.97, 120, 1],
    ] as const) {
      samples.push(...many(right, p, true, i));
      i += right;
      samples.push(...many(wrong, p, false, i));
      i += wrong;
    }
    // From 0.92 up: 180 right of 182, lower bound 0.9608; from 0.85 up: 220 of 224, lower bound 0.9550... check both.
    const from85 = wilsonLowerBound(220, 224);
    const from70 = wilsonLowerBound(240, 249);
    assert.ok(from85 >= 0.95 && from70 < 0.95, `${from85} ${from70}`);
    assert.equal(thresholdOf(samples).threshold, 0.85);
  });
});

describe('masking command literals', () => {
  test('ASCII literals are masked as whole words, case-insensitive, longest first', () => {
    assert.equal(maskLiterals('Use System Reboot to restart; reboots differ. system-reboot', ['system reboot', 'reboot', 'system']), 'Use □ to restart; reboots differ. □-□');
  });
  test('non-ASCII literals are masked as substrings; empty literals are ignored', () => {
    assert.equal(maskLiterals('配置防火墙规则', ['防火墙', '', '  ']), '配置□规则');
  });
});
