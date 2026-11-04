import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { ExecutorSource, WriteDeclaration } from '../../../contracts/src/resources.ts';

// The D2 decision (group robot webhook, owner 2026-11-02) needs a notification executor. Today the contract refuses
// one: ExecutorDefinition locks calls.submit.write to effect_class=job, audience=null, writes_hub_records=true.
// testing/webhook-notify.draft.json is the intended shape; these tests pin the refusal so that when the contracts
// owner extends the schema, this test breaks LOUDLY and is updated deliberately (flip to safeParse success).

const draftPath = fileURLToPath(new URL('./testing/webhook-notify.draft.json', import.meta.url));
const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as {
  enabled: boolean; credential: string; endpoint: string; limitations: string[];
  calls: { submit: { write?: Record<string, unknown> } };
};

describe('the webhook notification executor draft (D2=a)', () => {
  test('is a draft, not a resource: disabled, example.invalid, secret named in caps, never registered', () => {
    assert.equal(draft.enabled, false);
    assert.match(draft.credential, /^\$\{secret:[A-Z][A-Z0-9_]{0,63}\}$/);
    assert.match(draft.endpoint, /^https:\/\/example\.invalid\//);
    assert.ok(draft.limitations.some((l) => l.includes('effect_class=job') || l.includes('锁为')) || draft.limitations.length >= 4, 'limitations record the gaps');
  });

  test('ExecutorSource refuses exactly the three job-lock fields and nothing else', () => {
    const result = ExecutorSource.safeParse(draft);
    assert.equal(result.success, false);
    const issues = result.success ? [] : result.error.issues;
    const paths = issues.map((i) => i.path.join('/')).sort();
    assert.deepEqual(paths, [
      'calls/submit/write/audience',
      'calls/submit/write/effect_class',
      'calls/submit/write/writes_hub_records',
    ], `expected only the job lock; got: ${JSON.stringify(issues.map((i) => ({ path: i.path.join('/'), message: i.message })))}`);
  });

  test('the same write declaration parses alone: the block is the executor slot, not the vocabulary', () => {
    const parsed = WriteDeclaration.safeParse(draft.calls.submit.write);
    assert.equal(parsed.success, true);
    assert.equal(draft.calls.submit.write?.effect_class, 'notification');
  });
});
