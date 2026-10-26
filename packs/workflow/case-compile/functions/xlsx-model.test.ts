import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkbookModel } from './xlsx-model.ts';
test('xlsx@1 structural model is accepted without parsing container bytes', () => {
  const model = { nulRemoved:0, members: [{ name: 'fixture.xml', size: 1, contentType: 'application/xml' }], relationships: [], sheets: [{ relationshipType:'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', name: 'Fixture', state: 'visible', part: 'fixture.xml', lastRow: 1, rows: [{ number: 1, hidden: false, cells: [{ reference: 'A1', type: 'inlineStr', text: 'fixture', formula: false, style: null }] }] }], sharedStrings: [], definedNames: [] };
  assert.equal(readWorkbookModel(model), model);
  assert.equal(readWorkbookModel({ ...model, sheets: [{ ...model.sheets[0], lastRow: -1 }] }), null);
  assert.equal(readWorkbookModel({ ...model, relationships: [{}] }), null);
  assert.equal(readWorkbookModel(new Uint8Array()), null);
});
