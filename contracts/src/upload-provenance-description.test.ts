import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { TOOLS, UploadFileInput, UploadFileOutput } from './tools.ts';

const published = JSON.parse(readFileSync(new URL('../generated/tools.json', import.meta.url), 'utf8')) as Array<{ name: string; inputSchema: unknown; outputSchema: unknown }>;

function withoutDescriptions(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map(child => withoutDescriptions(child));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => propertyMap || key !== 'description').map(([key, child]) => [key,
      withoutDescriptions(child, !propertyMap && ['properties', '$defs', 'patternProperties', 'dependentSchemas'].includes(key)),
    ]));
  return value;
}

test('upload provenance explains workbook declarations and operation captures before the caller chooses a value', () => {
  const description = UploadFileInput.shape.provenance_type.description ?? '';
  assert.match(description, /declared \(or omit this field\).*uploaded workbooks/);
  assert.match(description, /model\/client operation records/);
  assert.match(description, /not merely.*generated or uploaded by a client/);
  assert.match(description, /declaration grade/);
  assert.match(description, /cannot be used as ordinary workflow inputs or as verification, scoring or release evidence/);
  const upload = TOOLS.find(tool => tool.name === 'upload_file')!;
  assert.match(upload.description, /workbooks.*declared.*client_captured/);
  assert.match(upload.description, /not ordinary workflow inputs/);
  assert.match(UploadFileOutput.shape.reference.description ?? '', /client_captured.*not ordinary workflow inputs/);
});

test('upload provenance keeps its optional values and does not upgrade declarations into observations', () => {
  const workbook = { file_path: Buffer.from('synthetic workbook bytes').toString('base64'), name: 'synthetic.xlsx' };
  assert.equal(UploadFileInput.parse(workbook).provenance_type, undefined);
  for (const provenance_type of ['declared', 'client_captured'] as const) {
    assert.equal(UploadFileInput.parse({ ...workbook, provenance_type }).provenance_type, provenance_type);
  }
  for (const provenance_type of ['observed', 'projected', 'candidate', 'DECLARED', ' client_captured']) {
    assert.equal(UploadFileInput.safeParse({ ...workbook, provenance_type }).success, false);
  }
});

test('E4 changes descriptions only across all six input and output schemas', () => {
  assert.deepEqual(TOOLS.map(tool => ({
    name: tool.name,
    inputSchema: withoutDescriptions(z.toJSONSchema(tool.input, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' })),
    outputSchema: withoutDescriptions(z.toJSONSchema(tool.output, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' })),
  })), published.map(tool => ({
    name: tool.name, inputSchema: withoutDescriptions(tool.inputSchema), outputSchema: withoutDescriptions(tool.outputSchema),
  })));
});
