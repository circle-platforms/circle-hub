// cmd-verify-plumb names the long literal arguments of the commands it asks Plumb about: a model cannot count 200 characters
// (round 34: two valid commands with a 200-character host name were rejected), so the question carries a name and the count the
// program measured, and the report says what was replaced. Synthetic commands and names only (192.0.2.0/24).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { knowledgeFiles } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { buildCacheKey } from '../functions/generated/skills/plumb/plumb-client/cache.ts';
import { runCmdVerifyPlumb } from './cmd-verify-plumb.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const ROOT = 'a'.repeat(64);
const label = (ch: string, n: number): string => ch.repeat(n);
/** 63 + 63 + 63 + 8 characters and three dots: exactly 200 characters, like the host of the round-34 case. */
const HOST = [label('h', 63), label('j', 63), label('k', 63), label('m', 8)].join('.');
/** The same length and labels, one character different in the middle. */
const HOST_OTHER = [label('h', 63), `${label('j', 30)}x${label('j', 32)}`, label('k', 63), label('m', 8)].join('.');
const NAME_HOST = '«L1（200个字符；各段63、63、63、8）»';
const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

interface Seen { task: string; questions: Record<string, Record<string, unknown> & { task: string; command?: string; commands?: string[]; definition?: string; state?: string; node?: Record<string, unknown> }> }
const seen: Seen[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Seen;
    seen.push(body);
    const answers: Record<string, unknown> = {};
    for (const qid of Object.keys(body.questions ?? {})) {
      answers[qid] = {
        status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0',
        answer: { type: 'noul', value: 'yes', match: 1, probabilities: { yes: 0.92, no: 0.08 } },
        gate: { action: 'pass', calibrated: true, calibration_source: 'benchmark-synth' },
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: '未确认', decided_by: '模型', model_version: 'plumb-27b-0.5.0', task: body.task, request_id: `req-${seen.length}`, answers }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { await new Promise<void>((r) => server.close(() => r())); });

const ROWS: Array<{ path: string; children: string[]; definition?: string }> = [
  { path: '/', children: ['commands'] },
  { path: '/commands', children: ['widget', 'show'] },
  { path: '/commands/widget', children: ['on', 'host', 'key'] },
  { path: '/commands/widget/on', children: [], definition: 'widget on\n  Turn the widget on' },
  { path: '/commands/widget/host', children: ['set'] },
  { path: '/commands/widget/host/set', children: [], definition: 'widget host set <arg1:string> <arg2:ipv4>\n  Set the host\n  arg1: Host name(a string of 1 to 200 characters in the format of www.xyz.com)' },
  { path: '/commands/widget/key', children: ['new'] },
  { path: '/commands/widget/key/new', children: [], definition: 'widget key new <arg1:string> <arg2:string> [<arg3:string="">] [<arg4:int 0..4294967295="2048">]\n  Generate the keys\n  arg1: Host name(a string of 1 to 200 characters in the format of www.xyz.com)\n  arg2: Key type (KSK or ZSK)' },
  { path: '/commands/show', children: ['widget'] },
  { path: '/commands/show/widget', children: ['key'] },
  { path: '/commands/show/widget/key', children: [], definition: 'show widget key [<arg1:string="">]\n  Display the keys\n  arg1: Host name' },
];

function knowledgeBatch(): Buffer {
  const nodes = ROWS.map((r, idx) => ({
    path: r.path,
    reference: `tree:${ROOT}${r.path}`,
    name: r.path.split('/').at(-1),
    level: r.children.length ? 'branch' : 'leaf',
    digest: String(idx + 1).padStart(64, '0'),
    children: r.children.map((c, j) => ({ name: c, path: `${r.path === '/' ? '' : r.path}/${c}`, digest: String(idx * 100 + j).padStart(64, '0') })),
    entries: r.definition === undefined ? [] : [{ entry: String(idx + 200).padStart(64, 'b'), kind: 'definition', statement: r.definition, reference: `tree:${ROOT}${r.path}@${String(idx + 200).padStart(64, 'b')}` }],
  }));
  const head = { schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: null, nodes: nodes.length, entries: ROWS.filter((r) => r.definition !== undefined).length };
  return Buffer.from([head, ...nodes].map((n) => JSON.stringify(n)).join('\n') + '\n');
}

type StepArgs = string[];
async function workspace(stepArgs: StepArgs[]): Promise<{ dir: string; plans: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'cc-cmd-verify-literals-'));
  for (const { name, bytes } of knowledgeFiles(knowledgeBatch(), RUN).outputs) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), bytes);
  }
  await writeFile(join(dir, 'run.json'), JSON.stringify({ run: RUN, product: 'synth-widget', version: '1.0', build: 'b1' }));
  await mkdir(join(dir, 'items'));
  await writeFile(join(dir, 'items', '00.json'), JSON.stringify({
    id: 'doc:0',
    fields: { autoid: 'C0', title: '长字面量命令核验', path: ['部件', '密钥', '长字面量命令核验'], steps: stepArgs.map((_, i) => ({ text: `第 ${i + 1} 步的作者原话` })) },
  }));
  const plans = join(dir, 'plans');
  await mkdir(plans);
  await writeFile(join(plans, '00.json'), JSON.stringify({
    item: 'doc:0',
    handling: 'handled',
    slots: { plan: [{ text: 'plan 0', quotes: [], data: {
      bucket: 'bed-0', blocks: [], replacements: [], expects: [],
      steps: stepArgs.map((args, i) => ({ object: 'dut0', method: 'cmd_config', args, keywords: {}, author_step_refs: [String(i + 1)] })),
    } }] },
  }));
  return { dir, plans };
}

type Report = { disclosure?: string; results: Array<{ steps: Array<{ pointer: string; task: string; command: string; literal_substitutions?: unknown[] }> }> };
async function run(w: { dir: string; plans: string }, extra: string[] = []): Promise<{ code: number; report: Report; stderr: string }> {
  seen.length = 0;
  const res = await runCmdVerifyPlumb(['--plans', w.plans, '--run', w.dir, '--base-url', baseUrl, '--key-stdin', ...extra], { stdinText: 'plumb_sk_literals\n' });
  return { code: res.code, report: JSON.parse(res.stdout || '{"results":[]}') as Report, stderr: res.stderr };
}
const questions = (): Seen['questions'] => Object.assign({}, ...seen.map((b) => b.questions));

test('a 200-character host is sent as a named placeholder with the measured count, never as the raw literal', async () => {
  const w = await workspace([
    ['widget on'],
    [`widget host set "${HOST}" 192.0.2.35`],
    [`widget key new "${HOST}" ksk ALG1 1024`],
    [`show widget key "${HOST}"`],
  ]);
  try {
    const { code, report, stderr } = await run(w);
    assert.equal(code, 0, stderr);
    const q = questions();
    assert.deepEqual(Object.keys(q), ['0:0', '0:1', '0:2', '0:3']);
    for (const text of [HOST, label('h', 32), label('j', 32), label('k', 32)]) {
      assert.ok(!JSON.stringify(seen).includes(text), 'no part of the long literal reaches Plumb');
    }

    // The command and the manual definition: only the literal is replaced.
    assert.equal(q['0:2']!.command, `widget key new "${NAME_HOST}" ksk ALG1 1024`);
    assert.equal(q['0:3']!.command, `show widget key "${NAME_HOST}"`);
    assert.equal(q['0:2']!.definition, ROWS[7]!.definition, 'the definition is the manual text, not touched');

    // The state: earlier commands and the current one carry the same name; the case text around them is as before.
    assert.equal(q['0:3']!.state, [
      '[用例]', '长字面量命令核验', '',
      '[已执行的步骤]',
      '1. widget on',
      `2. widget host set "${NAME_HOST}" 192.0.2.35`,
      `3. widget key new "${NAME_HOST}" ksk ALG1 1024`,
      '',
      '[当前步骤]',
      '步骤位置: /steps/3',
      '步骤意图: 4. 第 4 步的作者原话',
      `候选命令: show widget key "${NAME_HOST}"`,
    ].join('\n'));

    // The disclosure of each step says what stood in its question.
    const sub = (steps: number): unknown => report.results[0]!.steps[steps]!.literal_substitutions;
    assert.equal(sub(0), undefined, 'a question without a long literal has nothing to disclose');
    assert.deepEqual(sub(1), [{ name: '«L1»', length: 200, labels: [63, 63, 63, 8], occurrences: 1, sha256_12: sha12(HOST) }]);
    assert.deepEqual(sub(3), [{ name: '«L1»', length: 200, labels: [63, 63, 63, 8], occurrences: 3, sha256_12: sha12(HOST) }]);
    assert.equal(report.results[0]!.steps[3]!.command, `show widget key "${HOST}"`, 'the report still names the command as the plan wrote it');
    assert.match(report.disclosure ?? '', /^长字面量换名：3 道题的题面里，命令中 32 个字符以上的字面量/, 'the report says that, and how many questions, carried names');
    assert.ok(!(report.disclosure ?? '').includes(HOST));
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('short literals and commands without a long literal are sent exactly as before', async () => {
  const w = await workspace([
    ['widget on'],
    [`widget host set "${label('h', 31)}" 192.0.2.35`],
    ['widget key new "short.example.test" zsk ALG1 1024'],
  ]);
  try {
    const { code, report, stderr } = await run(w);
    assert.equal(code, 0, stderr);
    assert.deepEqual(questions()['0:2'], {
      task: 'single_cmd_judge',
      command: 'widget key new "short.example.test" zsk ALG1 1024',
      definition: ROWS[7]!.definition,
      state: [
        '[用例]', '长字面量命令核验', '',
        '[已执行的步骤]',
        '1. widget on',
        `2. widget host set "${label('h', 31)}" 192.0.2.35`,
        '',
        '[当前步骤]',
        '步骤位置: /steps/2',
        '步骤意图: 3. 第 3 步的作者原话',
        '候选命令: widget key new "short.example.test" zsk ALG1 1024',
      ].join('\n'),
    });
    for (const step of report.results[0]!.steps) assert.equal(step.literal_substitutions, undefined);
    assert.equal(report.disclosure, undefined, 'nothing was named, so there is nothing to disclose');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('the names go by first appearance, one name per literal, and a literal that differs by one character has its own', async () => {
  const w = await workspace([
    [`widget host set "${HOST}" 192.0.2.35`],
    [`widget host set "${HOST_OTHER}" 192.0.2.36`],
    [`widget key new "${HOST}" ksk ALG1 1024`],
  ]);
  try {
    const { report } = await run(w);
    const q = questions();
    assert.equal(q['0:1']!.command, 'widget host set "«L2（200个字符；各段63、63、63、8）»" 192.0.2.36', 'in the second question the host of the first step comes first, so the second host is the second name');
    assert.match(q['0:1']!.state!, new RegExp(`1\\. widget host set "${NAME_HOST}" 192\\.0\\.2\\.35`));
    assert.equal(q['0:2']!.command, `widget key new "${NAME_HOST}" ksk ALG1 1024`, 'the first host keeps its name');
    assert.deepEqual(
      (report.results[0]!.steps[2]!.literal_substitutions as Array<{ name: string; occurrences: number; sha256_12: string }>).map((s) => [s.name, s.occurrences, s.sha256_12]),
      [['«L1»', 2, sha12(HOST)], ['«L2»', 1, sha12(HOST_OTHER)]],
      'the third question has both literals in its state: the first twice (an earlier step and this one), the second once',
    );
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a list of commands names the same literal alike in every line, and the node form carries the name in the command', async () => {
  const w = await workspace([[`widget host set "${HOST}" 192.0.2.35\nwidget key new "${HOST}" zsk ALG1 1024`]]);
  try {
    const listed = await run(w);
    assert.equal(listed.code, 0, listed.stderr);
    const q = questions()['0:0']!;
    assert.equal(q.task, 'steplist_judge');
    assert.deepEqual(q.commands, [`widget host set "${NAME_HOST}" 192.0.2.35`, `widget key new "${NAME_HOST}" zsk ALG1 1024`]);
    assert.match(q.state!, new RegExp(`候选命令: \\n1\\. widget host set "${NAME_HOST}" 192\\.0\\.2\\.35\\n2\\. widget key new "${NAME_HOST}" zsk ALG1 1024`));
    assert.ok(!JSON.stringify(seen).includes(label('k', 32)));
    assert.deepEqual(listed.report.results[0]!.steps[0]!.literal_substitutions, [{ name: '«L1»', length: 200, labels: [63, 63, 63, 8], occurrences: 2, sha256_12: sha12(HOST) }]);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }

  const single = await workspace([[`widget key new "${HOST}" ksk ALG1 1024`]]);
  try {
    const node = await run(single, ['--context-mode', 'node']);
    assert.equal(node.code, 0, node.stderr);
    const q = questions()['0:0']!;
    assert.equal(q.command, `widget key new "${NAME_HOST}" ksk ALG1 1024`);
    assert.equal(q.state, undefined, 'a node question never carries a state');
    assert.ok(q.node && typeof q.node.line === 'string');
    assert.ok(!JSON.stringify(seen).includes(label('j', 32)));
    assert.deepEqual(node.report.results[0]!.steps[0]!.literal_substitutions, [{ name: '«L1»', length: 200, labels: [63, 63, 63, 8], occurrences: 1, sha256_12: sha12(HOST) }]);
  } finally {
    await rm(single.dir, { recursive: true, force: true });
  }

  // A node question lists no earlier command, so an earlier literal does not use up a name: the first name it carries is «L1».
  const two = await workspace([[`widget host set "${HOST_OTHER}" 192.0.2.36`], [`widget key new "${HOST}" ksk ALG1 1024`]]);
  try {
    const node = await run(two, ['--context-mode', 'node']);
    assert.equal(node.code, 0, node.stderr);
    assert.equal(questions()['0:1']!.command, `widget key new "${NAME_HOST}" ksk ALG1 1024`);
  } finally {
    await rm(two.dir, { recursive: true, force: true });
  }
});

test('the cache keeps the answer under the key of the question as sent, so another count is another question', async () => {
  const w = await workspace([[`widget key new "${HOST}" ksk ALG1 1024`]]);
  const cache = await mkdtemp(join(tmpdir(), 'cc-cmd-verify-cache-'));
  try {
    const first = await run(w, ['--cache-dir', cache, '--model', 'plumb-27b-0.5.0']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(seen.length, 1);
    const key = (request: unknown): string => buildCacheKey({ endpoint: '/v1/judge', baseOrigin: baseUrl, model: 'plumb-27b-0.5.0', request });
    assert.deepEqual(await readdir(cache), [`${key(seen[0])}.json`], 'stored under the key of the request as sent');
    assert.match(JSON.stringify(seen[0]), /«L1（200个字符；各段63、63、63、8）»/);
    assert.ok(!JSON.stringify(seen[0]).includes(HOST));

    const again = await run(w, ['--cache-dir', cache, '--model', 'plumb-27b-0.5.0']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(seen.length, 0, 'the same question is answered from the cache');

    // One character more is another count, hence another question and another key.
    const longer = await workspace([[`widget key new "${HOST}z" ksk ALG1 1024`]]);
    try {
      const second = await run(longer, ['--cache-dir', cache, '--model', 'plumb-27b-0.5.0']);
      assert.equal(second.code, 0, second.stderr);
      assert.equal(seen.length, 1, 'a 201-character host is asked again');
      assert.match(JSON.stringify(seen[0]), /«L1（201个字符；各段63、63、63、9）»/);
      assert.equal((await readdir(cache)).length, 2);
    } finally {
      await rm(longer.dir, { recursive: true, force: true });
    }
  } finally {
    await rm(w.dir, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  }
});

test('a literal in other characters is counted in characters and bytes', async () => {
  const wide = '键'.repeat(40);
  const w = await workspace([[`widget host set "${wide}" 192.0.2.35`]]);
  try {
    const { code, report, stderr } = await run(w);
    assert.equal(code, 0, stderr);
    assert.equal(questions()['0:0']!.command, 'widget host set "«L1（40个字符，120字节）»" 192.0.2.35');
    assert.deepEqual(report.results[0]!.steps[0]!.literal_substitutions, [{ name: '«L1»', length: 40, bytes: 120, occurrences: 1, sha256_12: sha12(wide) }]);
    assert.ok(!JSON.stringify(seen).includes(wide));
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a literal too long for the 1800-token budget as written is named, so the command is asked about instead of refused', async () => {
  const huge = Array.from({ length: 60 }, () => label('h', 63)).join('.');
  assert.equal(huge.length, 3839);
  const w = await workspace([[`widget host set "${huge}" 192.0.2.35`]]);
  try {
    const { code, report, stderr } = await run(w);
    assert.equal(code, 0, stderr);
    assert.equal(questions()['0:0']!.command, 'widget host set "«L1（3839个字符；60段，最长63）»" 192.0.2.35');
    assert.ok(!JSON.stringify(seen).includes(label('h', 64)));
    assert.deepEqual(report.results[0]!.steps[0]!.literal_substitutions, [{ name: '«L1»', length: 3839, labels: Array.from({ length: 60 }, () => 63), occurrences: 1, sha256_12: sha12(huge) }]);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('a length placeholder of the plan ends up as the same name with the count it was written with', async () => {
  const w = await workspace([['widget host set "{{domain:200}}" 192.0.2.35'], ['widget key new "{{domain:200}}" ksk ALG1 1024']]);
  try {
    const { code, report, stderr } = await run(w);
    assert.equal(code, 0, stderr);
    assert.equal(questions()['0:1']!.command, `widget key new "${NAME_HOST}" ksk ALG1 1024`);
    assert.match(questions()['0:1']!.state!, new RegExp(`1\\. widget host set "${NAME_HOST}" 192\\.0\\.2\\.35`));
    assert.ok(!JSON.stringify(seen).includes(label('a', 32)), 'the expanded domain is not sent either');
    assert.equal(report.results[0]!.steps[1]!.command.length, 'widget key new "" ksk ALG1 1024'.length + 200, 'the report keeps the expanded command');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});
