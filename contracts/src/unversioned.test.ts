import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SyncPlanOutput, Producer, ProducerInput } from './product.ts';
import { TreeRootBody, RootPointerBody } from './knowledge.ts';
import { Locks } from './validation.ts';
const digest = 'a'.repeat(64);

test('unversioned producer declarations and inputs retain strict source validation', () => {
  assert.ok(SyncPlanOutput.safeParse({ fetch: [], builds: [], done: true, scope: { docs: ['store:document:synthetic'] } }).success);
  assert.equal(SyncPlanOutput.safeParse({ fetch: [], builds: [], done: true, scope: { docs: ['invalid'] } }).success, false);
  assert.ok(Producer.safeParse({ id: 'docs', title: '文档', function: { module: 'functions/docs.ts' }, inputs: {}, unversioned: true }).success);
  assert.ok(ProducerInput.safeParse({ slots: {}, params: {} }).success);
  assert.equal(ProducerInput.safeParse({ build: null, slots: {}, params: {} }).success, false);
});

test('unversioned roots and pointers explicitly omit build identity', () => {
  const root = { product: 'synthetic', version: null, build: null, root: digest, producer: { pack: 'synthetic', version: '1.0.0', digest, id: 'synthetic@1.0.0', producers: [] }, sources: [], composition: [], unplaced: [], refused: [], refused_count: 0, catalogs: [], counts: { nodes: 1, entries: 0, placed_by_model: 0, unplaced: 0 }, warnings: [], warnings_count: 0, produced_at: '2026-10-24T00:00:00.000Z' };
  assert.ok(TreeRootBody.safeParse(root).success);
  assert.equal(TreeRootBody.safeParse({ ...root, version: {} }).success, false);
  assert.ok(RootPointerBody.safeParse({ product: 'synthetic', line: null, pointer: 'knowledge/synthetic', expected: null, root: digest, build: null, composition: digest, move: digest, version: 1, cause: null }).success);
  assert.ok(Locks.shape.unversioned_root.safeParse(digest).success);
  assert.equal(Locks.shape.unversioned_root.safeParse('invalid').success, false);
});
