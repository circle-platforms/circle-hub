import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { commandDomainPrecheck, collectCommandDomainObservations, type PrecheckInputs } from './command-domain-precheck.ts';
import { parseRuntimeContract, runtimeDigest } from './runtime-contract.ts';
import { CONTRACT_DOC, PROFILE_DOC, MANIFEST_DOC, COMMAND_CATALOG, goodData } from './test-support.ts';

const ROOT = 'f'.repeat(64), PROBE = `tree:${ROOT}/commands/inspect/widget`;
function fixture(): PrecheckInputs {
  const contract: Record<string, any> = structuredClone(CONTRACT_DOC);
  contract.cleanup = { source: 'fixture/cleanup-rules', sha256: 'c'.repeat(64), objects: ['widget-seat'], rules: [{ prefixes: ['widget health'], line: 7, probe: { command: 'inspect widget', reference: PROBE, read_only: true } }] };
  contract.contract_sha256 = runtimeDigest(contract);
  const catalog: any = structuredClone(COMMAND_CATALOG);
  catalog.policy.read_only = ['/commands/inspect'];
  const xml = 'b'.repeat(64);
  catalog.entries.push({ words: ['inspect', 'widget'], reference: PROBE, signatures: [{ id: `src:${xml}/xml@1/x/inspect`, reference: `src:${xml}/xml@1/x/inspect`, params: [] }] });
  return { root: ROOT, contract, profile: structuredClone(PROFILE_DOC), inventory: structuredClone(MANIFEST_DOC), catalog, plan: goodData() };
}

test('optional probe declarations preserve old contracts and reject undeclared shape or non-read-only claims', () => {
  assert.ok(parseRuntimeContract(CONTRACT_DOC).ok);
  assert.ok(parseRuntimeContract(fixture().contract).ok);
  for (const extra of [{ write: true }, { read_only: false }, { reference: 'free prose' }, { command: 'inspect widget\nother' }, { command: 'inspect\u001bwidget' }, { reference: `tree:${ROOT}/commands/inspect/widget@bad` }]) {
    const input = fixture(), contract = input.contract as any;
    Object.assign(contract.cleanup.rules[0].probe, extra); contract.contract_sha256 = runtimeDigest(contract);
    const parsed = parseRuntimeContract(contract); assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.ok(parsed.problems.some(p => p.pointer === '/cleanup'));
  }
});
test('precheck derives actual plan command identities and a declared query without deciding cleanliness', () => {
  const report = commandDomainPrecheck(fixture());
  assert.deepEqual(report.gaps, []); assert.equal(report.rows.length, 1, JSON.stringify(report));
  const row = report.rows[0]; assert.deepEqual(row.gaps, []); assert.equal(row.operation.identity?.path, '/commands/widget/health/interval');
  assert.equal(row.query?.reference, PROBE); assert.deepEqual(row.query?.identity.parameters, []); assert.equal(row.query?.identity.tree_root, 'b'.repeat(64), 'the command XML source identity remains distinct from the knowledge root');
  assert.equal(row.rule?.pinned, false); assert.equal(report.disclosure_only, true);
  assert.ok(!('verified' in report)); assert.ok(!('allowed' in report)); assert.ok(!('state' in row));
});
test('missing or mismatched mapping and incomplete catalog stay visible, not guessed from command words', () => {
  const missing = fixture(); delete (missing.contract as any).cleanup.rules[0].probe; (missing.contract as any).contract_sha256 = runtimeDigest(missing.contract as any);
  const noProbe = commandDomainPrecheck(missing); assert.equal(noProbe.rows[0].query, null); assert.ok(noProbe.rows[0].gaps.length);
  const wrong = fixture(); (wrong.contract as any).cleanup.rules[0].probe.reference = `tree:${ROOT}/commands/inspect/other`; (wrong.contract as any).contract_sha256 = runtimeDigest(wrong.contract as any);
  assert.equal(commandDomainPrecheck(wrong).rows[0].query, null);
  const notReadOnly = fixture(); (notReadOnly.catalog as any).policy.read_only = []; assert.equal(commandDomainPrecheck(notReadOnly).rows[0].query, null);
  const partial = fixture(); (partial.catalog as any).complete = false; assert.ok(commandDomainPrecheck(partial).gaps.some(g => g.pointer === '/catalog/complete'));
  const changedRoot = fixture(); changedRoot.root = 'a'.repeat(64); assert.equal(commandDomainPrecheck(changedRoot).rows.length, 0);
});
test('read failures, hash mismatch and truncation only add disclosure gaps; duplicate queries read once', async () => {
  const input = fixture(); (input.plan as any).steps.push(structuredClone((input.plan as any).steps[0]));
  const report = commandDomainPrecheck(input); const bytes = Buffer.from('synthetic observation'), hash = createHash('sha256').update(bytes).digest('hex');
  let calls = 0;
  const observed = await collectCommandDomainObservations(input, { read: async () => { calls++; return { reference: 'src:' + hash, sha256: hash, bytes, complete: true }; } });
  assert.equal(calls, 1); assert.equal(observed.rows.filter(r => r.observation).length, 2); assert.ok(observed.rows.every(r => !r.gaps.length));
  const truncated = await collectCommandDomainObservations(input, { read: async () => ({ reference: 'src:' + hash, sha256: hash, bytes, complete: false }) });
  assert.ok(truncated.rows.every(r => r.gaps.some(g => g.missing.includes('不完整'))));
  const wrong = await collectCommandDomainObservations(input, { read: async () => ({ reference: 'src:' + '0'.repeat(64), sha256: hash, bytes, complete: true }) });
  assert.ok(wrong.rows.every(r => !r.observation && r.gaps.length));
  const failed = await collectCommandDomainObservations(input, { read: () => { throw new Error('synthetic failure'); } });
  const malformed = await collectCommandDomainObservations(input, { read: async () => ({ reference: 'src:' + hash, sha256: hash, bytes, complete: 1 } as any) });
  assert.ok(malformed.rows.every(r => !r.observation && r.gaps.length));
  assert.ok(failed.rows.every(r => !r.observation && r.gaps.length)); assert.ok(!('verified' in failed));
  assert.deepEqual(report.rows.map(r => r.observation), [undefined, undefined]);
  let forgedReads = 0; const forged = structuredClone(report) as any; forged.rows[0].query.command = 'clear everything';
  const rejected = await collectCommandDomainObservations(forged, { read: async () => { forgedReads++; throw Error('must not read'); } });
  assert.equal(forgedReads, 0); assert.ok(rejected.gaps.length);
});

test('offline CLI writes a private disclosure even when mappings are missing and prints only counts/digest', async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { main } = await import('../tools/command-domain-precheck.ts');
  const directory = await mkdtemp(join(tmpdir(), 'cc-domain-precheck-'));
  try {
    const input = fixture(); delete (input.contract as any).cleanup.rules[0].probe; (input.contract as any).contract_sha256 = runtimeDigest(input.contract as any);
    await writeFile(join(directory, 'input.json'), JSON.stringify(input)); const lines: string[] = [];
    assert.equal(await main(['--input', 'input.json', '--out', 'report.json'], line => lines.push(line), directory), 0);
    const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')); assert.equal(report.disclosure_only, true); assert.equal(report.rows[0].query, null);
    assert.doesNotMatch(lines.join(''), /widget|inspect|fixture|command_domain|source:/); assert.equal(JSON.parse(lines[0]).missing, 1);
    assert.equal(await main(['--input', 'input.json', '--out', 'report.json'], () => {}, directory), 1, 'never overwrite');
    assert.equal(await main(['--input', 'input.json', '--out', '../escape.json'], () => {}, directory), 1);
    await writeFile(join(directory, 'broken.json'), Buffer.from([0xff]));
    const rejected: string[] = []; assert.equal(await main(['--input', 'broken.json', '--out', 'broken-report.json'], line => rejected.push(line), directory), 1);
    assert.match(rejected[0], /参数无效.*UTF-8 JSON/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
