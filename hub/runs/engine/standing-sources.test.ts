// Standing obligations must revalidate current credential acceptance before giving bytes to pack functions.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { SourceArtifactBody } from '../../records/api.ts';
import { sha256Hex } from '../../records/api.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { createEngineContext } from './deps.ts';
import { evaluate } from './evaluate.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
const skip = await sandboxSkip();
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

test('a standing obligation loses function access when credential acceptance is withdrawn', { skip }, async t => {
  const h = await openHarness(postgres); t.after(() => h.close());
  const bytes = Buffer.from(`copy ftp://user:Ftp${randomBytes(8).toString('hex')}9@192.0.2.10/image.bin flash:`);
  const sha = sha256Hex(bytes);
  await h.kit.objects.put(bytes, 'text/plain');
  // An immutable original retained from a scanner that missed the synthetic example credential.
  const old: SourceArtifactBody = {
    sha256: sha, size: bytes.byteLength, media_type: 'text/plain', name: 'synthetic.txt',
    origin: { read: { object: 'synthetic:manual:one', resource: null, action: null } },
    author: { user: null, declared: null }, captured_at: '2026-10-01T00:00:00.000Z',
    provenance_type: 'observed', read_tier: 'model_readable',
    visibility: { readers: [], admins: true, packs: [], shareable: false },
    scan: { scanner: 'credential-scan@1', inspected: true, clean: true, findings: [], truncated: false },
  };
  await h.kit.store.put({ kind: 'source_artifact', schema: 'source_artifact@1', provenance: 'observed', body: old, index: [{ key: 'artifact.sha256', value: sha }] });
  await h.kit.artifacts.acceptFindings(h.admin, sha, '合成文档的虚构示例');
  await h.kit.artifacts.ingest({ bytes, mediaType: 'text/plain', origin: { read: { object: 'synthetic:manual:one' } }, author: { user: null }, provenanceType: 'observed', visibility: old.visibility });
  const map = await h.upload(h.admin, toyMap(standardDocument()));
  const started = await h.service.startHubRun(h.admin, { pack: 'toy-locate', inputs: { map: { reference: map } } }, h.call(null));
  assert.ok(started.answer.run);
  const run: RunRecord = structuredClone((await h.service.getRun(h.admin, started.answer.run.run))!.run);
  run.sources.push({ role: 'expected', reference: `src:${sha}`, media_type: 'text/plain' });
  const check = h.locate.checks.find(c => c.id === 'overview')!;
  check.reads = { roles: ['expected'] };
  check.function = { module: 'functions/effective-source.ts' };
  await writeFile(join(h.locate.pack.directory, check.function.module), `export default function(input) {
    const count = Object.keys(input.sources).filter(key => key === 'src:${sha}').length;
    return [{ verdict: count === 1 ? 'support' : 'unknown', ...(count === 1 ? {} : {reason: 'missing_input', missing: '合成来源 src:${sha} 的有效接受和可读原文；下一步：管理员恢复接受后重核'}), statement: count === 1 ? '来源可读' : '来源不可读', grounds: [], tier: 'advisory', data: { count, unread: input.unread_sources } }];
  }`);
  const runChecks = async () => {
    // A fresh context also simulates re-evaluation after a process restart.
    const ctx = createEngineContext({ records: h.kit, workflows: h.workflows, packs: h.packs, knowledge: h.knowledge, external: h.external });
    const result = await evaluate(ctx, { run, workflow: h.locate, submission: null, submissionDigest: 'a'.repeat(64), exact: null, carried: new Map(), roundsUsed: new Map(), origin: null, author: null, traceId: h.call().traceId });
    return result.result.cross_item.find(c => c.requirement === 'overview')!;
  };
  const accepted = await runChecks();
  assert.equal(accepted.statement.verdict, 'support', JSON.stringify(accepted));
  await h.kit.artifacts.revokeFindings(h.admin, sha, '撤回合成受理');
  assert.equal((await h.kit.artifacts.source(h.admin, sha, { consumer: 'function' }))?.bytes, null);
  const revoked = await runChecks();
  assert.equal(revoked.statement.verdict, 'unknown');
  assert.equal(revoked.statement.reason, 'missing_input');
  assert.equal(revoked.statement.data?.count, 0);
  assert.equal((revoked.statement.data?.unread as unknown[]).length, 1);
  const unread=(revoked.statement.data?.unread as Array<{reason:string;missing_fact:string;next_action:string}>)[0];
  assert.equal(unread.reason,'credential_unreadable');
  assert.match(unread.missing_fact,/管理员.*接受/);
  assert.match(unread.next_action,/请求管理员.*接受.*重新核验/);
  await h.kit.principals.createUser(h.admin, '合成备用管理员', 'admin');
  await h.kit.principals.setRole(h.admin, h.admin.id, 'user');
  const roles: string[] = [];
  const original = h.kit.artifacts.source.bind(h.kit.artifacts);
  t.mock.method(h.kit.artifacts, 'source', async (...args: Parameters<typeof original>) => { roles.push(args[0].role); return original(...args); });
  const demoted = await runChecks();
  assert.equal(demoted.statement.data?.count, 0);
  assert.ok(roles.length > 0);
  assert.ok(roles.every(role => role === 'user'), JSON.stringify(roles));
});
