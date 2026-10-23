import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, appendFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { test } from 'node:test';
import { responseStrings, runSmoke, type SmokeCommand } from './smoke-connectors.ts';

const text = 'Synthetic confidential response "quoted"\nsecond line';
const key = 'synthetic-request-key';
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
test('extracts JSON values and HTML text, excluding digests, short values and request-key echoes', () => {
  assert.deepEqual(responseStrings(JSON.stringify({ title: text, nested: ['short', 'd'.repeat(64), key] }), key), [text]);
  assert.deepEqual(responseStrings('<h1>Synthetic confidential title</h1>\n<p>Another synthetic paragraph</p>', key), ['Synthetic confidential title', 'Another synthetic paragraph']);
});

async function scenario(mode: 'clean' | 'command' | 'escaped' | 'service' | 'failure' | 'export' | 'rotate' | 'corrupt' | 'events', html = false) {
  const dir = await mkdtemp(join(tmpdir(), 'smoke-synthetic-')); const logs = join(dir, 'logs'); await mkdir(logs);
  const outLog = join(logs, 'hub.out.log'); const errLog = join(logs, 'hub.err.log');
  await writeFile(outLog, `${text}\n`); await writeFile(errLog, ''); // Old content is outside this smoke window.
  const bytes = html ? `<h1>${text}</h1><p>${key}</p>` : JSON.stringify({ title: text, request: key }); const sha = digest(bytes);
  const printed: string[] = []; const exported: string[] = [];
  const run: SmokeCommand = async (args) => {
    if (args[0] === 'resource') {
      assert.deepEqual(args, ['resource', 'read', 'res_synthetic', 'document', key, '--events']);
      if (mode === 'service') await appendFile(errLog, JSON.stringify({ message: text }));
      if (mode === 'rotate') await writeFile(outLog, '');
      if (mode === 'failure') return { code: 1, stdout: `demo-system@1.0.0/document：失败（SOURCE_UNAVAILABLE）\n读清单 ${'a'.repeat(64)}\n`, stderr: text };
      return { code: 0, stdout: `demo-system@1.0.0/document：读取完成\n产物 original ${sha} ${Buffer.byteLength(bytes)} 字节\n读清单 ${'a'.repeat(64)}\n`, stderr: mode === 'events' && args.includes('--events') ? '连接器：read_failed ' + JSON.stringify({ reason: text }) : mode === 'command' ? text : mode === 'escaped' ? JSON.stringify(text) : key };
    }
    assert.equal(args[0], 'original'); assert.equal(args[1], 'export');
    const target = args[args.indexOf('--out') + 1]; exported.push(target);
    assert.equal((await stat(dirname(target))).mode & 0o777, 0o700);
    if (mode === 'export') return { code: 1, stdout: '', stderr: text };
    await writeFile(target, mode === 'corrupt' ? `${bytes}extra` : bytes, { mode: 0o600 }); return { code: 0, stdout: '', stderr: '' };
  };
  try {
    const results = await runSmoke({ logs, reads: [`res_synthetic:document:${key}`], run, print: (line) => printed.push(line) });
    for (const target of exported) await assert.rejects(access(target));
    const output = printed.join('\n'); assert.ok(!output.includes(text)); assert.ok(!output.includes(key)); assert.ok(!output.includes(JSON.stringify(text)));
    assert.equal(printed.length, 1); assert.match(output, /demo-system@1\.0\.0\/document/);
    return results[0];
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('clean output passes, preexisting log content and key echoes do not count', async () => {
  const html = await scenario('clean', true); assert.equal(html.ok, true);
  const result = await scenario('clean'); assert.equal(result.ok, true); assert.equal(result.hits.command, 0); assert.equal(result.hits.service, 0); assert.equal(result.artifacts, 1);
});
test('raw and JSON-escaped command leaks and new service-log leaks fail without printing matches', async () => {
  for (const mode of ['command', 'escaped', 'service'] as const) for (const html of [false, true]) {
    const result = await scenario(mode, html); assert.equal(result.ok, false); assert.ok(result.hits.command + result.hits.service > 0);
  }
});
test('read failure, export failure and rotated logs are failures, never an empty successful check', async () => {
  for (const mode of ['failure', 'export', 'rotate', 'corrupt'] as const) assert.equal((await scenario(mode)).ok, false);
});


test('review 1: smoke requests connector events and detects response text inside a redacted-event channel', async () => {
  const result = await scenario('events'); assert.equal(result.ok, false); assert.ok(result.hits.command > 0);
});

async function inspectSynthetic(body: string | Buffer, options: { stderr?: string; exit?: number; stdout?: string; logs?: 'missing' | 'rotate'; exportFailure?: boolean; corrupt?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'smoke-review-')); const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body); const sha = createHash('sha256').update(bytes).digest('hex');
  const lines: string[] = []; const commands: string[][] = [];
  const out = join(root, 'hub.out.log'); const err = join(root, 'hub.err.log');
  await writeFile(out, 'previous'); if (options.logs !== 'missing') await writeFile(err, '');
  const run: SmokeCommand = async args => {
    commands.push(args);
    if (args[0] === 'resource') {
      if (options.logs === 'rotate') await writeFile(out, '');
      return { code: options.exit ?? 0, stdout: options.stdout ?? `demo-system@1.0.0/tree：读取完成\n产物 original ${sha} ${bytes.length} 字节\n读清单 ${'a'.repeat(64)}\n`, stderr: options.stderr ?? '' };
    }
    if (options.exportFailure) return { code: 1, stdout: '', stderr: 'synthetic export failure' };
    await writeFile(args.at(-1)!, options.corrupt ? Buffer.concat([bytes, Buffer.from('extra')]) : bytes);
    return { code: 0, stdout: '', stderr: '' };
  };
  try {
    const [result] = await runSmoke({ logs: root, reads: ['res_synthetic:tree:synthetic-key'], run, print: line => lines.push(line) });
    return { result: result!, output: lines.join('\n'), commands };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('review 2: attribute-only responses are checked and empty candidate sets never pass', async () => {
  const body = '<commands><menu name="synthetic-menu-alpha"><item name=synthetic-item-beta /></menu></commands>';
  const leaked = await inspectSynthetic(body, { stderr: 'synthetic-menu-alpha synthetic-item-beta' });
  assert.equal(leaked.result.ok, false); assert.ok(leaked.result.hits.command > 0); assert.ok(leaked.result.candidates >= 2);
  assert.ok(!leaked.output.includes('synthetic-menu-alpha'));
  for (const body of ['{"count":123}', '{"word":"short"}']) {
    const empty = await inspectSynthetic(body); assert.equal(empty.result.ok, false); assert.equal(empty.result.candidates, 0);
    assert.match(empty.output, /没有可核对的文字/); assert.match(empty.output, /下一步/);
  }
});

test('review 3: preflight rejects missing logs before a read and failures retain fixed actionable causes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smoke-preflight-')); let calls = 0;
  try {
    await assert.rejects(runSmoke({ logs: root, reads: ['res_synthetic:tree:key'], run: async () => { calls++; return { code: 0, stdout: '', stderr: '' }; }, print: () => {} }), /--logs/);
    assert.equal(calls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
  for (const [options, reason] of [
    [{ logs: 'rotate' as const }, /日志.*轮转|截短/],
    [{ exportFailure: true }, /导出失败/],
    [{ corrupt: true }, /摘要或大小不符/],
    [{ exit: 2, stdout: 'synthetic missing header', stderr: 'PRIVATE-SYNTHETIC-REASON' }, /没有输出.*读取行/],
  ] as const) {
    const checked = await inspectSynthetic('{"text":"synthetic-checkable-text"}', options);
    assert.equal(checked.result.ok, false); assert.match(checked.result.reason, reason); assert.match(checked.output, /下一步/);
    assert.doesNotMatch(checked.output, /PRIVATE-SYNTHETIC-REASON|失败（检查未完成）/);
  }
});

test('review 4: non-UTF8 responses need encoding-independent ASCII canaries', async () => {
  const value = 'synthetic-café-menu'; const body = Buffer.from(`<commands><menu name="${value}"/></commands>`, 'latin1');
  const unsupported = await inspectSynthetic(body); assert.equal(unsupported.result.ok,false);assert.equal(unsupported.result.candidates,0);
  const mixed=Buffer.from('<menu name="synthetic-ascii-canary" help="'+value+'"/>','latin1');
  const clean=await inspectSynthetic(mixed);assert.equal(clean.result.ok,true);assert.ok(clean.result.candidates>0);
  const leak=await inspectSynthetic(mixed,{stderr:'synthetic-ascii-canary'});assert.equal(leak.result.ok,false);assert.ok(leak.result.hits.command>0);
  assert.ok(!leak.output.includes(value));
});

test('closure GBK-only originals cannot pass a canary check against mojibake', async () => {
 const chinese='合成的合成的合成的';const body=Buffer.concat([Buffer.from('<p>'),Buffer.from('bacfb3c9b5c4'.repeat(3),'hex'),Buffer.from('</p>')]);
 const checked=await inspectSynthetic(body,{stderr:'连接器：read_failed '+JSON.stringify({reason:chinese})});
 assert.equal(checked.result.ok,false);assert.equal(checked.result.candidates,0);
 assert.match(checked.result.reason,/原件不是 UTF-8，没有与编码无关的文字可核对；下一步选择 UTF-8 文本读取/);
 assert.ok(!checked.output.includes(chinese));
});

test('c3 multibyte high bytes cannot be trimmed into fabricated ASCII canaries',async()=>{
 for(const markup of [(b:Buffer)=>Buffer.concat([Buffer.from('<p>'),b,Buffer.from('</p>')]),(b:Buffer)=>Buffer.concat([Buffer.from('<menu name='),b,Buffer.from('/>')])]){
  const value=Buffer.concat([Buffer.from([0xa0,0x41]),Buffer.from('BCDEFGHIJKLM')]);const body=markup(value);
  for(const encoding of ['gbk','gb18030','big5']) {
   const leaked=new TextDecoder(encoding,{fatal:true}).decode(body);const checked=await inspectSynthetic(body,{stderr:leaked});
   assert.equal(checked.result.ok,false,encoding);assert.equal(checked.result.candidates,0,encoding);
  }
 }
 const mixed=Buffer.concat([Buffer.from('<h1>synthetic-ascii-canary</h1><p>'),Buffer.from([0xa0,0x41]),Buffer.from('</p>')]);
 const checked=await inspectSynthetic(mixed);assert.equal(checked.result.ok,true);assert.match(checked.output,/非 UTF-8.*仅核对 ASCII/);
});
