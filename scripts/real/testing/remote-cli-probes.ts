// Authored synthetic argv and exact expected stdin refusals for the seven remote release entry points.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliProbe } from '../verify-tool-cli.ts';

export const REMOTE_CASE_COMPILE_TOOLS = ['tools/assemble-delivery.ts', 'tools/download-returns.ts', 'tools/download-run.ts', 'tools/fetch-run.ts', 'tools/submit-plans.ts'] as const;
export const REMOTE_RECOMPOSE_TOOLS = ['tools/download-run.ts', 'tools/submit-records.ts'] as const;
const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', PLAN = 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', EMPTY = 'run_01cccccccccccccccccccccccc';
export const EMPTY_TOKEN_STDERR = "参数无效：标准输入里没有令牌（标准输入为空，常见原因是 node 命令行与 <<'EOF' 之间多打了换行或漏了 <<'EOF'）。请把 node 命令行与 <<'EOF' 写在同一行（空格隔开，切勿在 <<'EOF' 前换行），下一行只写 %HUB_TOKEN%，再一行只写 EOF。\n";
export const NO_DISPATCH_STDERR = '暂时不可用：尚未上机验证，或设备输出缺少逐条结论；--runs 请只选择已结束的上机验证。请读取原作业的进展，取得完整且未冻结的逐条结果后重试。\n';
export interface RemoteCliReceipt { method: string; path: string; authorized: boolean }
export interface RemoteCliProbes {
  caseCompile: Record<string, CliProbe[]>;
  recompose: Record<string, CliProbe[]>;
  receipts(): Promise<RemoteCliReceipt[]>;
  close(): Promise<void>;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The caller supplies staged packs and a private scratch directory; no installed home, model or real Hub is used. */
export async function buildRemoteCliProbes(stagedCaseDir: string, stagedRecomposeDir: string, workRoot: string): Promise<RemoteCliProbes> {
  if (!stagedCaseDir || !stagedRecomposeDir) throw new Error('Both staged pack directories are required');
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const token = 'synthetic-cli-' + digest(Buffer.from(workRoot));
  const receipt = join(workRoot, 'http-receipts.jsonl'); await writeFile(receipt, '', { mode: 0o600 });
  const atom = (id: string, kind: string, text: string, after: string[] = []) => ({ id, kind, text, content: text, reference: `src:${'a'.repeat(64)}/kityminder@1/n/${id}`, selector: `n/${id}`, node_id: id, start: 0, end: text.length, labels: [], explicit_labels: [], number_label: null, after });
  const item = { id: 'n/case', fields: { case_id: 'SYNTHETIC-1', autoid: '990000000000000101', title: '合成用例', source_ref: `src:${'a'.repeat(64)}`, node: 'n/case', atoms: [atom('a1', 'action', '合成动作'), atom('a2', 'expectation', '合成期望', ['a1'])] } };
  const originals = { contract: Buffer.from('{"synthetic_contract":true}'), profile: Buffer.from('{"synthetic_profile":true}'), inventory: Buffer.from('{"synthetic_inventory":true}') };
  const record = { run: RUN, items: [item], sources: Object.entries(originals).map(([slot, bytes]) => ({ slot, role: 'expected', media_type: 'application/json', reference: `src:${digest(bytes)}` })) };
  const routes: Record<string, { status: number; body: string; contentType?: string }> = {};
  const jsonRoute = (path: string, value: unknown) => { routes[`GET ${path}`] = { status: 200, body: JSON.stringify(value) }; };
  jsonRoute(`/run-export/${RUN}/run`, { schema: 'run-export@1', run: record });
  jsonRoute(`/run-export/${RUN}`, { schema: 'run-export@1', run: record, result: { run: RUN }, submission: { run: RUN } });
  jsonRoute(`/run-export/${EMPTY}/jobs`, { schema: 'run-jobs@1', run: EMPTY, jobs: [] });
  jsonRoute(`/run-export/${RUN}/jobs`, { schema: 'run-jobs@1', run: RUN, jobs: [{ job: 'c'.repeat(64), verification_run: RUN, plan_run: PLAN, items: [], sha256: 'd'.repeat(64), ended: 'done', outcome: 'effective', frozen: false, result: `src:${'9'.repeat(64)}`, device_return: null, rows: [] }] });
  for (const bytes of Object.values(originals)) routes[`GET /run-export/${RUN}/sources/${digest(bytes)}`] = { status: 200, body: bytes.toString(), contentType: 'application/json' };
  routes['POST /mcp'] = { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '合成回执：已受理' }] } }) };
  const plans = join(workRoot, 'plans'), records = join(workRoot, 'records');
  await mkdir(plans); await mkdir(records);
  await writeFile(join(plans, '01.json'), JSON.stringify({ item: item.id, handling: 'handled', slots: { plan: [{ text: '合成计划', quotes: [], data: {} }] } }));
  await writeFile(join(records, '01.json'), JSON.stringify({ item: item.id, method: { kind: 'declared', text: '合成方法', sources: ['synthetic-reference'], basis: '合成依据' } }));
  const notes = join(workRoot, 'notes.json'); await writeFile(notes, '{"cases":{}}');
  const child = fork(fileURLToPath(new URL('./remote-cli-worker.ts', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { NODE_NO_WARNINGS: '1' } });
  const origin = await new Promise<string>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error(`Synthetic CLI responder exited before ready: ${code}`)));
    child.once('message', value => resolve((value as { origin: string }).origin));
    child.send({ token, run: RUN, receipt, routes });
  });
  const probe = (argv: string[], complete: CliProbe['complete'] = { status: 0 }): CliProbe[] => [{ argv, cwd: workRoot, subcommand: null, stdinValues: [token], complete, empty: { status: 1, stdout: '', stderr: EMPTY_TOKEN_STDERR } }];
  return {
    caseCompile: {
      'tools/assemble-delivery.ts': probe(['--hub', origin + '/mcp', '--runs', EMPTY, '--notes', notes, '--out', join(workRoot, 'delivery')], { status: 1, stdout: '', stderr: NO_DISPATCH_STDERR }),
      'tools/download-returns.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--out', join(workRoot, 'returns')]),
      'tools/download-run.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--out', join(workRoot, 'compile-download')]),
      'tools/fetch-run.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--out', join(workRoot, 'fetched')]),
      'tools/submit-plans.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--model', 'synthetic-model', '--plans', plans]),
    },
    recompose: {
      'tools/download-run.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--out', join(workRoot, 'recompose-download')]),
      'tools/submit-records.ts': probe(['--hub', origin + '/mcp', '--run', RUN, '--model', 'synthetic-model', '--records', records]),
    },
    async receipts() { return (await readFile(receipt, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as RemoteCliReceipt); },
    async close() { if (child.exitCode !== null) return; const ended = new Promise<void>(resolve => child.once('exit', () => resolve())); child.disconnect(); await ended; },
  };
}
