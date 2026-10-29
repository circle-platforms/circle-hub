import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
// Unit tests without a database: trace and session ids, strict base64 and media types, escaping and the CSP hash, origin and
// host rules, request targets, admin notes, the body budget, console sessions, claim display order, terminal symbols, item
// cells and the counts line, the run of a record, JSON Pointers of schema issues, the answer to a skill parser's sandbox failure.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DISPLAY_ORDER } from '../../contracts/generated/protocol.ts';
import { DYNAMIC_TERMINAL, PARTITION, STATIC_TERMINAL } from '../../contracts/generated/vocabulary.ts';
import { accepted } from '../../contracts/src/fixtures.ts';
import { ListTaskPacksInput, StartRunInput } from '../../contracts/src/tools.ts';
import { LayerResult, ValidationResult, isUnknownTerminal, type Partitions } from '../../contracts/src/validation.ts';
import { VIEW_SYSTEM } from '../knowledge/api.ts';
import { SandboxError } from '../rules/api.ts';

import { parseTarget } from './app.ts';
import { SYMBOL, cellText, claimFields, terminalSymbol, terminalText } from './claims.ts';
import { CONTENT_SECURITY_POLICY, escapeHtml, href, html, page } from './console/html.ts';
import { SessionStore, cookie } from './console/session.ts';
import { BodyBudget, REFERRER_POLICY, allowedHosts, isLoopbackOrigin } from './http.ts';
import { MAX_ADMIN_NOTE, clipNote, describeError, describeInternalError, cleanStack, sanitizeStackLine } from './notes.ts';
import { runOfRecord } from './readers.ts';
import { countsLine } from './text.ts';
import { KNOWLEDGE_VIEW_SYSTEM, isExternalType, pointerOfPath, readsOutside, sandboxError, schemaErrors } from './tools.ts';
import { newTraceId, sessionIdOf, traceIdFrom } from './trace.ts';
import { base64Size, decodeBase64Strict, mediaTypeFor, structureOf } from './upload.ts';

test('traceparent: only a valid W3C header gives its trace id', () => {
  const id = '4bf92f3577b34da6a3ce929d0e0e4736';
  assert.equal(traceIdFrom(`00-${id}-00f067aa0ba902b7-01`), id);
  assert.equal(traceIdFrom(`01-${id}-00f067aa0ba902b7-01-future`), id, 'a later version may carry more fields');
  for (const bad of [
    undefined,
    '',
    `00-${id.toUpperCase()}-00f067aa0ba902b7-01`,
    `ff-${id}-00f067aa0ba902b7-01`,
    `00-${id}-00f067aa0ba902b7-01-extra`,
    `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    `00-${id}-${'0'.repeat(16)}-01`,
    `00-${id}-00f067aa0ba902b7`,
    ` 00-${id}-00f067aa0ba902b7-01`,
  ]) {
    assert.equal(traceIdFrom(bad), null, String(bad));
  }
  assert.equal(traceIdFrom([`00-${id}-00f067aa0ba902b7-01`, `00-${id}-00f067aa0ba902b7-01`]), null, 'two headers are ambiguous');
  const fresh = new Set(Array.from({ length: 50 }, () => newTraceId()));
  assert.equal(fresh.size, 50);
  for (const trace of fresh) assert.match(trace, /^(?!0{32})[0-9a-f]{32}$/);
});

test('session ids: printable ASCII is kept, anything else only as its digest', () => {
  assert.equal(sessionIdOf(undefined), null);
  assert.equal(sessionIdOf(''), null);
  assert.equal(sessionIdOf('sess-1'), 'sess-1');
  const digest = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
  assert.equal(sessionIdOf('会话 1'), digest('会话 1'));
  assert.equal(sessionIdOf('x'.repeat(201)), digest('x'.repeat(201)));
});

test('base64 is decoded strictly: one text for one byte string', () => {
  assert.deepEqual(decodeBase64Strict('QQ=='), Buffer.from('A'));
  assert.deepEqual(decodeBase64Strict(''), Buffer.alloc(0));
  for (const bad of ['QR==', 'QQ=', 'Q===', 'QQ==QQ==', 'Q Q=', 'QQ-_']) assert.equal(decodeBase64Strict(bad), null, bad);
  for (const text of ['', 'QQ==', 'QUI=', 'QUJD', Buffer.alloc(1000, 7).toString('base64')]) assert.equal(base64Size(text), Buffer.from(text, 'base64').length);
});

test('media types: the caller\'s, then the file name, then the bytes', () => {
  const json = Buffer.from('{"a":[1]}');
  assert.equal(mediaTypeFor(json, 'text/plain; charset=utf-8', 'x.json'), 'text/plain; charset=utf-8');
  assert.equal(mediaTypeFor(Buffer.from('# x'), undefined, '说明.MD'), 'text/markdown');
  assert.equal(mediaTypeFor(json, undefined, undefined), 'application/json');
  assert.equal(mediaTypeFor(Buffer.from('{not json'), undefined, undefined), 'text/plain');
  assert.equal(mediaTypeFor(Buffer.from('<!DOCTYPE html><p>x'), undefined, undefined), 'text/html');
  assert.equal(mediaTypeFor(Buffer.from('<?xml version="1.0"?><a/>'), undefined, undefined), 'application/xml');
  assert.equal(mediaTypeFor(Buffer.from('普通文本\n第二行'), undefined, undefined), 'text/plain');
  assert.equal(mediaTypeFor(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), undefined, undefined), 'application/octet-stream');
  const parsers = createDefaultRegistry();
  const mindmap = Buffer.from(JSON.stringify({ root: { data: { id: 'n1', text: '根' }, children: [] } }));
  assert.equal(structureOf(parsers, mindmap, 'application/json')?.parser, 'kityminder@1');
  assert.equal(structureOf(parsers, mindmap, 'application/octet-stream'), null);
});

test('html escapes every interpolation once, keeps nested markup and encodes link parameters', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  const inner = html`<b>${'<i>'}</b>`;
  assert.equal(html`<p>${inner}${['<', '>']}${null}${undefined}${false}${0}</p>`.text, '<p><b>&lt;i&gt;</b>&lt;&gt;0</p>');
  assert.equal(href('/console/runs', { pack: 'a&b"c', cursor: undefined, empty: '' }), '/console/runs?pack=a%26b%22c');
  assert.equal(html`<a href="${href('/x', { q: '"><script>' })}">t</a>`.text, '<a href="/x?q=%22%3E%3Cscript%3E">t</a>');
});

test('the CSP allows exactly the page stylesheet by its hash, and nothing else', () => {
  const text = page({ title: 't', user: null, csrf: null }, html``).text;
  const style = /<style>([\s\S]*?)<\/style>/.exec(text)?.[1] ?? '';
  const hash = createHash('sha256').update(style, 'utf8').digest('base64');
  assert.ok(CONTENT_SECURITY_POLICY.includes(`style-src 'sha256-${hash}'`));
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /unsafe|script-src|\*/);
  assert.doesNotMatch(text, /<script/i);
});

test('loopback origins and the Host values the server answers to', () => {
  for (const origin of ['http://127.0.0.1:7420', 'http://localhost:6274', 'https://localhost', 'http://[::1]:8080', 'http://127.1.2.3:9']) assert.ok(isLoopbackOrigin(origin), origin);
  for (const origin of ['null', 'http://attacker.example', 'http://localhost.attacker.example', 'file://', 'ftp://127.0.0.1', 'http://127.0.0.1:7420/', 'http://user@127.0.0.1', 'http://0.0.0.0:1', 'http://127.1:80']) {
    assert.ok(!isLoopbackOrigin(origin), origin);
  }
  assert.deepEqual([...allowedHosts('127.0.0.1', 7420)].sort(), ['127.0.0.1:7420', 'localhost:7420']);
  assert.ok(allowedHosts('::1', 7420).has('[::1]:7420'));
  assert.ok(allowedHosts('127.0.0.1', 80).has('localhost'));
});

test('console sessions: nonces are used once and expire; sessions expire idle and absolutely; cookies are HttpOnly and SameSite=Strict', () => {
  let now = 1_000_000;
  const store = new SessionStore(() => now, { idleMs: 1000, absoluteMs: 5000, nonceMs: 100, maxSessions: 2, maxNonces: 2 });
  const nonce = store.issueNonce();
  assert.ok(store.takeNonce(nonce));
  assert.ok(!store.takeNonce(nonce), 'once');
  const late = store.issueNonce();
  now += 101;
  assert.ok(!store.takeNonce(late), 'expired');
  const [a, b, c] = [store.issueNonce(), store.issueNonce(), store.issueNonce()];
  assert.ok(!store.takeNonce(a) && store.takeNonce(b) && store.takeNonce(c), 'the oldest nonce is dropped beyond the limit');
  const session = store.open('token-a');
  assert.equal(store.get(session.id)?.token, 'token-a');
  now += 999;
  assert.ok(store.get(session.id), 'still within the idle limit');
  now += 1001;
  assert.equal(store.get(session.id), null, 'idle too long');
  const kept = store.open('token-b');
  for (let i = 0; i < 5; i++) {
    now += 900;
    assert.ok(store.get(kept.id), `used every 900 ms: still open after ${(i + 1) * 900} ms`);
  }
  now += 900;
  assert.equal(store.get(kept.id), null, 'the absolute limit ends a session in use');
  const first = store.open('1');
  store.open('2');
  store.open('3');
  assert.equal(store.get(first.id), null, 'the oldest session is dropped beyond the limit');
  assert.equal(cookie('n', 'v', '/console'), 'n=v; Path=/console; HttpOnly; SameSite=Strict');
  assert.equal(cookie('n', '', '/console', 0), 'n=; Path=/console; HttpOnly; SameSite=Strict; Max-Age=0');
});

test('claims are shown in DISPLAY_ORDER; unknown terminals have their own symbol, never success or failure', () => {
  const claim = {
    item: 'doc-1:n7',
    requirement: 'catalog',
    pointer: '/items/0/slots/findings/0',
    statement: { text: '参数超出范围', verdict: 'refute' as const, code: 'core.catalog.param_out_of_range' },
    qualifier: { nature: 'fact' as const, provenance: 'projected' as const, basis_rank: 'rule_over_observation' as const, source_role: 'expected' as const, marks: ['partial' as const] },
    grounds: [`tree:${'a'.repeat(64)}/catalog`],
    warrant: { producer: 'function' as const, id: 'catalog@1' },
    resolution: 'resolved' as const,
    validity: { status: 'valid' as const, bound: ['b'.repeat(64)], premises: [] },
  };
  const fields = claimFields(claim);
  assert.deepEqual(fields.map(([label]) => label), [...DISPLAY_ORDER]);
  assert.match(fields[1][1], /参数超出范围，反驳，core\.catalog\.param_out_of_range/);
  assert.equal(fields[2][1], '事实，观察上的规则');
  for (const terminal of STATIC_TERMINAL) {
    const layer = LayerResult.parse({ layer: 'static', terminal, ...(terminal === 'violation' ? { code: 'x' } : {}), ...(['unchecked', 'incomplete'].includes(terminal) ? { reason: 'no_check', missing:'合成观察尚未提供',exit:{action:'request',request_kind:'repair',audience:{user:'usr_00000000000000000000000001'},due:'2026-10-25T00:00:00.000Z'} } : {}) });
    const symbol = terminalSymbol(layer);
    if (isUnknownTerminal(layer)) assert.equal(symbol, SYMBOL.unknown, terminal);
    else assert.notEqual(symbol, SYMBOL.unknown, terminal);
    assert.match(terminalText(layer), /^.\s静态：/);
  }
  for (const terminal of DYNAMIC_TERMINAL) {
    const layer = LayerResult.parse({ layer: 'dynamic', terminal, ...(terminal === 'fail' ? { code: 'x' } : {}), ...(['no_verdict', 'not_run', 'incomplete'].includes(terminal) ? { reason: 'no_check', missing:'合成观察尚未提供',exit:{action:'request',request_kind:'repair',audience:{user:'usr_00000000000000000000000001'},due:'2026-10-25T00:00:00.000Z'} } : {}) });
    const symbol = terminalSymbol(layer);
    if (isUnknownTerminal(layer)) assert.equal(symbol, SYMBOL.unknown, terminal);
    else assert.ok(symbol !== SYMBOL.unknown, terminal);
    if (terminal === 'not_run' || terminal === 'no_verdict') assert.ok(symbol !== SYMBOL.pass && symbol !== SYMBOL.failure);
  }
});

test('the counts line names every partition in vocabulary order and the unknown count', () => {
  const empty = Object.fromEntries(PARTITION.map((p) => [p, []])) as unknown as Partitions;
  assert.equal(countsLine('accepted', empty), '回执：已受理；分区：已交付 0，已拒收 0，已隔离 0，未完成 0；未知 0');
  assert.equal(countsLine('not_accepted', undefined), '回执：未受理；没有分区（未受理的提交不分区）');
});

test('the counts line tells a declared skip from an item the submission did not cover', () => {
  const { partitions } = ValidationResult.parse(accepted);
  const line = countsLine('accepted', partitions);
  assert.match(line, /未完成 1（模型声明跳过 1）/);
  assert.doesNotMatch(line, /已交付 2（/, 'a partition whose items carry no reason shows none');
  const mixed = structuredClone(partitions);
  mixed.incomplete.push({ ...mixed.incomplete[0], item: 'doc-1:n10', reason: 'not_covered' });
  assert.match(countsLine('accepted', mixed), /未完成 2（模型声明跳过 1，提交未覆盖 1）/);
});

test('schema issues become protocol errors with JSON Pointers; an unknown key points at the key', () => {
  assert.equal(pointerOfPath(['a/b', 'c~d', 0]), '/a~1b/c~0d/0');
  const unknown = ListTaskPacksInput.safeParse({ knd: 'x', 'a/b': 1 });
  assert.ok(!unknown.success);
  assert.deepEqual(schemaErrors('list_task_packs', unknown.error).map((e) => e.path).sort(), ['/a~1b', '/knd']);
  const nested = StartRunInput.safeParse({ pack: 'p', inputs: { s: { reference: 'nope' } } });
  assert.ok(!nested.success);
  const errors = schemaErrors('start_run', nested.error);
  assert.ok(errors.every((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION' && e.fix && e.message.startsWith('参数不符合 start_run 的输入模式')));
  assert.ok(errors.some((e) => e.path?.startsWith('/inputs/s')));
});

test('request targets are parsed once and never throw: a path stays a path, an absolute target names its authority', () => {
  assert.equal(parseTarget('//')?.url.pathname, '//');
  assert.equal(parseTarget('//x/mcp')?.url.pathname, '//x/mcp');
  assert.equal(parseTarget('//x/mcp')?.authority, null);
  assert.equal(parseTarget('/console/runs?pack=a&b=%zz')?.url.searchParams.get('pack'), 'a');
  assert.equal(parseTarget('/console/%2e%2e/mcp')?.url.pathname, '/mcp', 'dot segments are resolved as the URL standard says');
  const absolute = parseTarget('http://LOCALHOST:7420/healthz?x=1');
  assert.equal(absolute?.url.pathname, '/healthz');
  assert.equal(absolute?.authority, 'localhost:7420');
  for (const bad of [undefined, '', '*', 'http://a:b/', 'http://%zz/', 'https://127.0.0.1/', ["http:/","/user:","pw@127",".0.0.1","/"].join(''), 'mcp', 'ftp://127.0.0.1/']) {
    assert.equal(parseTarget(bad), null, String(bad));
  }
});

test('admin notes are what records accept: no NUL, no lone surrogate, cut between code points', () => {
  assert.equal(clipNote('a\u0000b'), 'ab');
  assert.equal(clipNote('x\ud800y'), 'x�y');
  const cut = clipNote(`${'a'.repeat(298)}😀tail`, 300);
  assert.ok(cut.isWellFormed());
  assert.ok(cut.length <= 300);
  assert.equal(cut, `${'a'.repeat(298)}…`);
  const long = clipNote('字'.repeat(5000));
  assert.equal(long.length, MAX_ADMIN_NOTE);
  assert.ok(long.endsWith('…'));
  assert.equal(describeError(Object.assign(new Error('坏\u0000了'), { name: 'TypeError' })), 'TypeError: 坏了');
  assert.equal(describeError('plain'), 'plain');

  const mockError = new Error('simulated failure');
  mockError.stack = [
    'Error: simulated failure',
    '    at callTool (/synthetic/circle-hub/hub/server/tools.ts:163:10)',
    '    at async guarded (file:///synthetic/circle-hub/hub/server/mcp.ts:244:14)',
    '    at runScriptInThisContext (node:internal/vm:219:10)',
  ].join('\n');
  const cleaned = cleanStack(mockError);
  assert.match(cleaned, /^Error: simulated failure\nat callTool \(hub\/server\/tools\.ts:163:10\)\nat async guarded \(hub\/server\/mcp\.ts:244:14\)/);
  assert.doesNotMatch(cleaned, /\/Users\//);
  assert.doesNotMatch(cleaned, /file:\/\//);
  assert.equal(describeInternalError('string error'), 'string error');
});

test('the body budget takes what fits and gives everything back on release', () => {
  const budget = new BodyBudget(100);
  const a = budget.hold();
  const b = budget.hold();
  assert.ok(a.take(60));
  assert.ok(!b.take(41), 'over the capacity');
  assert.ok(b.take(40));
  assert.equal(budget.used, 100);
  a.release();
  a.release();
  assert.equal(budget.used, 40, 'a release gives back only what that hold took, once');
  b.release();
  assert.equal(budget.used, 0);
  assert.equal(REFERRER_POLICY, 'same-origin', 'same-origin form posts carry their real Origin');
});

test('the item cell of a layer: the conjunction terminal first, then the other non-pass values in vocabulary order', () => {
  assert.equal(cellText('static', { terminal: 'pass', counts: {} }), '✓ 静态：通过');
  assert.equal(cellText('static', { terminal: 'unchecked', counts: { judgment: 1, unchecked: 2 } }), '？ 静态：未核对（未核对 2，判断 1）');
  assert.equal(cellText('static', { terminal: 'violation', counts: { unchecked: 1, violation: 1, incomplete: 1 } }), '✗ 静态：不通过（不通过 1，未核对 1，未完成 1）');
  assert.equal(cellText('dynamic', { terminal: 'not_run', counts: { not_run: 3 } }), '？ 动态：未运行（未运行 3）');
});

test('the run of a run-scoped record, by the runs engine\'s shapes; other kinds belong to no run', () => {
  const run = 'run_0123456789abcdefghjkmnpqrs';
  assert.equal(runOfRecord('validation_result', { run }), run);
  assert.equal(runOfRecord('submission', { run, model: 'm' }), run);
  assert.equal(runOfRecord('submission', { received: { object: 'a'.repeat(64), size: 3, non_canonical_path: '/x', run } }), run);
  assert.equal(runOfRecord('submission', { run, received: { run: 'run_other' } }), run, 'a canonical submission names its run first');
  assert.equal(runOfRecord('claim', { run }), null);
  assert.equal(runOfRecord('call_log', { run }), null);
  assert.equal(runOfRecord('action', { run: null }), null);
});

test('a document too large for its parse is answered with a smaller original, any other sandbox failure goes to the administrator', () => {
  assert.deepEqual(sandboxError(new SandboxError('SANDBOX_OUTPUT_TOO_LARGE', { limit: 'document_cache_bytes' })), {
    code: 'SOURCE_RETRYABLE',
    message: '文档缓存估算超过预算：SANDBOX_OUTPUT_TOO_LARGE',
    fix: '请来源维护者拆分原件，或请解析器维护者缩小保留结构后重读',
  });
  // The memory watchdog's own detail, as the sandbox gives it, and the output limit.
  for (const [error, message] of [
    [new SandboxError('SANDBOX_VIOLATION', { limit: 'memory', residentBytes: 495_583_232, memoryMb: 256 }), '解析原件超过沙箱内存上限：SANDBOX_VIOLATION'],
    [new SandboxError('SANDBOX_OUTPUT_TOO_LARGE', { outputBytes: 67_108_865 }), '解析结果超过沙箱输出上限：SANDBOX_OUTPUT_TOO_LARGE'],
  ] as const) {
    const answer = sandboxError(error);
    assert.equal(answer.code, 'SOURCE_RETRYABLE');
    assert.equal(answer.message, message);
    assert.match(answer.fix ?? '', /^原样重读仍会失败；请来源维护者拆分原件后重读/);
  }
  for (const error of [new SandboxError('SANDBOX_VIOLATION', { reason: 'symbolic_link' }), new SandboxError('SANDBOX_TIMEOUT'), new SandboxError('FUNCTION_THREW')]) {
    assert.equal(sandboxError(error).fix, '管理员核对技能包和沙箱状态，恢复后重新读取', error.code);
  }
});

test('an input slot reads an external system when it accepts system:type, never a media type', () => {
  assert.ok(isExternalType('tracker:document'));
  assert.ok(isExternalType('mind-map:document'));
  for (const accepts of ['application/json', 'text/markdown', 'tracker', 'tracker:document:1', 'Tracker:doc']) assert.ok(!isExternalType(accepts), accepts);
});

test('the Hub\'s own knowledge views are external object types to bind but no external system: start_run reads them inside the Hub', () => {
  for (const view of ['knowledge:impact', 'knowledge:facets', 'knowledge:index']) {
    assert.ok(isExternalType(view), `${view} is bound as {external: …}`);
    assert.ok(!readsOutside(view), `${view} is read inside the Hub`);
  }
  assert.ok(readsOutside('tracker:document'));
  assert.ok(readsOutside('knowledge-base:document'), 'only the system named knowledge is the Hub\'s');
  assert.ok(!readsOutside('application/json'));
  assert.equal(KNOWLEDGE_VIEW_SYSTEM, VIEW_SYSTEM, 'the server names the views\' system as hub/knowledge does');
});

test('historical transitional layers disclose unwritten exits without mutating the result', () => {
  const legacy = { layer: 'static', terminal: 'unchecked', reason: 'missing_input' } as const;
  const before = JSON.stringify(legacy);
  assert.match(terminalText(legacy), /出口未写/);
  assert.equal(JSON.stringify(legacy), before);
});
