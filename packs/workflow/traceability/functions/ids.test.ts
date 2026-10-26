// The id normalisation (digits only): pure digit runs compare without leading zeros, everything else compares exactly.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeId } from './ids.ts';

describe('normalizeId', () => {
  it('keeps a digit id without leading zeros as it is', () => {
    assert.equal(normalizeId('74001'), '74001');
    assert.equal(normalizeId('0'), '0');
  });

  it('strips leading zeros of a digit id', () => {
    assert.equal(normalizeId('0074001'), '74001');
    assert.equal(normalizeId('090'), '90');
    assert.equal(normalizeId('000'), '0');
    assert.equal(normalizeId('0000'), '0');
  });

  it('keeps anything that is not a pure digit run exactly as written', () => {
    assert.equal(normalizeId('74001a'), '74001a');
    assert.equal(normalizeId('0071a'), '0071a');
    assert.equal(normalizeId('７４００１'), '７４００１');
    assert.equal(normalizeId(''), '');
    assert.equal(normalizeId(' 74001'), ' 74001');
  });

  it('makes the same number with and without leading zeros the same key, and different numbers different keys', () => {
    assert.equal(normalizeId('0071'), normalizeId('71'));
    assert.notEqual(normalizeId('0071'), normalizeId('710'));
  });
});
