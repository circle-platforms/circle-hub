import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readTemplate } from '../../../packs/skill/runner-workbook/functions/modules/workbook-writer/workbook-template.ts';
import { zipStore } from '../../../packs/skill/runner-workbook/functions/modules/workbook-writer/zip-store.ts';
import { parseProfile } from '../../../packs/workflow/case-compile/functions/profile.ts';
import { parseRuntimeContract } from '../../../packs/workflow/case-compile/functions/runtime-contract.ts';
import { bedsOf } from '../../../packs/workflow/case-compile/functions/test-support.ts';
import { profileDocument, runtimeDocument, signRuntime } from '../../../packs/workflow/case-compile/testing/runtime.ts';
import { rebindTemplate } from './template-identity.ts';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('rebinding changes the actual identity cells and preserves every other template member', () => {
  const original = runtimeDocument();
  const next = signRuntime({ ...original, atlas_snapshot: { fixture: true, revision: 2 } });
  const parsed = parseRuntimeContract(next); assert.ok(parsed.ok);
  const profile = profileDocument(original);
  const before = readTemplate(profile.workbook);
  const note = `<c r="D2" t="inlineStr"><is><t>${original.contract_sha256}</t></is></c>`;
  const cellMetadata = '<extLst><ext uri="synthetic-cell-metadata"/></extLst>';
  const worksheet = before.sheet.replace('<c r="D2" t="inlineStr"><is><t>说明文字</t></is></c>', note).replace(`${original.contract_sha256}</t></is></c>`, `${original.contract_sha256}</t></is>${cellMetadata}</c>`);
  const sourceBytes = zipStore(before.members.map(member => member.name === 'xl/worksheets/sheet1.xml' ? { name: member.name, bytes: Buffer.from(worksheet) } : member));
  profile.workbook.template = { sha256: digest(sourceBytes), xlsx_base64: Buffer.from(sourceBytes).toString('base64') };
  const source = structuredClone(profile.workbook.template);
  profile.runtime = { minimum_version: parsed.contract.runtimeVersion, contract_sha256: parsed.contract.pinned.identity };
  assert.notEqual(readTemplate(profile.workbook).identity[2], profile.runtime.contract_sha256);
  profile.workbook.template = rebindTemplate(profile.workbook, profile.runtime.minimum_version, profile.runtime.contract_sha256);
  const after = readTemplate(profile.workbook);
  assert.deepEqual(after.identity, [profile.workbook.identity_marker, profile.runtime.minimum_version, profile.runtime.contract_sha256]);
  assert.equal(profile.workbook.template.sha256, digest(Buffer.from(profile.workbook.template.xlsx_base64, 'base64')));
  assert.deepEqual(readTemplate({ ...profile.workbook, template: source }).members.filter(member => member.name !== 'xl/worksheets/sheet1.xml'), after.members.filter(member => member.name !== 'xl/worksheets/sheet1.xml'));
  assert.ok(after.sheet.includes(note), 'another cell with the old identity remains unchanged');
  assert.equal(after.sheet, worksheet.replace(original.contract_sha256, profile.runtime.contract_sha256));
  assert.equal(parseProfile(profile, parsed.contract, bedsOf()).ok, true);
});

test('rebinding escapes identity text without changing the template book or its notes', () => {
  const book = profileDocument().workbook;
  const source = structuredClone(book);
  const rebound = rebindTemplate(book, 'synthetic & next <runtime>', 'b'.repeat(64));
  const read = readTemplate({ ...book, template: rebound });
  assert.deepEqual(read.identity, [book.identity_marker, 'synthetic & next <runtime>', 'b'.repeat(64)]);
  assert.ok(read.sheet.includes('synthetic &amp; next &lt;runtime&gt;'));
  assert.deepEqual(book, source);
});

test('rebinding refuses corrupted source bytes instead of replacing an unverified template', () => {
  const book = profileDocument().workbook;
  const bad = { ...book, template: { ...book.template, sha256: 'f'.repeat(64) } };
  assert.throws(() => rebindTemplate(bad, 'synthetic-next', 'b'.repeat(64)), /摘要不符/);
});
