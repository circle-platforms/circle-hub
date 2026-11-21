import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertionCells, declaredLiteralMatching, type AssertionTarget } from './block-runtime.ts';
import { fixture } from '../testing/blocks.ts';

test('an expectation without an operator is matched the way the contract declares for the literal operator of the same method', () => {
  const { contract } = fixture();
  assert.equal(declaredLiteralMatching(contract, { object: 'check', method: 'found' }), 'escaped_literal');
  assert.equal(declaredLiteralMatching(contract, { object: 'check', method: 'abs_found' }), 'literal');
  assert.equal(declaredLiteralMatching(contract, { object: 'check', method: 'literal' }), 'literal');
  assert.equal(declaredLiteralMatching(contract, { object: 'elsewhere', method: 'found' }), 'literal');
});

test('the cell of an escaped literal matches the device line whatever its column padding, and reads a dot as a dot', () => {
  const target = { matching: 'escaped_literal' } as AssertionTarget;
  const cell = assertionCells({ text: 'Widget Name: w1', quote: { reference: 'src:synthetic', text: 'w1' }, after: 1 }, target).g;
  assert.equal(cell, 'Widget[ \\t]+Name:[ \\t]+w1');
  assert.ok(new RegExp(cell).test('Widget Name:                 w1                '));
  const dotted = assertionCells({ text: 'addr 192.0.2.7', quote: { reference: 'src:synthetic', text: 'x' }, after: 1 }, target).g;
  assert.ok(new RegExp(dotted).test('addr   192.0.2.7'));
  assert.equal(new RegExp(dotted).test('addr 192x0y2z7'), false, 'a dot is not any character');
  const raw = assertionCells({ text: 'Widget Name: w1', quote: { reference: 'src:synthetic', text: 'w1' }, after: 1 }, { matching: 'literal' } as AssertionTarget).g;
  assert.equal(new RegExp(raw).test('Widget Name:                 w1'), false);
});
