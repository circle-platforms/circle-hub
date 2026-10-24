import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationFixture } from '../testing/workbook.ts';
import { checkContractShape } from './checks.ts';
import { GenerationError, generateWorkbook } from './generate.ts';
import { parseProfile } from './profile.ts';
import { contractCanonical, parseRuntimeContract, runtimeDigest, runtimeMethod, stripAdditions } from './runtime-contract.ts';
import { bedsOf, CONTRACT_DOC, goodData, PROFILE_DOC, subjectOf } from './test-support.ts';

function signed(typed: boolean) {
  const contractDoc = structuredClone(CONTRACT_DOC) as Record<string, any>;
  const configure = (contractDoc.entries as Array<Record<string, any>>).find((entry) => entry.f === 'configure')!;
  const signature = configure.signature as { parameters: unknown[]; optional: string[] };
  signature.parameters.push(
    { name: 'label', kind: 'positional_or_keyword', required: false, default: null },
    { name: 'note', kind: 'positional_or_keyword', required: false, default: null },
  );
  signature.optional = [...signature.optional, 'label', 'note'];
  if (typed) {
    configure.typed_authority.parameters.label = { type: 'text', role: 'device_cli' };
    configure.typed_authority.parameters.note = { type: 'text', role: 'device_cli' };
  }
  const recovered = stripAdditions(contractDoc)!;
  const recoveredDigest = runtimeDigest(recovered);
  contractDoc.original = { contract_sha256: recoveredDigest, sha256: createHash('sha256').update(Buffer.from(contractCanonical(recovered), 'utf8')).digest('hex') };
  delete contractDoc.contract_sha256;
  contractDoc.contract_sha256 = runtimeDigest(contractDoc);
  const profileDoc = structuredClone(PROFILE_DOC) as Record<string, any>;
  const allowed = (profileDoc.allowed as Array<Record<string, unknown>>).find((call) => call.method === 'configure')!;
  allowed.unsupplied = ['label', 'note'];
  profileDoc.runtime.contract_sha256 = contractDoc.original.contract_sha256;
  return { contractDoc, profileDoc };
}

test('two unsupplied optional parameters are authorized without types and a plan that writes them is refused', () => {
  const { contractDoc, profileDoc } = signed(false);
  const parsed = parseRuntimeContract(contractDoc);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.equal(runtimeMethod(parsed.contract, 'widget-seat', 'configure')?.authority, null);
  const profile = parseProfile(profileDoc, parsed.contract, bedsOf());
  assert.equal(profile.ok, true, JSON.stringify(profile));
  if (!profile.ok) return;
  const authority = runtimeMethod(parsed.contract, 'widget-seat', 'configure')?.authority;
  assert.ok(authority);
  assert.equal(Object.hasOwn(authority.parameters, 'label'), false);
  assert.equal(Object.hasOwn(authority.parameters, 'note'), false);
  assert.ok(authority.parameters.line);
  const open = checkContractShape(subjectOf(goodData(), { contractDoc, profileDoc }));
  assert.equal(open[0]?.verdict, 'support', JSON.stringify(open));
  const written = goodData();
  written.steps[0].keywords = { label: 'synthetic-label', note: 'synthetic-note' };
  const refused = checkContractShape(subjectOf(written, { contractDoc, profileDoc }));
  assert.equal(refused[0]?.verdict, 'refute', JSON.stringify(refused));
  assert.match(refused[0]?.statement ?? '', /永不传入/);
  assert.match(refused[0]?.statement ?? '', /label/);
  assert.match(refused[0]?.statement ?? '', /note/);
  const recipe = generationFixture();
  assert.throws(() => generateWorkbook({ ...recipe, slots: written, contract: parsed.contract, profile: profile.profile }), (error: unknown) => error instanceof GenerationError && /永不传入/.test(error.message) && /label/.test(error.message) && /note/.test(error.message));
  const required = structuredClone(profileDoc);
  (required.allowed as Array<Record<string, unknown>>).find((call) => call.method === 'configure')!.unsupplied = ['line', 'label'];
  const again = parseRuntimeContract(contractDoc);
  assert.ok(again.ok);
  if (!again.ok) return;
  const bad = parseProfile(required, again.contract, bedsOf());
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.problems.some((problem) => problem.pointer.endsWith('/unsupplied')));
});

test('a typed authority that still names the unsupplied parameters is accepted', () => {
  const { contractDoc, profileDoc } = signed(true);
  const parsed = parseRuntimeContract(contractDoc);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.ok(runtimeMethod(parsed.contract, 'widget-seat', 'configure')?.authority?.parameters.label);
  assert.ok(runtimeMethod(parsed.contract, 'widget-seat', 'configure')?.authority?.parameters.note);
  const profile = parseProfile(profileDoc, parsed.contract, bedsOf());
  assert.equal(profile.ok, true, JSON.stringify(profile));
  const authority = runtimeMethod(parsed.contract, 'widget-seat', 'configure')?.authority;
  assert.ok(authority?.parameters.label && authority.parameters.note);
  const written = goodData();
  written.steps[0].keywords = { label: 'synthetic-label', note: 'synthetic-note' };
  const refused = checkContractShape(subjectOf(written, { contractDoc, profileDoc }));
  assert.equal(refused[0]?.verdict, 'refute', JSON.stringify(refused));
  assert.match(refused[0]?.statement ?? '', /永不传入/);
});
