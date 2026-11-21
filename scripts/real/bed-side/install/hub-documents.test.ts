import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { interfaceDigest, parseRuntimeContract, runtimeDigest, stripAdditions } from '../../../../packs/workflow/case-compile/functions/runtime-contract.ts';
import { DOCUMENTS, hubDocuments } from './hub-documents.ts';

const example = (name: string): Buffer => readFileSync(new URL('../../../../packs/workflow/case-compile/examples/' + name, import.meta.url));
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const profile = example('runtime-profile-v2.json'), inventory = example('bed-topology.json');

// The two documents an install exports: the Hub's rule, declaring both identities of its original, and that original.
function exported(change: (rule: Record<string, any>) => void = () => {}): { contract: Buffer; original: Buffer } {
  const rule = JSON.parse(example('runtime-contract-v2.json').toString('utf8')) as Record<string, any>;
  change(rule);
  const recovered = stripAdditions(rule)!;
  recovered.contract_sha256 = runtimeDigest(recovered);
  const original = Buffer.from(JSON.stringify(recovered), 'utf8');
  rule.original = { contract_sha256: recovered.contract_sha256, interface_sha256: interfaceDigest(recovered), sha256: sha256(original) };
  rule.contract_sha256 = runtimeDigest(rule);
  return { contract: Buffer.from(JSON.stringify(rule), 'utf8'), original };
}
const served = exported();

test('a repair that changes a source and no declaration changes the two rule documents and nothing a workbook carries', () => {
  const next = exported((rule) => { rule.source_hashes = { ...rule.source_hashes, 'fixture/session.py': 'b'.repeat(64) }; });
  const rule = parseRuntimeContract(JSON.parse(next.contract.toString('utf8')));
  assert.ok(rule.ok, JSON.stringify(rule));
  const { files, report } = hubDocuments({ ...next, publishedContract: served.contract, profile, inventory });
  // The profile holds no identity: it is not written, and the two rule documents are the install's own bytes.
  assert.deepEqual(Object.keys(files), [DOCUMENTS.contract, DOCUMENTS.original]);
  assert.ok(files[DOCUMENTS.contract].equals(next.contract) && files[DOCUMENTS.original].equals(next.original));
  assert.equal(report.profile, 'unchanged');
  assert.notEqual(report.rule.from, report.rule.to);
  assert.notEqual(report.build_identity.from, report.build_identity.to);
  assert.equal(report.workbook_identity.from, report.workbook_identity.to);
  assert.equal(report.workbook_identity.to, rule.contract.pinned.identity);
  assert.equal(report.build_identity.to, rule.contract.pinned.build);
  assert.equal(report.compiled_workbooks_stay_valid, true);
  assert.deepEqual(report.sources_changed, ['fixture/session.py']);
  assert.equal(report.documents[DOCUMENTS.contract], sha256(next.contract));
});

test('a changed declaration is another workbook identity, and the report says compiled workbooks do not stay valid', () => {
  const next = exported((rule) => { rule.entries = rule.entries.map((entry: Record<string, any>, k: number) => k === 0 ? { ...entry, h_semantics: String(entry.h_semantics) + ' (changed)' } : entry); });
  const { report } = hubDocuments({ ...next, publishedContract: served.contract, profile, inventory });
  assert.notEqual(report.workbook_identity.from, report.workbook_identity.to);
  assert.equal(report.compiled_workbooks_stay_valid, false);
  assert.deepEqual(report.sources_changed, []);
});

test('a rule exported before the interface identity pins its whole digest, so a reinstall over it changes what a workbook carries', () => {
  const old = JSON.parse(served.contract.toString('utf8')) as Record<string, any>;
  delete old.original.interface_sha256;
  old.contract_sha256 = runtimeDigest(old);
  const before = parseRuntimeContract(old);
  assert.ok(before.ok && before.contract.pinned.identity === old.original.contract_sha256);
  const { report } = hubDocuments({ ...served, publishedContract: Buffer.from(JSON.stringify(old)), profile, inventory });
  assert.equal(report.workbook_identity.from, old.original.contract_sha256);
  assert.notEqual(report.workbook_identity.to, report.workbook_identity.from);
  assert.equal(report.build_identity.from, report.build_identity.to);
  assert.equal(report.compiled_workbooks_stay_valid, false);
});

test('a profile published before the digest field was retired is written once more without it, in its own layout', () => {
  const old = JSON.parse(profile.toString('utf8')) as Record<string, any>;
  old.runtime = { ...old.runtime, contract_sha256: 'd'.repeat(64) };
  const text = JSON.stringify(old, null, 2) + '\n';
  const { files, report } = hubDocuments({ ...served, publishedContract: served.contract, profile: Buffer.from(text), inventory });
  assert.equal(report.profile, 'retired_field_removed');
  assert.deepEqual(Object.keys(files), [DOCUMENTS.contract, DOCUMENTS.original, DOCUMENTS.profile]);
  const written = files[DOCUMENTS.profile].toString('utf8');
  assert.deepEqual(JSON.parse(written), JSON.parse(profile.toString('utf8')));
  assert.ok(written.endsWith('}\n') && written.includes('\n  "runtime": {\n'));
  assert.equal(report.documents[DOCUMENTS.profile], sha256(files[DOCUMENTS.profile]));
});

test('an original-format file that is not the one the new rule declares, a rule that does not pass and a profile that does not fit are refused before anything is written', () => {
  assert.throws(() => hubDocuments({ contract: served.contract, original: Buffer.from(served.original.toString('utf8') + ' '), publishedContract: served.contract, profile, inventory }), /不是新规则声明的那一份/);
  const broken = JSON.parse(served.contract.toString('utf8'));
  broken.contract_sha256 = 'c'.repeat(64);
  assert.throws(() => hubDocuments({ contract: Buffer.from(JSON.stringify(broken)), original: served.original, publishedContract: served.contract, profile, inventory }), /新的执行器规则没有通过核对/);
  const other = JSON.parse(profile.toString('utf8')) as Record<string, any>;
  other.runtime.minimum_version = 'another-runtime';
  assert.throws(() => hubDocuments({ ...served, publishedContract: served.contract, profile: Buffer.from(JSON.stringify(other)), inventory }), /运行环境配置配不上新的执行器规则/);
});
