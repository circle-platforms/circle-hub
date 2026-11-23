import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseJevJson, validateJevRequest } from './functions/modules/jev-client/index.ts';
import type { JevRequest } from './functions/modules/jev-client/index.ts';

const EXAMPLES = new URL('./examples/', import.meta.url);

const examples = readdirSync(EXAMPLES)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((name) => ({ name, text: readFileSync(new URL(name, EXAMPLES), 'utf8') }));

describe('the request examples', () => {
  it('are four, one for each way the skill describes a question', () => {
    assert.deepEqual(examples.map(({ name }) => name), ['choice-command-select.json', 'choice-step-fidelity.json', 'noul-command-match.json', 'score-command-list.json']);
  });

  it('cover the three question types', () => {
    const types = new Set<string>();
    for (const { text } of examples) {
      const parsed = parseJevJson(text);
      assert.ok(parsed.ok);
      for (const question of Object.values((parsed.value as JevRequest).questions)) types.add(question.type);
    }
    assert.deepEqual([...types].sort(), ['choice', 'noul', 'score']);
  });

  for (const { name, text } of examples) {
    it(`${name} is plain JSON with the fields of a request and nothing else, and passes the check made before sending`, () => {
      const parsed = parseJevJson(text);
      assert.ok(parsed.ok, name);
      const body = parsed.value as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).filter((field) => !['state', 'questions', 'model'].includes(field)), [], name);
      const checked = validateJevRequest(body as unknown as JevRequest);
      assert.ok(checked.types.length >= 1, name);
    });

    it(`${name} holds no credential, address, account or local path`, () => {
      assert.doesNotMatch(text, /\bBearer\b|api[_-]?key|token|secret|password|passwd/iu, name);
      assert.doesNotMatch(text, /https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\/Users\/|\/home\/|[A-Za-z]:\\/u, name);
      assert.doesNotMatch(text, /@[A-Za-z0-9-]+\.[A-Za-z]{2,}/u, name);
    });
  }
});
