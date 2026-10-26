// (h) The published record schemas (schemas/*.json) accept what zod accepts and stay closed; every format they and tools.json
// declare is a JSON Schema 2020-12 format; the SDK's Ajv validator compiles all of them without a warning.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { accepted, claim, copy, H, hubRun, judgment, notAccepted, packSummary, runRecord, submission, summary } from './fixtures.ts';
import { SCHEMA_REGISTRY } from './index.ts';

type JsonSchema = Parameters<AjvJsonSchemaValidator['getValidator']>[0];
const generated = new URL('../generated/', import.meta.url);
const schemaFile = (name: string): JsonSchema => JSON.parse(readFileSync(new URL(`schemas/${name}`, generated), 'utf8')) as JsonSchema;
const record = { id: 'rcd_01jacd5z8q3w7v9h2k4m6n8p0t', kind: 'validation_result', schema: 'validation@1', digest: H, provenance: 'observed', created_at: '2026-10-21T08:00:00Z', body: accepted };

/** Registered shape -> synthetic bodies it accepts. */
const EXAMPLES: Record<string, unknown[]> = {
  'claim@1': [claim, judgment],
  'submission@1': [submission],
  'submission-received@1': [{ run: 'run_123', items: 'x' }],
  'validation@1': [accepted, notAccepted],
  'run-summary@1': [summary],
  'run@1': [runRecord, hubRun],
  'pack-summary@1': [packSummary],
  'record@1': [record],
};

/** The formats JSON Schema 2020-12 defines (Validation vocabulary, section 7.3). */
const FORMATS = new Set([
  'date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname', 'idn-hostname', 'ipv4', 'ipv6',
  'uri', 'uri-reference', 'iri', 'iri-reference', 'uuid', 'uri-template', 'json-pointer', 'relative-json-pointer', 'regex',
]);

function everySchema(): [string, JsonSchema][] {
  const tools = JSON.parse(readFileSync(new URL('tools.json', generated), 'utf8')) as { name: string; inputSchema: JsonSchema; outputSchema: JsonSchema }[];
  const records = readdirSync(new URL('schemas/', generated)).filter((f) => f.endsWith('.schema.json')).map((f): [string, JsonSchema] => [f, schemaFile(f)]);
  return [...tools.flatMap((t): [string, JsonSchema][] => [[`${t.name} input`, t.inputSchema], [`${t.name} output`, t.outputSchema]]), ...records];
}

test('every registered record body that zod accepts passes the published schema', () => {
  const ajv = new AjvJsonSchemaValidator();
  for (const [id, bodies] of Object.entries(EXAMPLES)) {
    const [name, major] = id.split('@');
    const check = ajv.getValidator(schemaFile(`${name}.v${major}.schema.json`));
    for (const body of bodies) {
      assert.equal(SCHEMA_REGISTRY[id].safeParse(copy(body)).success, true, `zod accepts a ${id} body`);
      const result = check(copy(body));
      assert.ok(result.valid, `${id}: ${result.errorMessage}`);
    }
  }
});

test('the published record schemas are closed: an unknown key is refused there too', () => {
  const ajv = new AjvJsonSchemaValidator();
  for (const [id, body] of [
    ['claim@1', { ...claim, ground: [] }],
    ['validation@1', { ...accepted, items: [] }],
    ['run@1', { ...runRecord, phase: 'running' }],
    ['record@1', { ...record, size: 1 }],
  ] as const) {
    const [name, major] = id.split('@');
    assert.equal(SCHEMA_REGISTRY[id].safeParse(body).success, false, `zod refuses an unknown key in ${id}`);
    assert.equal(ajv.getValidator(schemaFile(`${name}.v${major}.schema.json`))(body).valid, false, `the published ${id} refuses it`);
  }
});

test('every format the generated schemas declare is a JSON Schema 2020-12 format', () => {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${at}[${i}]`));
    else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'format' && typeof value === 'string' && !FORMATS.has(value)) found.push(`${at}: format ${value}`);
        else walk(value, `${at}.${key}`);
      }
    }
  };
  for (const [name, schema] of everySchema()) walk(schema, name);
  assert.deepEqual(found, []);
});

test('the SDK validator compiles every published schema without a warning', () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  try {
    const ajv = new AjvJsonSchemaValidator();
    for (const [, schema] of everySchema()) ajv.getValidator(schema);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(warnings, []);
});
