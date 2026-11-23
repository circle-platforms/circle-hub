import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { JEV_ENDPOINT, JevTransportError } from '../functions/modules/jev-client/index.ts';
import type { JevTransportRequest } from '../functions/modules/jev-client/index.ts';
import { KEY, MARKERS, answerBody, choiceRequest, clock, json, markerRequest, mixedRequest, noulRequest, okStep, recordingSleep, scoreRequest, scripted, text } from '../testing/synthetic.ts';
import type { Step } from '../testing/synthetic.ts';
import { MAX_KEY_LENGTH } from '../functions/modules/jev-client/client.ts';
import { MAX_BODY_BYTES } from '../functions/modules/jev-client/validate.ts';
import { readAtMost, readFirstLine, runJevJudgeCli } from './jev-judge.ts';

const TOOL = fileURLToPath(new URL('./jev-judge.ts', import.meta.url));
const FORM = /^(参数无效|无权限|暂时不可用|不存在|已被占用)：[^。\n]+。[^。\n]+。$/u;
const SECOND_LINE = 'SECOND-STDIN-LINE-MARKER';

let root = '';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jev-tool-test-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Workspace {
  dir: string;
  input: string;
  out: string;
}

let counter = 0;
async function fresh(request: unknown = mixedRequest): Promise<Workspace> {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  await mkdir(dir);
  const input = join(dir, 'request.json');
  await writeFile(input, typeof request === 'string' ? request : JSON.stringify(request));
  return { dir, input, out: join(dir, 'out') };
}

const argvOf = (space: Workspace, extra: readonly string[] = []): string[] => ['ask', '--input', space.input, '--out', space.out, ...extra, '--key-stdin'];

interface Run {
  code: number;
  stdout: string[];
  stderr: string[];
  calls: JevTransportRequest[];
  waits: number[];
}

async function run(argv: readonly string[], options: { stdin?: string; steps?: readonly Step[] } = {}): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { transport, calls } = scripted(options.steps ?? [okStep]);
  const { sleep, waits } = recordingSleep();
  const code = await runJevJudgeCli(argv, {
    stdinText: options.stdin ?? `${KEY}\n`,
    stdout: (line) => void stdout.push(line),
    stderr: (line) => void stderr.push(line),
    transport,
    sleep,
    now: clock(),
  });
  return { code, stdout, stderr, calls, waits };
}

/** A run that has to end in a refusal in the call-error form, before anything is sent. */
async function refused(argv: readonly string[], stdin?: string): Promise<string> {
  const result = await run(argv, stdin === undefined ? {} : { stdin });
  assert.equal(result.code, 1, result.stdout.join('\n'));
  assert.deepEqual(result.stdout, []);
  assert.equal(result.stderr.length, 1, result.stderr.join('\n'));
  assert.match(result.stderr[0]!, FORM);
  assert.equal(result.calls.length, 0, 'nothing was sent');
  return result.stderr[0]!;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
const linesOf = async (path: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

describe('the command line', () => {
  it('prints the usage and stops when asked for help or given nothing', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['ask', '--help'], ['ask', '--input', 'x', '-h']]) {
      const result = await run(argv);
      assert.equal(result.code, 0, JSON.stringify(argv));
      assert.deepEqual(result.stderr, []);
      assert.equal(result.stdout.length, 1);
      for (const word of ['用法', 'ask', '--input', '--out', '--model', '--timeout-ms', '--key-stdin', '%JEV_API_KEY%', 'audit.jsonl', 'answers.json']) assert.ok(result.stdout[0]!.includes(word), word);
      assert.equal(result.calls.length, 0);
    }
  });

  const cases: ReadonlyArray<[string, string[], RegExp]> = [
    ['a first word that is not the subcommand', ['verify'], /^参数无效：首个参数必须是子命令 ask。/u],
    ['a word that is not an option', ['ask', 'extra'], /第 2 个参数不是选项/u],
    ['an option it does not have', ['ask', '--frobnicate', 'x'], /不支持选项 --frobnicate/u],
    ['an option written in capitals', ['ask', '--Input', 'x'], /有一个不认识的选项/u],
    ['an option joined with =', ['ask', '--input=request.json'], /选项 --input 不允许使用 = 连接/u],
    ['a boolean option joined with =', ['ask', '--key-stdin=true'], /选项 --key-stdin 不允许使用 = 连接/u],
    ['an option written twice', ['ask', '--input', 'a', '--input', 'b'], /选项 --input 写了两次/u],
    ['an option at the end without its value', ['ask', '--input'], /选项 --input 缺少取值/u],
    ['an option followed by another option', ['ask', '--input', '--out', 'x'], /选项 --input 缺少取值/u],
    ['a missing request file', ['ask', '--out', 'x', '--key-stdin'], /缺少 --input/u],
    ['a missing output folder', ['ask', '--input', 'x', '--key-stdin'], /缺少 --out/u],
    ['a missing --key-stdin', ['ask', '--input', 'x', '--out', 'y'], /缺少 --key-stdin：密钥只从标准输入第一行传入/u],
    ['a time limit of zero', ['ask', '--input', 'x', '--out', 'y', '--timeout-ms', '0', '--key-stdin'], /--timeout-ms 必须是 1 到 600000 之间的整数/u],
    ['a time limit that is not a number', ['ask', '--input', 'x', '--out', 'y', '--timeout-ms', 'abc', '--key-stdin'], /--timeout-ms 必须是/u],
    ['a time limit with a fraction', ['ask', '--input', 'x', '--out', 'y', '--timeout-ms', '1.5', '--key-stdin'], /--timeout-ms 必须是/u],
    ['a negative time limit', ['ask', '--input', 'x', '--out', 'y', '--timeout-ms', '-1', '--key-stdin'], /缺少取值|--timeout-ms 必须是/u],
    ['a time limit over the maximum', ['ask', '--input', 'x', '--out', 'y', '--timeout-ms', '600001', '--key-stdin'], /--timeout-ms 必须是/u],
    ['a time limit of eight digits', ['ask', '--input', 'x', '--out', 'y', '--timeout-ms', '12345678', '--key-stdin'], /--timeout-ms 必须是/u],
  ];
  for (const [name, argv, expected] of cases) {
    it(`refuses ${name}`, async () => {
      assert.match(await refused(argv), expected);
    });
  }

  it('refuses every way of putting the key on the command line, without naming the value', async () => {
    for (const flag of ['--api-key', '--apikey', '--key', '--token', '--secret']) {
      for (const argv of [['ask', flag, MARKERS.key], ['ask', `${flag}=${MARKERS.key}`], ['ask', '--input', 'x', flag, MARKERS.key, '--key-stdin']]) {
        const message = await refused(argv);
        assert.ok(message.includes(`禁止通过命令行参数 ${flag} 传入密钥`), message);
        assert.ok(message.includes('--key-stdin') && message.includes('%JEV_API_KEY%'), message);
        assert.ok(!message.includes(MARKERS.key), message);
      }
    }
  });
});

describe('the key', () => {
  it('is the first line of the standard input, with the line end and the spaces taken off', async () => {
    for (const stdin of [`${KEY}\n`, `${KEY}\r\n`, `  ${KEY}  \n`, KEY, `${KEY}\n${SECOND_LINE}\n`, `${KEY}\r${SECOND_LINE}`]) {
      const space = await fresh();
      const result = await run(argvOf(space), { stdin });
      assert.equal(result.code, 0, result.stderr.join('\n'));
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0]!.headers.Authorization, `Bearer ${KEY}`);
      assert.ok(!JSON.stringify(result).includes(SECOND_LINE), 'a second line of the standard input goes nowhere');
    }
  });

  it('is asked for again when the line is empty or only spaces, and the message says nothing was sent', async () => {
    for (const stdin of ['', '\n', '\n\n', '   \n', '\r\n']) {
      const message = await refused(argvOf(await fresh()), stdin);
      assert.ok(message.startsWith('参数无效：已传入 --key-stdin 但标准输入首行为空；这是本地检查，没有发出任何请求。'), message);
      assert.ok(message.includes('%JEV_API_KEY%'), message);
    }
  });

  it('is refused when the client left the placeholder in, and the message says who has to fix it and that nothing was sent', async () => {
    const message = await refused(argvOf(await fresh()), '%JEV_API_KEY%\n');
    assert.ok(message.startsWith('无权限：标准输入第一行还是占位符 %JEV_API_KEY%，客户端没有把它展开成密钥；这是本地检查，没有发出任何请求。'), message);
    assert.ok(message.includes('/secrets JEV_API_KEY'), message);
  });

  it('is refused when the line is a placeholder of another name, and the message names the one this tool takes', async () => {
    for (const placeholder of ['%PLUMB_API_KEY%', '%HUB_TOKEN%', '%X%', '%a_b_9%']) {
      const message = await refused(argvOf(await fresh()), `${placeholder}\n`);
      assert.ok(message.startsWith(`无权限：标准输入第一行还是占位符 ${placeholder}，客户端没有把它展开成密钥；这是本地检查，没有发出任何请求。`), message);
      assert.ok(message.includes('这个工具的密钥占位符是 %JEV_API_KEY%'), message);
      assert.ok(!message.includes('/secrets'), message);
    }
  });

  it('is refused when it has a character a key cannot have, and the message says it is no refusal of the service and nothing was sent', async () => {
    for (const stdin of ['a key with spaces\n', 'abc;def\n', 'ключ\n', '口令abc\n', '100%\n', '%a b%\n', 'abc%DEF%ghi\n', '%%\n', 'prefix%JEV_API_KEY%\n']) {
      const message = await refused(argvOf(await fresh()), stdin);
      assert.ok(message.startsWith('无权限：Jev API 密钥没有通过本地检查（为空、太长或含不允许的字符），没有发出任何请求，不是服务拒绝。'), message);
      assert.ok(!message.includes(stdin.trim()), message);
    }
  });
});

describe('what the tool reads is bounded', () => {
  it('takes a first line as long as the longest key, and looks at nothing after that line', async () => {
    const longest = 'a'.repeat(MAX_KEY_LENGTH);
    const asked = await run(argvOf(await fresh()), { stdin: longest });
    assert.equal(asked.code, 0, asked.stderr.join('\n'));
    assert.equal(asked.calls[0]!.headers.Authorization, `Bearer ${longest}`);
    const rest = await run(argvOf(await fresh()), { stdin: `${KEY}\n${'x'.repeat(2_000_000)}` });
    assert.equal(rest.code, 0, rest.stderr.join('\n'));
    assert.equal(rest.calls[0]!.headers.Authorization, `Bearer ${KEY}`);
  });

  it('refuses a first line longer than the longest key, with or without a line end, and says nothing was sent', async () => {
    for (const stdin of ['a'.repeat(MAX_KEY_LENGTH + 1), `${'a'.repeat(MAX_KEY_LENGTH + 1)}\n${KEY}\n`, 'a'.repeat(70_000), `${' '.repeat(MAX_KEY_LENGTH)}${KEY}\n`]) {
      const message = await refused(argvOf(await fresh()), stdin);
      assert.ok(message.startsWith(`参数无效：标准输入第一行超过 ${MAX_KEY_LENGTH} 字节，不是密钥；这是本地检查，没有发出任何请求。`), message.slice(0, 120));
      assert.ok(!message.includes('aaaaaaaa'), 'the line is not printed');
    }
  });

  it('stops reading a stream at the end of its first line (readFirstLine)', { timeout: 20_000 }, async () => {
    let pulled = 0;
    async function* endless(): AsyncGenerator<Buffer> {
      for (;;) {
        pulled += 1;
        if (pulled > 50) throw new Error('the reader did not stop');
        yield pulled === 1 ? Buffer.from(`${KEY}\nrest`) : Buffer.alloc(1024, 0x78);
      }
    }
    assert.equal(await readFirstLine(endless(), MAX_KEY_LENGTH), KEY);
    assert.equal(pulled, 1, 'nothing more was asked of the stream');
  });

  it('stops reading a stream whose first line is over the limit (readFirstLine)', { timeout: 20_000 }, async () => {
    let pulled = 0;
    async function* endless(): AsyncGenerator<Buffer> {
      for (;;) {
        pulled += 1;
        if (pulled > 50) throw new Error('the reader did not stop');
        yield Buffer.alloc(1024, 0x78);
      }
    }
    assert.equal(await readFirstLine(endless(), MAX_KEY_LENGTH), null);
    assert.equal(pulled, MAX_KEY_LENGTH / 1024 + 1, 'the fifth piece of 1024 bytes is the first that goes over 4096');
  });

  it('joins a line that arrives in pieces, whatever the pieces are, and trims it (readFirstLine)', async () => {
    const mixed: ReadonlyArray<[ReadonlyArray<Buffer | string>, string | null]> = [
      [['ab', 'cd', '\n', 'ef'], 'abcd'],
      [[Buffer.from('ab'), '\r\ncd'], 'ab'],
      [['a', 'b\rc'], 'ab'],
      [['  ab  \n'], 'ab'],
      [['\n'], ''],
      [[], ''],
      [[Buffer.from('密钥').subarray(0, 4), Buffer.from('密钥').subarray(4), '\n'], '密钥'],
    ];
    for (const [chunks, expected] of mixed) assert.equal(await readFirstLine(chunks, MAX_KEY_LENGTH), expected, JSON.stringify(chunks));
    assert.equal(await readFirstLine(['abcd'], 3), null, 'the limit counts the bytes of the line');
    assert.equal(await readFirstLine(['abc\nxyz'], 3), 'abc');
  });

  it('reads a file to its end when it is within the limit, and gives null when it is over (readAtMost)', async () => {
    const path = join(root, 'ten.bin');
    await writeFile(path, Buffer.alloc(10, 1));
    for (const [limit, expected] of [[10, 10], [11, 10], [9, null], [0, null]] as const) {
      const handle = await open(path, 'r');
      try {
        assert.equal((await readAtMost(handle, limit))?.length ?? null, expected, String(limit));
      } finally {
        await handle.close();
      }
    }
    await writeFile(join(root, 'empty.bin'), '');
    const empty = await open(join(root, 'empty.bin'), 'r');
    try {
      assert.equal((await readAtMost(empty, 0))?.length, 0);
    } finally {
      await empty.close();
    }
  });

  it('stops reading a file that never ends (readAtMost)', { timeout: 20_000 }, async () => {
    let calls = 0;
    const endless = {
      read: async (buffer: Buffer) => {
        calls += 1;
        if (calls > 10) throw new Error('the reader did not stop');
        buffer.fill(0x61);
        return { bytesRead: buffer.length, buffer };
      },
    } as unknown as Parameters<typeof readAtMost>[0];
    const result = await readAtMost(endless, 3 * 1024 * 1024 + 5);
    // Only the length is compared: a failing comparison of the bytes themselves would take minutes to print.
    assert.equal(result === null ? null : result.length, null, 'a file that never ends is over any limit');
    assert.equal(calls, 4, 'three pieces of 1 MiB and one of the 6 bytes that make the limit exceeded');
  });
});

describe('the request file', () => {
  const failure = async (space: Workspace, pattern: RegExp, extra: readonly string[] = []): Promise<string> => {
    const message = await refused(argvOf(space, extra));
    assert.match(message, pattern);
    assert.equal(await exists(space.out), false, 'a refused request leaves no output folder behind');
    return message;
  };

  it('must exist, and says so as 不存在', async () => {
    const space = await fresh();
    await rm(space.input);
    const message = await failure(space, /^不存在：无法读取 --input 指的文件（ENOENT）。/u);
    assert.ok(!message.includes(space.dir), 'the path is not repeated');
  });

  it('must be a regular file, not a folder and not a link', async () => {
    const space = await fresh();
    await rm(space.input);
    await mkdir(space.input);
    await failure(space, /^参数无效：--input 不是常规文件。/u);
    const linked = await fresh();
    const target = join(linked.dir, 'target.json');
    await writeFile(target, JSON.stringify(mixedRequest));
    await rm(linked.input);
    await symlink(target, linked.input);
    await failure(linked, /^参数无效：无法读取 --input 指的文件（ELOOP）。/u);
  });

  it('must not be over the size of the largest request, 32 MiB, and is not read when it is', async () => {
    assert.equal(MAX_BODY_BYTES, 32 * 1024 * 1024);
    const space = await fresh();
    await truncate(space.input, MAX_BODY_BYTES + 1);
    await failure(space, /^参数无效：--input 超过 33554432 字节的上限（一个请求的上限）。/u);
  });

  it('must be UTF-8 text, and may start with a byte order mark', async () => {
    const space = await fresh();
    await writeFile(space.input, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    await failure(space, /^参数无效：--input 指的文件不是合法的 UTF-8 文本。/u);
    const marked = await fresh(`﻿${JSON.stringify(noulRequest)}`);
    const result = await run(argvOf(marked));
    assert.equal(result.code, 0, result.stderr.join('\n'));
  });

  it('must be JSON without a repeated name, and an object', async () => {
    await failure(await fresh('{ not json'), /^参数无效：--input 的文件不是合法 JSON。/u);
    await failure(await fresh(''), /^参数无效：--input 的文件不是合法 JSON。/u);
    await failure(await fresh('{"state":"x","questions":{"q":{"type":"noul","instructions":"a"},"q":{"type":"noul","instructions":"b"}}}'), /^参数无效：--input 的文件里同一个对象有重复的键/u);
    await failure(await fresh('[1,2]'), /^参数无效：--input 的文件必须是 JSON 对象。/u);
    await failure(await fresh('"text"'), /^参数无效：--input 的文件必须是 JSON 对象。/u);
  });

  it('may hold state, questions and model, and refuses any other field, a key in particular, without naming its value', async () => {
    const space = await fresh({ ...noulRequest, apiKey: MARKERS.key });
    const message = await failure(space, /^参数无效：--input 的文件有不认识的字段（只认 state、questions、model）。/u);
    assert.ok(message.includes('密钥不能写进文件'), message);
    assert.ok(!message.includes(MARKERS.key), message);
    await failure(await fresh({ ...noulRequest, endpoint: 'https://example.invalid/' }), /不认识的字段/u);
  });

  it('is checked as a request before anything is sent, and the message does not repeat the content', async () => {
    for (const request of [{ state: 'x', questions: {} }, { state: MARKERS.state, questions: { q: { type: 'noul', instructions: '', criteria: { true: MARKERS.description } } } }, { questions: noulRequest.questions }, { state: 'x', questions: { [MARKERS.instructions + ' id']: noulRequest.questions.matches } }]) {
      const space = await fresh(request);
      const message = await failure(space, /^参数无效：/u);
      for (const marker of Object.values(MARKERS)) assert.ok(!message.includes(marker), message);
    }
  });
});

describe('the output folder', () => {
  it('may not be a file or a link', async () => {
    const space = await fresh();
    await writeFile(space.out, 'a file');
    assert.match(await refused(argvOf(space)), /^参数无效：--out 指的路径已经存在，但不是目录。/u);
    const linked = await fresh();
    const real = join(linked.dir, 'real');
    await mkdir(real);
    await symlink(real, linked.out);
    assert.match(await refused(argvOf(linked)), /^参数无效：--out 指的路径已经存在，但不是目录。/u);
    assert.deepEqual(await readdir(real), []);
  });

  it('is not written over: an answers.json that is there ends the run before anything is sent', async () => {
    const space = await fresh();
    await mkdir(space.out);
    await writeFile(join(space.out, 'answers.json'), 'earlier answer');
    const message = await refused(argvOf(space));
    assert.match(message, /^已被占用：--out 目录里已经有一份 answers.json。/u);
    assert.equal(await readFile(join(space.out, 'answers.json'), 'utf8'), 'earlier answer');
    assert.equal(await exists(join(space.out, 'audit.jsonl')), false);
  });

  it('keeps one audit file for the runs that share it, and refuses to start when it cannot be written', async () => {
    const space = await fresh();
    await mkdir(join(space.out, 'audit.jsonl'), { recursive: true });
    const message = await refused(argvOf(space));
    assert.match(message, /^参数无效：审计文件打不开或写不进/u);
    assert.ok(message.includes('没有发出任何请求'), message);
  });
});

describe('a call that goes through', () => {
  it('sends the request of the file to the fixed address and writes the answers and the audit file', async () => {
    const space = await fresh();
    const result = await run(argvOf(space));
    assert.equal(result.code, 0, result.stderr.join('\n'));
    assert.deepEqual(result.stderr, []);
    assert.equal(result.calls.length, 1);
    const sent = result.calls[0]!;
    assert.equal(sent.url, JEV_ENDPOINT);
    assert.equal(sent.headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(JSON.parse(sent.body), { state: mixedRequest.state, model: 'jev-latest', questions: mixedRequest.questions });
    assert.deepEqual(Object.keys(JSON.parse(sent.body).questions), ['zeta', 'alpha', 'mid']);
    assert.equal(sent.timeoutMs, 30_000);

    assert.deepEqual((await readdir(space.out)).sort(), ['answers.json', 'audit.jsonl']);
    const saved = JSON.parse(await readFile(join(space.out, 'answers.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(saved), ['model', 'model_version', 'status', 'decided_by', 'answers', 'usage']);
    assert.equal(saved.model_version, 'jev-1.14.0');
    assert.equal(saved.status, '未确认');
    assert.equal(saved.decided_by, '模型');
    assert.deepEqual(Object.keys(saved.answers as object), ['zeta', 'alpha', 'mid']);
    assert.ok((await readFile(join(space.out, 'answers.json'), 'utf8')).endsWith('}\n'));

    const audit = await linesOf(join(space.out, 'audit.jsonl'));
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0]!.attempt, audit[0]!.http_status, audit[0]!.error_code, audit[0]!.model, audit[0]!.questions, audit[0]!.question_types], [1, 200, null, 'jev-1.14.0', 3, ['noul', 'choice', 'score']]);

    for (const name of ['answers.json', 'audit.jsonl']) assert.equal((await stat(join(space.out, name))).mode & 0o777, 0o600, name);
    assert.equal((await stat(space.out)).mode & 0o077, 0, 'the folder it made is closed to others');
  });

  it('shows the answers, the model version and the disclosure in Chinese', async () => {
    const space = await fresh();
    const result = await run(argvOf(space));
    assert.deepEqual(result.stdout, [
      'Jev 判断完成：3 题。',
      '模型版本：jev-1.14.0；状态：未确认；决定者：模型。',
      'zeta（是非题）：答“是”的概率 0.75',
      'alpha（单选题）：选 b，概率 0.7；各项 b 0.7、a 0.3、none 0；confidence 0.55',
      'mid（评分题）：期望等级 1.6；各级概率 0 0、1 0.4、2 0.6；confidence 0.5',
      '用量（token，模型计费的文本单位）：输入 120、输出 30。',
      `答案写入 ${join(space.out, 'answers.json')}，审计记录写入 ${join(space.out, 'audit.jsonl')}。`,
      '这是模型判断，状态未确认；没有为任何用途校准过阈值，confidence 是概率的集中度而不是答对的概率；只作核对时的参考，不当作已核准的结论。',
    ]);
  });

  it('does not print the key even when the output folder is named after it', async () => {
    const space = await fresh(noulRequest);
    const named = { ...space, out: join(space.dir, KEY) };
    const result = await run(argvOf(named));
    assert.equal(result.code, 0, result.stderr.join('\n'));
    assert.ok(!result.stdout.join('\n').includes(KEY));
    assert.ok(result.stdout.join('\n').includes('[REDACTED]'));
    assert.ok(await exists(join(named.out, 'answers.json')), 'the files are written where they were asked for');
  });

  it('asks the model of the --model option, else of the file, else jev-latest', async () => {
    const modelSent = async (request: unknown, extra: readonly string[]): Promise<string> => {
      const result = await run(argvOf(await fresh(request), extra));
      assert.equal(result.code, 0, result.stderr.join('\n'));
      return JSON.parse(result.calls[0]!.body).model as string;
    };
    assert.equal(await modelSent(noulRequest, []), 'jev-latest');
    assert.equal(await modelSent({ ...noulRequest, model: 'jev-1.13.0' }, []), 'jev-1.13.0');
    assert.equal(await modelSent({ ...noulRequest, model: 'jev-1.13.0' }, ['--model', 'jev-1.14.0']), 'jev-1.14.0');
    assert.equal(await modelSent(noulRequest, ['--model', 'jev-1.14.0']), 'jev-1.14.0');
  });

  it('refuses a model that is not a model name before sending', async () => {
    assert.match(await refused(argvOf(await fresh(noulRequest), ['--model', 'a b'])), /^参数无效：/u);
  });

  it('gives the time limit to the client, at its two edges', async () => {
    for (const limit of ['1', '4321', '600000']) {
      const result = await run(argvOf(await fresh(noulRequest), ['--timeout-ms', limit]));
      assert.equal(result.code, 0, result.stderr.join('\n'));
      assert.equal(result.calls[0]!.timeoutMs, Number(limit));
    }
  });

  it('answers a request of each type', async () => {
    for (const request of [noulRequest, choiceRequest, scoreRequest]) {
      const space = await fresh(request);
      const result = await run(argvOf(space));
      assert.equal(result.code, 0, result.stderr.join('\n'));
      assert.equal(result.stdout.length, 6);
    }
  });

  it('puts the state, the instructions, the descriptions and the key in no output but the request, and the key in none', async () => {
    const space = await fresh(markerRequest());
    const result = await run(argvOf(space), { stdin: `${KEY}\n${SECOND_LINE}\n` });
    assert.equal(result.code, 0, result.stderr.join('\n'));
    const audit = await readFile(join(space.out, 'audit.jsonl'), 'utf8');
    const answers = await readFile(join(space.out, 'answers.json'), 'utf8');
    const shown = [...result.stdout, ...result.stderr].join('\n');
    for (const [name, text] of Object.entries({ shown, audit, answers })) {
      for (const marker of [MARKERS.key, SECOND_LINE, MARKERS.state, MARKERS.instructions, MARKERS.description]) assert.ok(!text.includes(marker), `${name} holds ${marker}`);
    }
    for (const marker of Object.values(MARKERS)) assert.ok(!audit.includes(marker), `the audit holds ${marker}`);
    assert.ok(shown.includes(MARKERS.option), 'the options of a single-choice question are part of its answer');
    assert.ok(answers.includes(MARKERS.level), 'the legend of a scale is part of its answer');
  });
});

describe('a call that does not go through', () => {
  const marked = async (steps: readonly Step[]): Promise<{ result: Run; space: Workspace }> => {
    const space = await fresh(markerRequest());
    return { result: await run(argvOf(space), { steps, stdin: `${KEY}\n` }), space };
  };
  const assertQuiet = async (result: Run, space: Workspace): Promise<string> => {
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    assert.equal(result.stderr.length, 1, result.stderr.join('\n'));
    assert.match(result.stderr[0]!, FORM);
    assert.equal(await exists(join(space.out, 'answers.json')), false, 'no answers are written');
    const audit = await readFile(join(space.out, 'audit.jsonl'), 'utf8');
    for (const text of [result.stderr[0]!, audit]) for (const marker of Object.values(MARKERS)) assert.ok(!text.includes(marker), `${marker} in ${text.slice(0, 120)}`);
    return result.stderr[0]!;
  };

  it('says 无权限 for 401 and 403, writes no answers and records the attempt', async () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden']] as const) {
      const { result, space } = await marked([text(status, `denied ${MARKERS.state}`)]);
      const message = await assertQuiet(result, space);
      assert.ok(message.startsWith('无权限：'), message);
      assert.equal(result.calls.length, 1);
      assert.deepEqual((await linesOf(join(space.out, 'audit.jsonl'))).map((line) => [line.http_status, line.error_code]), [[status, code]]);
    }
  });

  it('says 参数无效 for 400, 413 and 422 without repeating the request the service echoed', async () => {
    for (const status of [400, 413, 422]) {
      const { result, space } = await marked([(request) => text(status, request.body)]);
      const message = await assertQuiet(result, space);
      assert.ok(message.startsWith('参数无效：'), message);
      assert.equal(result.calls.length, 1);
    }
  });

  it('sends again once after a 429 or 529 and then says 暂时不可用', async () => {
    const { result, space } = await marked([text(429), text(429)]);
    const message = await assertQuiet(result, space);
    assert.ok(message.startsWith('暂时不可用：Jev 服务限流（HTTP 429）'), message);
    assert.ok(message.includes('重试了一次'), message);
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.waits, [2000]);
    assert.deepEqual((await linesOf(join(space.out, 'audit.jsonl'))).map((line) => [line.attempt, line.error_code]), [[1, 'rate_limited'], [2, 'rate_limited']]);
  });

  it('goes through after one 529', async () => {
    const space = await fresh(noulRequest);
    const result = await run(argvOf(space), { steps: [text(529, '', { 'retry-after': '1' }), okStep] });
    assert.equal(result.code, 0, result.stderr.join('\n'));
    assert.equal(result.calls.length, 2);
    assert.deepEqual(result.waits, [1000]);
    assert.equal((await linesOf(join(space.out, 'audit.jsonl'))).length, 2);
  });

  it('does not send again after a timeout or a broken connection, and says the service may have billed', async () => {
    for (const cause of [new JevTransportError('timeout'), new JevTransportError('connection', 'ECONNRESET'), new Error(MARKERS.state)]) {
      const { result, space } = await marked([cause, okStep]);
      const message = await assertQuiet(result, space);
      assert.ok(message.startsWith('暂时不可用：'), message);
      assert.ok(message.includes('没有重发') && message.includes('可能已经'), message);
      assert.equal(result.calls.length, 1);
    }
  });

  it('says 暂时不可用 for an answer that is not valid, and writes none of it', async () => {
    const { result, space } = await marked([(request) => json(200, { ...answerBody(request), answers: { q_noul: { type: 'noul', noul: 7 } } })]);
    const message = await assertQuiet(result, space);
    assert.ok(message.startsWith('暂时不可用：'), message);
    assert.equal(result.calls.length, 1);
  });

  it('throws an answer away that holds the key', async () => {
    const { result, space } = await marked([(request) => json(200, { ...answerBody(request), debug: KEY })]);
    const message = await assertQuiet(result, space);
    assert.ok(message.startsWith('暂时不可用：Jev 的应答里出现了 API 密钥'), message);
    assert.ok(!(await readFile(join(space.out, 'audit.jsonl'), 'utf8')).includes(KEY));
  });

  it('shows the answers it got when answers.json appeared in the meantime, and does not write over it', async () => {
    const space = await fresh(noulRequest);
    const result = await run(argvOf(space), {
      steps: [
        async (request) => {
          await writeFile(join(space.out, 'answers.json'), 'written by someone else');
          return json(200, answerBody(request));
        },
      ],
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout[0], 'Jev 判断完成：1 题。');
    assert.ok(result.stdout.at(-2)!.startsWith('答案没能写进 '), result.stdout.join('\n'));
    assert.equal(result.stderr.length, 1);
    assert.match(result.stderr[0]!, /^已被占用：写答案时 answers.json 已经出现。上面已经列出这次的答案；服务可能已经计费，请不要直接重发/u);
    assert.equal(await readFile(join(space.out, 'answers.json'), 'utf8'), 'written by someone else');
  });
});

describe('the tool as a process', () => {
  // Only what ends before a request is made: the tests never open a connection.
  const env = { NODE_NO_WARNINGS: '1', JEV_API_KEY: 'ENVIRONMENT-KEY-MARKER-0123456789' };
  const spawn = (args: readonly string[], input: string): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [TOOL, ...args], { input, encoding: 'utf8', env, timeout: 60_000 });
    assert.ok(!result.error, String(result.error));
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('prints the usage and exits 0', () => {
    for (const args of [[], ['--help']]) {
      const result = spawn(args, '');
      assert.equal(result.status, 0);
      assert.ok(result.stdout.startsWith('用法: node '), result.stdout);
      assert.equal(result.stderr, '');
    }
  });

  it('does not read the key from the environment: with an empty standard input it asks for the key', async () => {
    const space = await fresh();
    const result = spawn(argvOf(space), '');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith('参数无效：已传入 --key-stdin 但标准输入首行为空；这是本地检查，没有发出任何请求。'), result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(env.JEV_API_KEY));
    assert.equal(await exists(space.out), false);
  });

  it('refuses the placeholder the client did not expand, with exit 1 and the message on standard error', async () => {
    const result = spawn(argvOf(await fresh()), '%JEV_API_KEY%\n');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith('无权限：标准输入第一行还是占位符 %JEV_API_KEY%，客户端没有把它展开成密钥；这是本地检查，没有发出任何请求。'), result.stderr);
    assert.ok(result.stderr.endsWith('。\n'));
  });

  it('reads no more than the longest key from its standard input', async () => {
    const space = await fresh();
    const result = spawn(argvOf(space), 'x'.repeat(5000));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(`参数无效：标准输入第一行超过 ${MAX_KEY_LENGTH} 字节，不是密钥；这是本地检查，没有发出任何请求。`), result.stderr);
    assert.equal(await exists(space.out), false);
  });

  it('takes the first line of its standard input and goes on to the request file, which ends this run before any request', async () => {
    const space = await fresh();
    await rm(space.input);
    const result = spawn(argvOf(space), `${KEY}\n${'x'.repeat(3000)}\n`);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith('不存在：无法读取 --input 指的文件（ENOENT）。'), result.stderr);
    assert.ok(!result.stderr.includes(KEY));
  });

  it('refuses a key on the command line and does not print it', () => {
    const result = spawn(['ask', '--api-key', 'KEY-ON-THE-COMMAND-LINE-MARKER'], '');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('禁止通过命令行参数 --api-key 传入密钥'), result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes('KEY-ON-THE-COMMAND-LINE-MARKER'));
  });
});
