// (e) contracts/generated/tools.json: exactly the six tools, titled and described for models in English, JSON Schema 2020-12,
// file_path declared as base64 content, annotations derived by annotationsFor. Also checks every generated schema file.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MAX_UPLOAD_BASE64_LENGTH, MAX_UPLOAD_BYTES, TOOLS } from './tools.ts';

type Schema = Record<string, unknown>;
type ToolJson = { name: string; title: string; description: string; inputSchema: Schema; outputSchema: Schema; annotations: Record<string, boolean> };

const generated = new URL('../generated/', import.meta.url);
const tools = JSON.parse(readFileSync(new URL('tools.json', generated), 'utf8')) as ToolJson[];
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const CJK = /[㐀-鿿]/;

/** Keywords of JSON Schema 2020-12 that the generator may emit; anything else (definitions, dependencies, array items) is a different draft. */
const KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'type', 'enum', 'const', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'then', 'else',
  'properties', 'required', 'additionalProperties', 'propertyNames', 'patternProperties', 'minProperties', 'maxProperties',
  'items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains',
  'minLength', 'maxLength', 'pattern', 'format', 'contentEncoding', 'contentMediaType',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);
const SUBSCHEMA_MAPS = new Set(['properties', '$defs', 'patternProperties']);
const SUBSCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

/** Walks a schema and returns every problem: unknown keywords, draft-07 forms, nested $schema, CJK in model-facing text. */
function audit(schema: unknown, at: string, root = true): string[] {
  if (typeof schema === 'boolean') return [];
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [`${at}: not a schema`];
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) out.push(`${at}: keyword ${key} is not JSON Schema 2020-12`);
    if (key === '$schema' && !root) out.push(`${at}: nested $schema`);
    if (key === 'items' && Array.isArray(value)) out.push(`${at}: items as an array is draft 7; use prefixItems`);
    if ((key === 'description' || key === 'title') && typeof value === 'string' && CJK.test(value)) out.push(`${at}: ${key} must be English for models`);
    if (SUBSCHEMA_MAPS.has(key)) for (const [name, sub] of Object.entries(value as Schema)) out.push(...audit(sub, `${at}.${key}.${name}`, false));
    else if (SUBSCHEMA_LISTS.has(key)) (value as unknown[]).forEach((sub, i) => out.push(...audit(sub, `${at}.${key}[${i}]`, false)));
    else if (['items', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else', 'contains'].includes(key)) out.push(...audit(value, `${at}.${key}`, false));
    if (key === '$ref' && typeof value === 'string' && !value.startsWith('#/$defs/')) out.push(`${at}: $ref ${value} leaves the document`);
  }
  return out;
}

test('tools.json lists exactly the six tools, in the order of TOOLS', () => {
  assert.deepEqual(
    tools.map((t) => t.name),
    ['list_task_packs', 'upload_file', 'start_run', 'get_nodes', 'resolve_reference', 'submit_result'],
  );
  assert.deepEqual(
    tools.map((t) => t.name),
    TOOLS.map((t) => t.name),
  );
});

test('every tool has an English title and description', () => {
  for (const t of tools) {
    assert.ok(t.title.trim().length > 0 && t.description.trim().length > 0, t.name);
    assert.ok(!CJK.test(t.title) && !CJK.test(t.description), `${t.name} title and description are English`);
    assert.match(t.name, /^[a-z]+(?:_[a-z]+)+$/, 'tool names are snake_case verbs (display rule 15)');
  }
});

test('input and output schemas are JSON Schema 2020-12 objects with English descriptions', () => {
  for (const t of tools) {
    for (const [kind, schema] of [['inputSchema', t.inputSchema], ['outputSchema', t.outputSchema]] as const) {
      assert.equal(schema.$schema, DRAFT, `${t.name} ${kind} declares 2020-12`);
      assert.equal(schema.type, 'object', `${t.name} ${kind} is an object (MCP)`);
      assert.deepEqual(audit(schema, `${t.name}.${kind}`), []);
    }
  }
});

test('published patterns use no lookaround and no Unicode property escapes, so MCP clients can translate them', () => {
  const patterns: string[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(collect);
    else if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'pattern' && typeof value === 'string') patterns.push(value);
        else collect(value);
      }
    }
  };
  collect(tools);
  for (const file of readdirSync(new URL('schemas/', generated)).filter((f) => f.endsWith('.schema.json'))) {
    collect(JSON.parse(readFileSync(new URL(`schemas/${file}`, generated), 'utf8')));
  }
  assert.ok(patterns.length > 0);
  for (const p of patterns) {
    assert.doesNotMatch(p, /\(\?<?[=!]/, p);
    assert.doesNotMatch(p, /\\[pP]\{/, `no \\p{} in ${p.slice(0, 80)}`);
  }
});

test('upload_file takes the file as base64 content in file_path', () => {
  const upload = tools.find((t) => t.name === 'upload_file');
  const filePath = (upload?.inputSchema.properties as Record<string, Schema>).file_path;
  assert.equal(filePath.type, 'string');
  assert.equal(filePath.contentEncoding, 'base64');
  assert.equal(filePath.contentMediaType, 'application/octet-stream');
  assert.equal(filePath.format, undefined, 'no format: JSON Schema 2020-12 defines none for base64');
  assert.equal(filePath.pattern, '^[A-Za-z0-9+/]*={0,2}$');
  assert.equal(filePath.maxLength, MAX_UPLOAD_BASE64_LENGTH);
  assert.equal(MAX_UPLOAD_BASE64_LENGTH, 4 * Math.ceil(MAX_UPLOAD_BYTES / 3));
  assert.deepEqual(upload?.inputSchema.required, ['file_path']);
});

test('start_run parameters tells the model where the pack parameters go', () => {
  const start = tools.find((t) => t.name === 'start_run');
  const properties = start?.inputSchema.properties as Schema;
  const parameters = properties.parameters as Schema;
  assert.ok(parameters, 'start_run input has parameters');
  assert.equal(typeof parameters.description, 'string', 'parameters has a description for the model');
  const description = parameters.description as string;
  assert.ok(!CJK.test(description), 'the description is English');
  assert.match(description, /list_task_packs/, 'it names the place that lists the parameters');
  assert.match(description, /\{.*</, 'it shows the object-by-name shape');
});

test('annotations in tools.json are exactly the D06 table, with start_run open-world as milestone-1 callers see it', () => {
  // Literal values from D06 F[0]-F[5], not a second call of annotationsFor.
  const D06: Record<string, Record<string, boolean>> = {
    list_task_packs: { readOnlyHint: true, openWorldHint: false },
    upload_file: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    start_run: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    get_nodes: { readOnlyHint: true, openWorldHint: false },
    resolve_reference: { readOnlyHint: true, openWorldHint: false },
    submit_result: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  assert.deepEqual(Object.fromEntries(tools.map((t) => [t.name, t.annotations])), D06);
});

test('the output schemas carry the uniform response fields (D05)', () => {
  for (const t of tools) {
    const properties = t.outputSchema.properties as Schema;
    for (const field of ['call_result', 'errors', 'trace']) assert.ok(field in properties, `${t.name} output has ${field}`);
    assert.ok((t.outputSchema.required as string[]).includes('errors'));
  }
  for (const name of ['upload_file', 'submit_result']) {
    const t = tools.find((x) => x.name === name);
    assert.ok((t?.outputSchema.required as string[]).includes('acceptance'), `${name} always carries a receipt`);
  }
});

test('every generated record and pack-file schema is JSON Schema 2020-12', () => {
  const dir = new URL('schemas/', generated);
  const files = readdirSync(dir).filter((f) => f.endsWith('.schema.json'));
  assert.ok(files.length >= 7);
  for (const file of files) {
    assert.match(file, /^[a-z][a-z0-9_-]*\.v[0-9]+\.schema\.json$/);
    const schema = JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as Schema;
    assert.equal(schema.$schema, DRAFT, file);
    assert.deepEqual(audit(schema, file).filter((p) => !p.includes('must be English')), [], file);
  }
});
