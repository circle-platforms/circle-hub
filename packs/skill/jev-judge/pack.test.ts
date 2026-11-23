import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPackDirectory, validatePack } from '../../../hub/runs/api.ts';
import { parseToolCliDeclaration } from '../../../scripts/real/guard-lib.ts';
import { scanSkillPack } from '../../../scripts/real/skill-script-safety.ts';
import { verifyCliInvocations } from '../../../scripts/real/verify-tool-cli.ts';
import type { CliProbe } from '../../../scripts/real/verify-tool-cli.ts';
import { isPackFile, manifestProblems, stagePack } from '../../workflow/case-review/packaging.ts';
import * as pack from './api.ts';
import * as jev from './functions/modules/jev-client/index.ts';
import { runJevJudgeCli } from './tools/jev-judge.ts';
import { KEY, noulRequest, scripted } from './testing/synthetic.ts';

const PACK_DIR = fileURLToPath(new URL('./', import.meta.url));
const PACK_FILES = [
  'SKILL.md',
  'examples/choice-command-select.json',
  'examples/choice-step-fidelity.json',
  'examples/noul-command-match.json',
  'examples/score-command-list.json',
  'functions/modules/jev-client/client.ts',
  'functions/modules/jev-client/files.ts',
  'functions/modules/jev-client/index.ts',
  'functions/modules/jev-client/redact.ts',
  'functions/modules/jev-client/transport.ts',
  'functions/modules/jev-client/types.ts',
  'functions/modules/jev-client/validate.ts',
  'skill.json',
  'tools/jev-judge.cli.json',
  'tools/jev-judge.ts',
];

let root = '';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jev-pack-test-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (rel: string): Promise<string> => readFile(join(PACK_DIR, rel), 'utf8');

describe('the pack and its manifest', () => {
  it('is jev-judge 1.0.0, a skill, with the files of this list and a manifest that is current', async () => {
    const manifest = JSON.parse(await read('pack.json')) as { schema: string; id: string; version: string; kind: string; files: Array<{ path: string }> };
    assert.deepEqual([manifest.schema, manifest.id, manifest.version, manifest.kind], ['pack@1', 'jev-judge', '1.0.0', 'skill']);
    assert.deepEqual(manifest.files.map((entry) => entry.path), PACK_FILES);
    assert.deepEqual(await manifestProblems(PACK_DIR), [], 'run node packs/skill/jev-judge/api.ts sign after a change to a pack file');
  });

  it('lists every file that is a pack file, and tests, the readme and the test helpers are not', async () => {
    const onDisk = (await readdir(PACK_DIR, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(PACK_DIR.length))
      .filter((rel) => rel !== 'pack.json' && isPackFile(rel))
      .sort();
    assert.deepEqual(onDisk, PACK_FILES);
    for (const rel of ['README.md', 'api.ts', 'examples.test.ts', 'pack.test.ts', 'testing/synthetic.ts', 'tools/jev-judge.test.ts', 'functions/modules/jev-client/client.test.ts']) {
      assert.equal(isPackFile(rel), false, rel);
    }
  });

  it('exports the module through api.ts, with the pack id and directory', () => {
    assert.equal(pack.PACK_ID, 'jev-judge');
    assert.equal(pack.PACK_DIR, PACK_DIR);
    for (const name of Object.keys(jev)) assert.equal((pack as Record<string, unknown>)[name], (jev as Record<string, unknown>)[name], name);
  });

  it('declares one module, jev-client, and no parser', async () => {
    const skill = JSON.parse(await read('skill.json')) as { schema: string; parsers: unknown[]; modules: Array<{ id: string; title: string; family: string }> };
    assert.equal(skill.schema, 'skill@1');
    assert.deepEqual(skill.parsers, []);
    assert.deepEqual(skill.modules.map((module) => module.id), ['jev-client']);
  });

  it('passes the static scan of the scripts of a skill', () => {
    const safety = scanSkillPack(PACK_DIR);
    assert.deepEqual(safety.issues, [], JSON.stringify(safety.issues));
    assert.ok(safety.files >= 6, String(safety.files));
  });

  it('is a pack the Hub accepts when it is staged, read and validated', async () => {
    const staged = join(root, 'staged-validate');
    await stagePack(PACK_DIR, staged);
    const read = await readPackDirectory(staged);
    assert.equal(read.ok, true, JSON.stringify(read));
    if (!read.ok) throw new Error('unreachable');
    const validation = await validatePack(read.pack);
    assert.equal(validation.ok, true, JSON.stringify(validation));
  });
});

describe('the tool declaration', () => {
  it('declares ask with the key on the standard input as %JEV_API_KEY%, and the options of the tool', async () => {
    const declaration = JSON.parse(await read('tools/jev-judge.cli.json')) as { schema: string; stdin: string[]; subcommands: Record<string, string[]>; options: Array<{ name: string; required: boolean; kind: string }>; forms: unknown[] };
    assert.equal(declaration.schema, 'tool-cli@2');
    assert.deepEqual(declaration.stdin, []);
    assert.deepEqual(declaration.subcommands, { ask: ['%JEV_API_KEY%'] });
    assert.deepEqual(declaration.forms, []);
    const parsed = parseToolCliDeclaration(declaration);
    assert.deepEqual(parsed.subcommandStdin, { ask: ['%JEV_API_KEY%'] });

    const help: string[] = [];
    assert.equal(await runJevJudgeCli(['--help'], { stdout: (line) => void help.push(line) }), 0);
    const named = [...new Set([...help.join('\n').matchAll(/--([a-z][a-z0-9-]*)/gu)].map((match) => match[1]!))].sort();
    assert.deepEqual(declaration.options.map((option) => option.name).sort(), named);
  });

  it('marks as required exactly the options the tool refuses to run without', async () => {
    const declaration = JSON.parse(await read('tools/jev-judge.cli.json')) as { options: Array<{ name: string; required: boolean; kind: string }> };
    const full: Record<string, string | true> = { input: 'request.json', out: 'out', model: 'jev-latest', 'timeout-ms': '1000', 'key-stdin': true };
    assert.deepEqual(declaration.options.filter((option) => option.kind === 'boolean').map((option) => option.name), ['key-stdin']);
    for (const option of declaration.options) {
      const argv = ['ask'];
      for (const [name, value] of Object.entries(full)) {
        if (name === option.name) continue;
        argv.push(`--${name}`);
        if (value !== true) argv.push(value);
      }
      const { transport, calls } = scripted([]);
      const errors: string[] = [];
      // The request file does not exist: every run that gets as far as reading it ends there, before a request is made.
      const code = await runJevJudgeCli(argv, { stdinText: `${KEY}\n`, stderr: (line) => void errors.push(line), transport });
      assert.equal(calls.length, 0);
      assert.equal(code, 1);
      if (option.required) assert.ok(errors[0]!.includes(`缺少 --${option.name}`), `${option.name}: ${errors[0]}`);
      else assert.ok(errors[0]!.startsWith('不存在：无法读取 --input'), `${option.name}: ${errors[0]}`);
    }
  });

  it('is exercised by real processes that end before any request: an empty standard input and the placeholder left in', async () => {
    const staged = join(root, 'staged-cli');
    await stagePack(PACK_DIR, staged);
    const work = join(root, 'cli-work');
    await mkdir(work);
    const input = join(work, 'request.json');
    await writeFile(input, JSON.stringify(noulRequest));
    const probe: CliProbe = {
      argv: ['ask', '--input', input, '--out', join(work, 'out'), '--key-stdin'],
      cwd: work,
      subcommand: 'ask',
      stdinValues: ['%JEV_API_KEY%'],
      complete: { status: 1, stdout: '', stderr: '无权限：标准输入第一行还是占位符 %JEV_API_KEY%，客户端没有把它展开成密钥；这是本地检查，没有发出任何请求。请使用者在客户端用 /secrets JEV_API_KEY 存好密钥后重试。\n' },
      empty: { status: 1, stdout: '', stderr: '参数无效：已传入 --key-stdin 但标准输入首行为空；这是本地检查，没有发出任何请求。请把 JEV_API_KEY 写进标准输入第一行（命令里写占位符 %JEV_API_KEY%）。\n' },
    };
    const verified = verifyCliInvocations(staged, new Set<string>(), { 'tools/jev-judge.ts': [probe] });
    assert.deepEqual(verified, { declarations: 1, invocations: 1, processes: 2 });
  });
});

describe('SKILL.md and README.md', () => {
  it('open with the frontmatter every skill a client loads has: its name, and in Chinese when it applies', async () => {
    const text = await read('SKILL.md');
    const head = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/u.exec(text);
    assert.ok(head, 'frontmatter');
    assert.equal(head[1], 'jev-judge');
    const description = head[2]!;
    assert.match(description, /\p{Script=Han}/u);
    assert.match(description, /时使用|内嵌使用|用于/u);
    assert.doesNotMatch(description, /[A-Za-z]+ [A-Za-z]+ [A-Za-z]+/u, 'no English sentence');
    assert.ok(description.length <= 1024);
  });

  it('give the command the guard lets through: the options as --option value, the key on the standard input as the placeholder', async () => {
    const skill = await read('SKILL.md');
    assert.ok(skill.includes("--key-stdin <<'EOF'\n%JEV_API_KEY%\nEOF"), 'the here-document with the placeholder');
    assert.doesNotMatch(skill, /--(?:input|out|model|timeout-ms)=/u);
    for (const text of [skill, await read('README.md')]) {
      assert.ok(text.includes('/secrets JEV_API_KEY'));
      assert.ok(text.includes('https://api.typesafe.ai/v1/systemone'));
      assert.ok(text.includes('未确认'));
    }
  });

  it('say that the workflow which offers Jev carries the client embedded and needs no installed skill, and that the command line needs the guard and allowed content', async () => {
    const skill = await read('SKILL.md');
    for (const [name, text] of [['SKILL.md', skill], ['README.md', await read('README.md')]] as const) {
      for (const phrase of ['内嵌', '守卫', '不需要装本技能', '只有所有者允许的内容', '2026-11-23']) assert.ok(text.includes(phrase), `${name}: ${phrase}`);
      assert.doesNotMatch(text, /手动选 Jev 时用它|选了 Jev 才用/u, name);
    }
    const head = /^---\nname: [^\n]+\ndescription: ([^\n]+)\n---\n/u.exec(skill)!;
    const description = head[1]!;
    assert.match(description, /守卫/u);
    assert.match(description, /不需要装本技能/u);
    assert.doesNotMatch(description, /手动选/u);
    const body = skill.slice(head[0].length);
    for (const phrase of ['内嵌', '守卫', '不需要装本技能', '只有所有者允许的内容']) assert.ok(body.includes(phrase), `the body of SKILL.md: ${phrase}`);
    const manifest = JSON.parse(await read('pack.json')) as { description: string };
    assert.match(manifest.description, /内嵌/u);
    assert.match(manifest.description, /已放行/u);
  });

  it('say that the roots a certificate is checked against are those bundled with Node, not the operating system store', async () => {
    const readme = await read('README.md');
    for (const phrase of ['rejectUnauthorized: true', 'NODE_TLS_REJECT_UNAUTHORIZED=0', 'Node 自带的根证书', '不是操作系统的证书库']) assert.ok(readme.includes(phrase), phrase);
    const transport = (await read('functions/modules/jev-client/transport.ts')).replace(/\s*\n\/\/\s*/gu, ' ');
    assert.ok(transport.includes("the roots that count are the ones bundled with Node, not the operating system's store"), 'the comment of the transport says so');
    for (const [name, text] of [['README.md', readme], ['SKILL.md', await read('SKILL.md')], ['transport.ts', transport]] as const) assert.doesNotMatch(text, /系统信任链|system trust/iu, name);
  });

  it('list the error codes of the module, all and only', async () => {
    const readme = await read('README.md');
    const rows = [...readme.matchAll(/^\| `([a-z_]+)` \|/gmu)].map((match) => match[1]!).filter((name) => name !== 'code');
    assert.deepEqual([...rows].sort(), [...jev.JEV_ERROR_CODES].sort());
  });

  it('say what the answers are and where the limits are', async () => {
    const skill = await read('SKILL.md');
    for (const phrase of ['模型判断', '没有为任何用途校准过阈值', '不当作已核准的结论', '2026-11-23', '429', '529', '未确认', 'decided_by', '超时和连接中断的请求不重发']) assert.ok(skill.includes(phrase), phrase);
  });

  it('hold no local path, address, account or build name, and no key', async () => {
    const files = ['SKILL.md', 'README.md', ...PACK_FILES.filter((rel) => rel.endsWith('.json'))];
    for (const rel of files) {
      const text = await read(rel);
      assert.doesNotMatch(text, /\/Users\/|\/home\/|\/private\/|\/var\/folders|~\/|[A-Za-z]:\\/u, rel);
      assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/u, rel);
      assert.doesNotMatch(text, /\b(?:Rel|Beta)_[A-Za-z0-9_.-]+/u, rel);
      assert.doesNotMatch(text, /@[A-Za-z0-9-]+\.[A-Za-z]{2,}/u, rel);
      assert.doesNotMatch(text, /\bsk-[A-Za-z0-9]{8,}|\bBearer [A-Za-z0-9._~+/-]{8,}/u, rel);
    }
  });
});
