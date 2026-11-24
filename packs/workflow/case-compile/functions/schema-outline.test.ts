import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { schemaOutline, slotsOutline } from './schema-outline.ts';

test('fields are listed with type, required mark, values and the schema\'s own description; alternatives are named by what tells them apart', () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['kind', 'steps'],
    properties: {
      kind: { enum: ['flat', 'block'] },
      note: { type: 'string', minLength: 1, maxLength: 80, description: '一行说明' },
      wait: { type: 'integer', minimum: 1, maximum: 600 },
      steps: { type: 'array', minItems: 1, maxItems: 9, items: { anyOf: [
        { type: 'object', additionalProperties: false, required: ['kind', 'call'], properties: { kind: { const: 'SEND' }, call: { type: 'object', required: ['args'], properties: { args: { type: 'array', items: { type: 'string' } }, keywords: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] } } } } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'from'], properties: { kind: { const: 'PICK' }, from: { type: 'string', pattern: '^[a-z]+$' } } },
      ] } },
    },
  };
  assert.deepEqual(schemaOutline(schema, 'plan.data'), [
    'kind*: "flat" | "block"',
    'note: string（非空，至多 80 字符） — 一行说明',
    'wait: integer（1..600）',
    'steps*: 列表（至少 1 项，至多 9 项），每项：',
    '  下列之一',
    '    · kind="SEND"：对象：',
    '      kind*: 固定为 "SEND"',
    '      call*: 对象；可带其它键：',
    '        args*: 列表，每项 string',
    '        keywords: 对象；其余键的值：string | integer（0..）',
    '    · kind="PICK"：对象：',
    '      kind*: 固定为 "PICK"',
    '      from*: string（形如 /^[a-z]+$/）',
  ]);
});

test('a structure written out before is named where it comes again, not repeated', () => {
  const quote = { type: 'object', additionalProperties: false, required: ['reference', 'text'], properties: { reference: { type: 'string', minLength: 1, description: '引用的来源，形如 tree:<根>/<路径>@<条目>；由 Hub 逐字核对' }, text: { type: 'string', minLength: 1, description: '引用的原文，逐字' } } };
  const lines = schemaOutline({ type: 'object', properties: { first: { type: 'object', properties: { quote } }, second: { type: 'object', properties: { quote } } } }, 'data');
  assert.deepEqual(lines.filter((line) => line.includes('quote')), ['    quote: 对象：', '    quote: 同 data.first.quote']);
  assert.equal(lines.filter((line) => line.includes('引用的原文')).length, 1);
});

test('the outline the pack ships is the outline of the schema it ships, and is a fraction of its size', () => {
  const schema = readFileSync(new URL('../slots.schema.json', import.meta.url), 'utf8');
  const shipped = readFileSync(new URL('../tools/plan-fields.md', import.meta.url), 'utf8');
  assert.equal(shipped, slotsOutline(JSON.parse(schema)), 'regenerate tools/plan-fields.md from slots.schema.json (functions/schema-outline.ts slotsOutline)');
  assert.ok(shipped.length * 4 < schema.length, `${shipped.length} characters of outline for ${schema.length} of schema`);
  const names = new Set<string>(), descriptions = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node === null || typeof node !== 'object') return;
    const row = node as Record<string, unknown>;
    if (row.properties && typeof row.properties === 'object') for (const name of Object.keys(row.properties as object)) names.add(name);
    if (typeof row.description === 'string') descriptions.add(row.description.trim().replace(/\s+/g, ' '));
    Object.values(row).forEach(visit);
  };
  visit(JSON.parse(schema));
  for (const name of names) assert.ok(new RegExp(`(^|\\n)\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*?: `).test(shipped), `field ${name}`);
  for (const description of descriptions) assert.ok(shipped.includes(description), `description: ${description.slice(0, 40)}`);
});
