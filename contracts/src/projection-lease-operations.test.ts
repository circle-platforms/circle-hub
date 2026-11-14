import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaseOpSchema } from '../generated/vocabulary.ts';
import { ProjectionOutput } from './pack.ts';

test('new projection lease requests cannot recreate a separate prefix registration catalog', () => {
  for (const request of [{ op: 'register', prefix: 'synthetic/bed/' }, { op: 'unregister', prefix: 'synthetic/bed/', reason: '合成撤回' }]) {
    assert.equal(ProjectionOutput.safeParse({ items: [], warnings: [], lease_requests: [request] }).success, false);
    assert.equal(LeaseOpSchema.safeParse(request.op).success, true, 'old action vocabulary remains readable; only new projection capability is removed');
  }
});

test('acquire, extend, release and reasoned force release retain their strict shapes', () => {
  for (const request of [
    { keys: ['synthetic/bed/a'] }, { op: 'acquire', keys: ['synthetic/bed/a'], ttl_seconds: 60 },
    { op: 'extend', keys: ['synthetic/bed/a'], ttl_seconds: 60 },
    { op: 'release', keys: ['synthetic/bed/a'] },
    { op: 'force_release', keys: ['synthetic/bed/a'], reason: '合成强释理由' },
  ]) assert.equal(ProjectionOutput.safeParse({ items: [], warnings: [], lease_requests: [request] }).success, true);
  for (const request of [
    { op: 'extend', keys: ['synthetic/bed/a'] }, { op: 'force_release', keys: ['synthetic/bed/a'], reason: '  ' },
    { op: 'acquire', keys: [] }, { op: 'release', keys: ['synthetic/bed/a'], owner: 'fabricated' },
  ]) assert.equal(ProjectionOutput.safeParse({ items: [], warnings: [], lease_requests: [request] }).success, false);
});
