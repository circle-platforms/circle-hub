// The table shapes of contracts/src/tables.ts: registered as name@major, closed, versioned, and described in JSON Schema.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { SCHEMA_REGISTRY } from '../../contracts/src/index.ts';
import { CatalogEntry, CheckOutcome, schemas, TABLE_SCHEMAS } from '../../contracts/src/tables.ts';
import { INTERPRETERS } from './interpreters/registry.ts';

describe('table shapes', () => {
  it('every table kind, the catalog entry and the check outcome are registered as name@major', () => {
    assert.deepEqual(Object.keys(schemas).sort(), [
      'catalog-entry@1',
      'catalog@1',
      'check-outcome@1',
      'coverage@1',
      'membership@1',
      'pattern@1',
      'quote@1',
      'range@1',
      'structure@1',
    ]);
    for (const key of Object.keys(schemas)) {
      assert.match(key, /^[a-z][a-z0-9_-]*@[0-9]+$/);
      assert.equal(SCHEMA_REGISTRY[key], schemas[key], `${key} reaches SCHEMA_REGISTRY`);
    }
  });

  it('each table kind has its interpreter, and its schema field names the version', () => {
    for (const [id, schema] of Object.entries(TABLE_SCHEMAS)) {
      assert.ok(INTERPRETERS.has(id), id);
      const js = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any' }) as unknown as {
        properties: { schema: { const?: string } };
        required: string[];
      };
      assert.equal(js.properties.schema.const, id);
      assert.ok(js.required.includes('schema') && js.required.includes('origin'), id);
    }
  });

  it('the generated JSON Schemas are closed, titled and described', () => {
    for (const [id, schema] of Object.entries(schemas)) {
      const js = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
      assert.equal(js.title, id);
      assert.ok(typeof js.description === 'string' && js.description.length > 20, id);
      assert.equal(js.additionalProperties, false, id);
      const text = JSON.stringify(js);
      assert.ok((text.match(/"description"/g) ?? []).length >= 5, `${id} describes its fields`);
    }
  });

  it('unknown keys are refused (closed schemas, C04 R[0])', () => {
    const entry = { words: ['a'], signatures: [], reference: `tree:${'e'.repeat(64)}/a` };
    assert.ok(CatalogEntry.safeParse(entry).success);
    assert.equal(CatalogEntry.safeParse({ ...entry, extra: 1 }).success, false);
    const outcome = { verdict: 'support', statement: '通过', grounds: [], tier: 'blocking' };
    assert.ok(CheckOutcome.safeParse(outcome).success);
    assert.equal(CheckOutcome.safeParse({ ...outcome, verdict: 'pass' }).success, false, 'verdicts come from the vocabulary');
    assert.equal(CheckOutcome.safeParse({ ...outcome, grounds: ['not a reference'] }).success, false);
  });
});
