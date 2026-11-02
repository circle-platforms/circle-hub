// Acceptance: the pack list and the start_run answer disclose the pack digest and the tools/ files of a pack that ships
// them (script-distribution, step 2), with one install command pinned to id@version and digest; the same digest pins a
// real /local-tools download that the local-tools CLI installs and verifies byte for byte. A pack without tools/ says
// nothing. Synthetic pack and fixtures only; no token appears anywhere it is read back.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '../../hub/records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { localToolsCommand } from '../../hub/server/cli-local-tools.ts';
import { withFiles, workflowPack, writePack, type WrittenPack } from '../../hub/runs/packs/testing/builder.ts';
import { openBed, bedPacks, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

const PACK = 'demo-local-tools';
const TOOL_A = 'import { readFile } from "node:fs/promises";\nvoid readFile;\n';
const TOOL_B = 'export {};\n';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let scratch: string;
let installed: string;
let published: { digest: string; version: string };

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, repositoryPacks: await bedPacks() });
  scratch = await mkdtemp(join(tmpdir(), 'circle-hub-local-tools-'));
  installed = join(scratch, 'skills');
  const described = withFiles(workflowPack({ id: PACK, title: '合成本地工具披露' }), {
    'tools/fetch-run.ts': TOOL_A,
    'tools/generate-workbook.ts': TOOL_B,
  });
  const written: WrittenPack = await writePack(scratch, described);
  const info = await bed.hub.publishPack(written.dir);
  published = { digest: info.digest, version: info.version };
  await bed.hub.assignPack(bed.reviewer.principal, PACK);
  client = await bed.connect(bed.reviewer, 'demo-local-tools');
});

after(async () => {
  await client?.close();
  await bed?.close();
  await postgres?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line: string) => void out.push(line), stderr: (line: string) => void err.push(line), env: {}, cwd: scratch };
};

test('list_task_packs discloses the digest and the tools/ files with one install command, only for packs that ship tools', async () => {
  const answer = await client.call('list_task_packs', {});
  assert.equal(answer.isError, false);
  const mine = answer.out.packs.find((p) => p.id === PACK);
  assert.ok(mine, 'the synthetic pack is listed');
  assert.equal(mine.digest, published.digest);
  assert.equal(mine.local_tools?.count, 2);
  assert.deepEqual(mine.local_tools?.files, [
    { path: 'tools/fetch-run.ts', sha256: sha256Hex(TOOL_A), size: Buffer.byteLength(TOOL_A) },
    { path: 'tools/generate-workbook.ts', sha256: sha256Hex(TOOL_B), size: Buffer.byteLength(TOOL_B) },
  ]);
  assert.equal(mine.local_tools?.install, `circle-hub local-tools install ${PACK}@${published.version} --digest ${published.digest} --into <目录>`);
  assert.ok(answer.text.includes(`本地工具 2 个；安装：circle-hub local-tools install ${PACK}@${published.version} --digest ${published.digest} --into <目录>`), answer.text);
  const withTools = answer.out.packs.filter((p) => p.local_tools !== undefined);
  assert.ok(withTools.some((p) => p.id === PACK));
  const lines = answer.text.split('\n').filter((l) => /^\s+本地工具 \d+ 个；安装：/.test(l));
  const lineIds = lines.map((l) => /local-tools install (\S+)@/.exec(l)?.[1]).sort();
  assert.deepEqual(lineIds, withTools.map((p) => p.id).sort(), 'one install line per pack that ships tools, and none for the others');
  assert.equal(new Set(lineIds).size, lineIds.length, 'no pack carries the line twice');
});

test('start_run repeats the disclosure for the very version the run froze', async () => {
  const subject = await client.upload(new TextEncoder().encode('{"synthetic":true}\n'), 'subject.json', 'application/json');
  const started = await client.call('start_run', { pack: PACK, product: bed.product.names[0], inputs: { target: { reference: subject } } });
  assert.equal(started.isError, false);
  assert.equal(started.out.run?.pack, `${PACK}@${published.version}`);
  assert.ok('local_tools' in (started.raw.structuredContent as Record<string, unknown>), 'the raw answer carries local_tools');
  assert.equal(started.out.local_tools?.count, 2);
  assert.equal(
    started.out.local_tools?.install,
    `circle-hub local-tools install ${PACK}@${published.version} --digest ${published.digest} --into <目录>`,
  );
  assert.ok(
    started.text.includes(`本地工具 2 个（客户端按包号核对后安装）；安装：circle-hub local-tools install ${PACK}@${published.version} --digest ${published.digest} --into <目录>`),
    started.text,
  );
  assert.ok(!started.text.includes(bed.reviewer.token), 'no token in the answer text');
});

test('the disclosed digest pins a real local-tools install and verify against the running Hub', async () => {
  const run = io();
  const code = await localToolsCommand(
    ['install', `${PACK}@${published.version}`, '--digest', published.digest, '--into', installed, '--hub', bed.hub.url],
    run,
    { input: Readable.from([`${bed.reviewer.token}\n`]) },
  );
  assert.equal(code, 0, run.err.join('\n'));
  const target = join(installed, `${PACK}@${published.version}`);
  assert.equal(sha256Hex(await readFile(join(target, 'pack.json'))), published.digest, 'the installed manifest is the pinned digest');
  const verify = io();
  assert.equal(await localToolsCommand(['verify', target, '--digest', published.digest], verify), 0, verify.err.join('\n'));
  assert.ok([...run.out, ...run.err, ...verify.out, ...verify.err].every((line) => !line.includes(bed.reviewer.token)), 'no token in any output');
});
