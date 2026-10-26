import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NONE_OPTION, shouldDescend, topChoice } from './api.ts';
import type { JevAnswer } from './api.ts';

function choice(probabilities: Record<string, number>, picked?: string): JevAnswer {
  const top = picked ?? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: 'choice', choice: top, confidence: 0.5, probabilities };
}

describe('topChoice', () => {
  it('returns the most probable option, its probability, the margin and whether it is the none option', () => {
    const top = topChoice(choice({ a: 0.7, b: 0.2, none: 0.1 }));
    assert.equal(top.choice, 'a');
    assert.equal(top.p, 0.7);
    assert.ok(Math.abs(top.margin - 0.5) < 1e-12);
    assert.equal(top.isNone, false);
    assert.equal(topChoice(choice({ a: 0.1, none: 0.9 })).isNone, true);
    assert.equal(NONE_OPTION, 'none');
  });

  it('uses a custom none option', () => {
    assert.equal(topChoice(choice({ a: 0.1, 都不是: 0.9 }), { noneOption: '都不是' }).isNone, true);
    assert.equal(topChoice(choice({ a: 0.1, none: 0.9 }), { noneOption: '都不是' }).isNone, false);
  });

  it('treats a yes/no answer as the candidates true and false, with false as the none answer', () => {
    const yes = topChoice({ type: 'noul', noul: 0.8 });
    assert.equal(yes.choice, 'true');
    assert.equal(yes.p, 0.8);
    assert.ok(Math.abs(yes.margin - 0.6) < 1e-12);
    assert.equal(yes.isNone, false);
    const no = topChoice({ type: 'noul', noul: 0.1 });
    assert.equal(no.choice, 'false');
    assert.equal(no.isNone, true);
  });

  it('reads a score answer by its most probable level', () => {
    const top = topChoice({ type: 'score', score: 1.6, confidence: 0.4, legend: { 0: 'a', 1: 'b', 2: 'c' }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } });
    assert.equal(top.choice, '2');
    assert.equal(top.p, 0.7);
  });

  it('gives a margin of 0 on a tie and keeps the service pick', () => {
    const top = topChoice(choice({ a: 0.45, b: 0.45, none: 0.1 }, 'b'));
    assert.equal(top.choice, 'b');
    assert.equal(top.margin, 0);
  });

  it('gives NaN for non-finite or missing probabilities', () => {
    assert.ok(Number.isNaN(topChoice(choice({ a: Number.NaN, b: 0.5 }, 'b')).p));
    assert.ok(Number.isNaN(topChoice({ type: 'noul', noul: Number.NaN }).p));
    assert.ok(Number.isNaN(topChoice({ type: 'choice', choice: 'a', confidence: 1, probabilities: {} }).p));
  });
});

describe('shouldDescend', () => {
  it('descends when p is not below the threshold', () => {
    assert.equal(shouldDescend(choice({ a: 0.9, b: 0.05, none: 0.05 }), 0.9), true);
    assert.equal(shouldDescend(choice({ a: 0.95, b: 0.05 }), 0.9), true);
    assert.equal(shouldDescend(choice({ a: 0.6, b: 0.4 }), 0), true);
  });

  it('stays at the parent below the threshold', () => {
    assert.equal(shouldDescend(choice({ a: 0.8999, b: 0.0501, none: 0.05 }), 0.9), false);
  });

  it('stays at the parent when the none option wins, however probable', () => {
    assert.equal(shouldDescend(choice({ a: 0.01, none: 0.99 }), 0.5), false);
    assert.equal(shouldDescend(choice({ a: 0.01, 都不是: 0.99 }), 0.5, { noneOption: '都不是' }), false);
  });

  it('never descends on a tie', () => {
    assert.equal(shouldDescend(choice({ a: 0.5, b: 0.5 }), 0), false);
    assert.equal(shouldDescend(choice({ a: 0.45, b: 0.45, none: 0.1 }), 0.4), false);
    assert.equal(shouldDescend({ type: 'noul', noul: 0.5 }, 0), false);
  });

  it('never descends on NaN', () => {
    assert.equal(shouldDescend(choice({ a: Number.NaN, b: 0.1 }, 'a'), 0.5), false);
    assert.equal(shouldDescend({ type: 'noul', noul: Number.NaN }, 0.5), false);
    assert.equal(shouldDescend(choice({ a: 0.95, b: 0.05 }), Number.NaN), false);
  });

  it('never descends without a calibrated threshold or with an invalid one', () => {
    for (const threshold of [null, -0.1, 1.1, Number.POSITIVE_INFINITY]) {
      assert.equal(shouldDescend(choice({ a: 0.99, b: 0.01 }), threshold), false, String(threshold));
    }
  });

  it('descends on yes, never on no', () => {
    assert.equal(shouldDescend({ type: 'noul', noul: 0.95 }, 0.9), true);
    assert.equal(shouldDescend({ type: 'noul', noul: 0.05 }, 0.9), false);
  });
});
