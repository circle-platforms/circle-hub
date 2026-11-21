// The device read tool: what it sends, what it keeps of the answer, and that a read that cannot be made is an answer, not a failure.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, readClaim } from './device-read.ts';
import { NotReady, type CallTool, type ToolAnswer } from './open-compile.ts';

const BOOKING = 'run_0' + 'a'.repeat(25);
const observation = (output: string | null, truncated = false) => ({ run: { run: 'run_0' + 'b'.repeat(25), device_reads: [{ statement: { text: '在 bed-a/dev0 上读“show widget name”：设备输出 2 行', data: { label: 'bed-a/dev0', line: 'show widget name', has_output: output !== null, output, truncated, withheld: false } }, qualifier: { nature: 'fact', provenance: 'observed', marks: ['target_reported', 'local_ops_not_excluded'], collected_at: '2026-01-02T03:04:05.000Z' } }] } });
const unknown = { run: { run: 'run_0' + 'b'.repeat(25), device_reads: [{ statement: { text: '没有读设备：这台执行器没有声明可以按请求读设备。下一步：管理员声明后重试', verdict: 'unknown', data: { sent: false } }, qualifier: { nature: 'unknown', marks: [] } }] } };
async function capture(run: () => Promise<number>) {
  const write = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr); let out = '', errors = '';
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { errors += chunk; return true; }) as typeof process.stderr.write;
  try { return { code: await run(), out, errors }; } finally { process.stdout.write = write; process.stderr.write = err; }
}
const answering = (answer: ToolAnswer | Error, seen: Array<{ name: string; args: Record<string, unknown> }> = []) => (): CallTool => async (name, args) => { seen.push({ name, args }); if (answer instanceof Error) throw answer; return answer; };

test('the claim that carries the device words is read; an unknown claim gives its own words', () => {
  assert.deepEqual(readClaim(observation('name  size\nwidget-a  1')), { output: 'name  size\nwidget-a  1', truncated: false, observed: '2026-01-02T03:04:05.000Z' });
  assert.equal(readClaim(unknown), '没有读设备：这台执行器没有声明可以按请求读设备。下一步：管理员声明后重试');
  assert.equal(readClaim(observation(null)), '在 bed-a/dev0 上读“show widget name”：设备输出 2 行', 'a claim without output has nothing to keep');
  assert.equal(readClaim(null), 'Hub 的答复里没有这条命令的设备输出');
});

test('a read is one start_run of the test-bed read action, and the output is kept under a header that says what it is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'device-read-')), out = join(dir, 'show-widget-name.txt'), seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  const got = await capture(() => main(['--hub', 'https://hub.example.invalid/mcp', '--booking', BOOKING, '--device', 'dev0', '--line', ' show widget name ', '--out', out, '--bed', 'bed-a'], async () => 'synthetic-token-1234', answering({ failed: false, text: '合成', envelope: observation('name  size\nwidget-a  1', true) }, seen)));
  assert.equal(got.code, 0);
  assert.deepEqual(seen, [{ name: 'start_run', args: { pack: 'test-bed', inputs: { inventory: { external: 'doc:doc:bed-topology' } }, predecessor: BOOKING, parameters: { action: 'read', booking: BOOKING, device: 'dev0', line: 'show widget name', bed: 'bed-a' } } }]);
  assert.deepEqual(JSON.parse(got.out), { read: true, file: out, line: 'show widget name', device: 'dev0', lines: 2, chars: 22, truncated: true });
  const kept = await readFile(out, 'utf8');
  assert.equal(kept, '# 设备 dev0 对“show widget name”的输出（2026-01-02T03:04:05.000Z 读到）；目标自报，未排除本地操作；输出过长，已截断\n# 只说明输出的写法和排版，不能当期望值的依据。\nname  size\nwidget-a  1\n');
  assert.equal(got.out.includes('synthetic-token-1234') || kept.includes('synthetic-token-1234'), false);
});

test('a read that cannot be made is said in one line with exit 0, and nothing is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'device-read-'));
  const argv = (out: string) => ['--hub', 'https://hub.example.invalid/mcp', '--booking', BOOKING, '--device', 'dev0', '--line', 'show widget name', '--out', out];
  for (const [name, answer, why] of [
    ['no-read', { failed: false, text: '合成', envelope: unknown }, /^没有读设备：这台执行器没有声明可以按请求读设备/],
    ['refused', { failed: true, text: '运行没有开出来\n第二行', envelope: { errors: [{ code: 'test-bed.not_holder', message: '这台设备不是当前账户预订的', fix: '先预订' }] } }, /这台设备不是当前账户预订的/],
    ['down', new NotReady('Hub 45 秒内没有答复 start_run；读运行列表确认有没有开出运行，再重跑本工具'), /^Hub 45 秒内没有答复 start_run/],
  ] as Array<[string, ToolAnswer | Error, RegExp]>) {
    const out = join(dir, name + '.txt');
    const got = await capture(() => main(argv(out), async () => 'synthetic-token-1234', answering(answer)));
    assert.equal(got.code, 0, name);
    const said = JSON.parse(got.out) as { read: boolean; why: string };
    assert.equal(said.read, false); assert.match(said.why, why);
    assert.equal(existsSync(out), false, name);
  }
});

test('a booking that is no run number, or a line with a control character, is refused before any call', async () => {
  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const argv of [
    ['--hub', 'https://hub.example.invalid/mcp', '--booking', 'nope', '--device', 'dev0', '--line', 'show widget name', '--out', 'x.txt'],
    ['--hub', 'https://hub.example.invalid/mcp', '--booking', BOOKING, '--device', 'dev0', '--line', 'show widget\tname', '--out', 'x.txt'],
  ]) {
    const got = await capture(() => main(argv, async () => 'synthetic-token-1234', answering({ failed: false, text: '合成', envelope: observation('x') }, seen)));
    assert.equal(got.code, 1); assert.match(got.errors, /^参数无效：/);
  }
  assert.deepEqual(seen, []);
});
