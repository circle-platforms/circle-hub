import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockReviewIdentity, blockReviewSources } from './block-review-identity.ts';
test('public source bindings and private immutable peer metadata identify exactly the same proof', () => { const a = 'a'.repeat(64), b = 'b'.repeat(64), privateView = { run: { external: null, meta: { record: a }, model: { body: { private: 'kept' } } }, result: { meta: { record: b }, model: { body: { private: 'kept' } } } }; assert.deepEqual(blockReviewIdentity(privateView), blockReviewSources([{ slot: 'criteria_review_run', reference: 'rec:' + a }, { slot: 'criteria_review', reference: 'rec:' + b }])); assert.equal(blockReviewIdentity({ run: 'rec:' + a }), null); assert.equal(blockReviewSources([]), null); });
