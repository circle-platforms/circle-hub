// (f) Protocol codes and core violation codes: unique, well-formed, with Chinese "when" and "fix" text, generated as registered.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CORE_VIOLATION_CODES, MODEL_VERSION, PROTOCOL_CODES, RECORD_KINDS } from '../generated/protocol.ts';

const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')) as {
  version: number;
  formatProposals: { protocolCodes: { code: string; when: string; fix: string }[]; recordKinds: string[] };
};
const codes = JSON.parse(readFileSync(new URL('../codes.json', import.meta.url), 'utf8')) as { codes: { code: string; interpreter: string; when: string; fix: string }[] };
const CJK = /[㐀-鿿]/;
const chinese = (text: string): boolean => text.trim().length > 0 && CJK.test(text);
const unique = (values: string[]): boolean => new Set(values).size === values.length;

test('protocol codes are unique UPPER_SNAKE_CASE and generated in model order', () => {
  const source = model.formatProposals.protocolCodes.map((c) => c.code);
  assert.ok(unique(source), 'no protocol code appears twice in contracts/model.json');
  assert.deepEqual(Object.keys(PROTOCOL_CODES), source);
  for (const code of source) assert.match(code, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
});

test('every protocol code has Chinese when and fix text', () => {
  for (const [code, entry] of Object.entries(PROTOCOL_CODES)) {
    assert.ok(chinese(entry.when), `${code} when`);
    assert.ok(chinese(entry.fix), `${code} fix`);
  }
});

test('the codes milestone 1 relies on are registered', () => {
  for (const code of ['SUBMISSION_SCHEMA_VIOLATION', 'REFERENCE_UNRESOLVED', 'REFERENCE_AMBIGUOUS', 'QUOTE_MISMATCH', 'SOURCE_UNAVAILABLE', 'IDEMPOTENCY_MISMATCH', 'RUN_SUPERSEDED', 'CREDENTIAL_IN_UPLOAD']) {
    assert.ok(code in PROTOCOL_CODES, code);
  }
  for (const code of ['core.structure.duplicate_key', 'core.structure.required_empty', 'core.structure.cardinality', 'core.catalog.not_member', 'core.catalog.membership_contradicted', 'core.catalog.param_out_of_range', 'core.catalog.param_type_mismatch', 'core.membership.not_in_set', 'core.range.out_of_bounds']) {
    assert.ok(code in CORE_VIOLATION_CODES, code);
  }
});

test('core violation codes are unique, live under core.<interpreter>. and name their interpreter', () => {
  const source = codes.codes.map((c) => c.code);
  assert.ok(unique(source), 'no core code appears twice in contracts/codes.json');
  assert.deepEqual(Object.keys(CORE_VIOLATION_CODES), source);
  for (const [code, entry] of Object.entries(CORE_VIOLATION_CODES)) {
    const m = /^core\.([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.exec(code);
    assert.ok(m, `${code} is core.<interpreter>.<name>`);
    assert.equal(entry.interpreter, m[1], `${code} names interpreter ${m[1]}`);
    assert.ok(chinese(entry.when), `${code} when`);
    assert.ok(chinese(entry.fix), `${code} fix`);
  }
});

test('protocol and core namespaces never overlap', () => {
  const protocol = new Set(Object.keys(PROTOCOL_CODES));
  for (const code of Object.keys(CORE_VIOLATION_CODES)) assert.ok(!protocol.has(code), code);
});

test('record kinds and the model version are generated from the model', () => {
  assert.deepEqual([...RECORD_KINDS], model.formatProposals.recordKinds);
  assert.ok(unique(model.formatProposals.recordKinds));
  assert.equal(MODEL_VERSION, model.version);
});
