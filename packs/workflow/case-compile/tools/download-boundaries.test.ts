import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallFailure, callFailureData } from '../functions/text.ts';
import { hubReplyFailure, parseHubOrigin } from '../functions/client-cli.ts';
import { HubReplyError } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main as fetchMain } from './fetch-run.ts';
import { main as downloadMain } from './download-run.ts';
import { main as returnsMain } from './download-returns.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
async function stderrOf(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  const chunks: string[] = [], saved = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), text: chunks.join('') }; } finally { process.stderr.write = saved; }
}

test('the CLI HTTP origin parser classifies only its declared URL grammar', () => {
  assert.equal(parseHubOrigin('https://example.invalid/mcp'), 'https://example.invalid');
  for (const value of ['permission denied network', 'file:///tmp/input', 'mailto:synthetic@example.invalid']) {
    assert.throws(() => parseHubOrigin(value), (error: unknown) => {
      assert.ok(error instanceof CallFailure); assert.equal(callFailureData(error).category, 'invalid_parameters');
      assert.equal(error.path, '/hub'); assert.ok(error.legal_form?.includes('--hub'));
      return true;
    });
  }
});

test('all download CLIs reject missing parameters and malformed Hub URLs before reading a token or fetching', async () => {
  for (const main of [fetchMain, downloadMain, returnsMain]) {
    let tokenReads = 0;
    const token = async () => { tokenReads++; throw new Error('the test must never read a token'); };
    const missing = await stderrOf(() => main([], token));
    assert.equal(missing.code, 1); assert.match(missing.text, /^参数无效：缺少必填参数 --hub/);
    const badHub = await stderrOf(() => main(['--hub', 'file:///tmp/poison', '--run', RUN, '--out', 'synthetic-uncreated-output'], token));
    assert.equal(badHub.code, 1); assert.match(badHub.text, /^参数无效：--hub 的协议不是 http 或 https/);
    assert.match(badHub.text, /合法写法：--hub/); assert.equal(tokenReads, 0);
  }
});

test('only the known HTTP reply class can declare an HTTP category', () => {
  for (const [status, category] of [[403, 'permission_denied'], [404, 'not_found'], [409, 'occupied'], [422, 'invalid_parameters'], [503, 'temporarily_unavailable']] as const) {
    assert.equal(hubReplyFailure(new HubReplyError(status, 'permission network not found poison prose'))?.category, category);
    assert.equal(hubReplyFailure(Object.assign(new Error('Hub response poison prose'), { status })), null);
  }
});

test('all download CLIs preserve an actual HTTP refusal category from their declared reply boundary', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'typed-download-http-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  const retry = { fetch: async () => new Response('synthetic forbidden response', { status: 403 }) };
  const args = ['--hub', 'https://example.invalid/mcp', '--run', RUN, '--out', join(scratch, 'out')];
  const token = async () => 'synthetic-token-1234';
  const outcomes = [
    await stderrOf(() => fetchMain(args, token, retry)),
    await stderrOf(() => downloadMain(args, token, async () => ({ briefs: 0 }), retry)),
    await stderrOf(() => returnsMain(args, token, { now: () => 0, pause: async () => {} }, retry)),
  ];
  for (const outcome of outcomes) { assert.equal(outcome.code, 1); assert.match(outcome.text, /^无权限：Hub 答复 403/); assert.doesNotMatch(outcome.text, /缺少结构化错误原因/); }
});

test('a missing records directory keeps its declared option, legal form and native cause', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'typed-records-path-')); t.after(() => rm(scratch, { recursive: true, force: true }));
  const { readSubmittedItemFiles } = await import('../functions/hub-retry.ts');
  await assert.rejects(readSubmittedItemFiles(join(scratch, 'missing'), { flag: 'records', itemKind: '用例重组记录', repairHint: '重新核对', validateItem: value => value as Record<string, unknown> }), (error: unknown) => {
    assert.ok(error instanceof CallFailure); assert.equal(error.category, 'not_found');
    assert.match(error.fact, /--records/); assert.match(error.legal_form!, /--records/);
    assert.ok(error.cause instanceof Error && 'code' in error.cause); assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
});
