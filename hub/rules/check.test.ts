// runCheck with core interpreters and with pack functions in the sandbox. Synthetic packs in a temporary directory.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildCatalog, runCheck, sourcesFrom } from './api.ts';
import { osIsolationAvailable } from './sandbox/isolation.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'hub-rules-check-')));
let os = false;
before(async () => {
  os = await osIsolationAvailable();
});
after(() => rmSync(root, { recursive: true, force: true }));

function pack(files: Record<string, string>): string {
  const dir = join(root, `pack-${Math.random().toString(36).slice(2)}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const membership = { schema: 'membership@1', origin: '测试', values: ['$.code'], set: { values: ['A', 'B'] }, tier: 'advisory' };

describe('runCheck with a core interpreter', () => {
  it('runs the interpreter with the table and keeps the table tier', async () => {
    const outcomes = await runCheck({ id: 'codes', interpreter: 'membership@1' }, { table: membership, subject: { code: 'C' }, context: {} });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].code, 'core.membership.not_in_set');
    assert.equal(outcomes[0].tier, 'advisory');
  });

  it('an omitted declaration tier leaves the table’s own tier to the interpreter (C05 R[1])', async () => {
    const withBasis = await runCheck({ id: 'c1', interpreter: 'membership@1' }, { table: { ...membership, tier: undefined, basis: '测试条款' }, subject: { code: 'A' }, context: {} });
    assert.equal(withBasis[0].tier, 'blocking');
    const withoutBasis = await runCheck({ id: 'c2', interpreter: 'membership@1' }, { table: { ...membership, tier: undefined, origin: '测试' }, subject: { code: 'A' }, context: {} });
    assert.equal(withoutBasis[0].tier, 'advisory');
  });

  it('the declaration tier replaces the table tier', async () => {
    const [o] = await runCheck({ interpreter: 'membership@1', tier: 'blocking', basis: '测试条款 1' }, { table: membership, subject: { code: 'A' }, context: {} });
    assert.equal(o.verdict, 'support');
    assert.equal(o.tier, 'blocking');
  });

  it('a declared tier does not change the tier of negative-case outcomes', async () => {
    const catalog = buildCatalog({ root: 'f'.repeat(64), entries: [{ head: 'gw port', signatures: [[{ name: 'port', type: 'port' }]] }] });
    const table = {
      schema: 'catalog@1',
      origin: '测试',
      basis: '测试条款 2',
      catalog: 'commands',
      commands: ['$.cmd'],
      negative: { flag: '/negative', expect: ['core.catalog.param_out_of_range'] },
    };
    const [negative] = await runCheck({ interpreter: 'catalog@1', tier: 'blocking' }, { table, subject: { cmd: 'gw port 70000', negative: true }, catalog, context: {} });
    assert.equal(negative.code, 'core.catalog.param_out_of_range');
    assert.equal(negative.tier, 'advisory');
    assert.equal(negative.data?.negative_case, true);
    assert.equal(negative.data?.expected, true);
    const [plain] = await runCheck({ interpreter: 'catalog@1', tier: 'advisory' }, { table, subject: { cmd: 'gw port 70000', negative: false }, catalog, context: {} });
    assert.equal(plain.tier, 'advisory');
    const [byTable] = await runCheck({ interpreter: 'catalog@1' }, { table, subject: { cmd: 'gw port 70000', negative: false }, catalog, context: {} });
    assert.equal(byTable.tier, 'blocking');
  });

  it('a blocking check must name the contract clause it relies on (C05 R[1])', async () => {
    const table = { schema: 'membership@1', origin: '测试', values: ['$.code'], set: { values: ['A'] } };
    const [advisory] = await runCheck({ interpreter: 'membership@1' }, { table, subject: { code: 'B' }, context: {} });
    assert.equal(advisory.verdict, 'refute');
    assert.equal(advisory.tier, 'advisory');
    const [refused] = await runCheck({ interpreter: 'membership@1', tier: 'blocking' }, { table, subject: { code: 'B' }, context: {} });
    assert.equal(refused.verdict, 'unknown');
    assert.equal(refused.reason, 'check_error');
    const [declared] = await runCheck({ interpreter: 'membership@1', tier: 'blocking', basis: '测试条款 3' }, { table, subject: { code: 'B' }, context: {} });
    assert.equal(declared.code, 'core.membership.not_in_set');
    assert.equal(declared.tier, 'blocking');
    const [byTable] = await runCheck({ interpreter: 'membership@1' }, { table: { ...table, basis: '测试条款 4' }, subject: { code: 'B' }, context: {} });
    assert.equal(byTable.tier, 'blocking');
  });

  it('passes the catalog and the sources through', async () => {
    const catalog = buildCatalog({ root: 'f'.repeat(64), entries: [{ head: 'gw status' }] });
    const table = { schema: 'catalog@1', origin: '测试', catalog: 'commands', commands: ['$.commands'] };
    const [o] = await runCheck({ interpreter: 'catalog@1' }, { table, subject: { commands: ['gw status now'] }, catalog, context: {} });
    assert.equal(o.code, 'core.catalog.arity_mismatch');
    const ref = `src:${'f'.repeat(64)}/markdown@1/p/2`;
    const quote = { schema: 'quote@1', origin: '测试', quotes: [{ select: '$.q[*]', text: '/t', reference: '/r' }] };
    const [q] = await runCheck({ interpreter: 'quote@1' }, { table: quote, subject: { q: [{ t: '片段', r: ref }] }, sources: sourcesFrom({ [ref]: '一个片段' }), context: {} });
    assert.equal(q.verdict, 'support');
  });

  it('an interpreter that is not installed gives no outcome at all (no check is not a verdict); a malformed declaration is a check error', async () => {
    assert.deepEqual(await runCheck({ interpreter: 'mapping@1' }, { subject: {}, context: {} }), []);
    const [both] = await runCheck({ interpreter: 'membership@1', function: { module: 'f.ts' } }, { subject: {}, context: {} });
    assert.equal(both.reason, 'check_error');
    const [neither] = await runCheck({}, { subject: {}, context: {} });
    assert.equal(neither.reason, 'check_error');
  });
});

describe('runCheck with a pack function', () => {
  const sandbox = () => ({ requireOsIsolation: os });

  it('passes table, subject, context, sources and catalog entries, and returns the function outcomes', async () => {
    const dir = pack({
      'checks/echo.ts': [
        'export default function (input: { check: string; table: { want: string }; subject: { value: string }; context: { pack: string }; sources: Record<string, string>; catalog?: { words: string[] }[] }) {',
        '  const ok = input.subject.value === input.table.want;',
        "  return [{ verdict: ok ? 'support' : 'refute', ...(ok ? {} : { code: `${input.context.pack}.wrong_value` }), statement: ok ? '取值正确' : '取值不对',",
        "    grounds: Object.keys(input.sources), tier: 'blocking', data: { check: input.check, heads: (input.catalog ?? []).map((e) => e.words.join(' ')) } }];",
        '}',
      ].join('\n'),
    });
    const ref = `src:${'9'.repeat(64)}`;
    const catalog = buildCatalog({ root: '9'.repeat(64), entries: [{ head: 'gw status' }] });
    const declaration = { id: 'echo', function: { module: 'checks/echo.ts' }, catalogEntries: true, tier: 'advisory' as const };
    const bindings = { table: { want: 'x' }, subject: { value: 'y' }, catalog, context: { pack: 'synthetic-review' }, packDir: dir, sourceTexts: { [ref]: 'text' }, sandbox: sandbox() };
    const [o] = await runCheck(declaration, bindings);
    assert.equal(o.verdict, 'refute');
    assert.equal(o.code, 'synthetic-review.wrong_value');
    assert.deepEqual(o.grounds, [ref]);
    assert.deepEqual(o.data, { check: 'echo', heads: ['gw status'] });
    const [s] = await runCheck({ ...declaration, tier: 'advisory' }, { ...bindings, subject: { value: 'x' } });
    assert.equal(s.verdict, 'support');
    assert.equal(s.tier, 'advisory');
  });

  it('a pack function without a declared tier is not run: check error, the admin log gets the missing tier, no guess', async () => {
    const dir = pack({
      'checks/echo.ts': "export default () => [{ verdict: 'support', statement: '不该跑到', grounds: [], tier: 'blocking' }];",
    });
    const errors: unknown[] = [];
    const [o] = await runCheck(
      { id: 'echo', function: { module: 'checks/echo.ts' } },
      { table: { basis: '测试条款' }, subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox(), onError: (e) => errors.push(e) },
    );
    assert.equal(o.verdict, 'unknown');
    assert.equal(o.reason, 'check_error');
    assert.match(o.statement, /没有声明档位（tier）/);
    assert.match(o.statement, /不猜档/);
    assert.equal(o.code, undefined, 'no code: the tier never reaches a layer');
    assert.equal(errors.length, 1, 'the admin log gets the missing-tier detail');
    assert.match(String((errors[0] as Error).message), /没有声明档位/);
    const declared = await runCheck({ id: 'echo', function: { module: 'checks/echo.ts' }, tier: 'blocking', basis: '测试条款' }, { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox() });
    assert.equal(declared[0].verdict, 'support', 'a declared tier runs as before');
    assert.equal(declared[0].tier, 'blocking');
  });

  it('invalid outcomes, a code outside the pack namespace and an empty result are check errors', async () => {
    const dir = pack({
      'bad.ts': "export default () => [{ verdict: 'pass', statement: 'x', grounds: [], tier: 'blocking' }];",
      'foreign.ts': "export default () => [{ verdict: 'refute', code: 'core.structure.cardinality', statement: '不对', grounds: [], tier: 'blocking' }];",
      'nocode.ts': "export default () => [{ verdict: 'refute', statement: '不对', grounds: [], tier: 'blocking' }];",
      'empty.ts': 'export default () => [];',
      'object.ts': 'export default () => ({});',
    });
    for (const module of ['bad.ts', 'foreign.ts', 'nocode.ts', 'empty.ts', 'object.ts']) {
      const [o] = await runCheck({ function: { module }, tier: 'advisory' }, { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox() });
      assert.equal(o.verdict, 'unknown', module);
      assert.equal(o.reason, 'check_error', module);
    }
  });

  it('sandbox failures become unknown with a reason: timeout, thrown error, undeclared import, missing pack directory', async () => {
    const dir = pack({
      'loop.ts': 'export default () => { for (;;) {} };',
      'throws.ts': "export default () => { throw new Error('x'); };",
      'imports.ts': "import { readFileSync } from 'node:fs'; export default () => [readFileSync];",
    });
    const run = (module: string, limits = {}) => runCheck({ function: { module }, limits, tier: 'advisory' }, { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox() });
    const [timeout] = await run('loop.ts', { timeoutMs: 500 });
    assert.equal(timeout.reason, 'timeout');
    assert.equal(timeout.data?.sandbox, 'SANDBOX_TIMEOUT');
    const [threw] = await run('throws.ts');
    assert.equal(threw.reason, 'check_error');
    assert.equal(threw.data?.sandbox, 'FUNCTION_THREW');
    const [imports] = await run('imports.ts');
    assert.equal(imports.data?.sandbox, 'IMPORT_NOT_DECLARED');
    const [noDir] = await runCheck({ function: { module: 'x.ts' }, tier: 'advisory' }, { subject: {}, context: { pack: 'synthetic-review' } });
    assert.equal(noDir.reason, 'missing_input');
  });

  it('without context.pack a pack function is not run; core and protocol codes are refused from any pack', async () => {
    const dir = pack({
      'protocol.ts':
        "export default () => [{ verdict: 'refute', code: 'QUOTE_MISMATCH', statement: '不对', grounds: [], tier: 'blocking' }, { verdict: 'refute', code: 'core.catalog.not_member', statement: '不对', grounds: [], tier: 'blocking' }];",
      'core.ts': "export default () => [{ verdict: 'refute', code: 'core.catalog.not_member', statement: '不对', grounds: [], tier: 'blocking' }];",
      'bare.ts': "export default () => [{ verdict: 'refute', code: 'synthetic-review.', statement: '不对', grounds: [], tier: 'blocking' }];",
    });
    const [noPack] = await runCheck({ function: { module: 'protocol.ts' }, tier: 'advisory' }, { subject: {}, context: {}, packDir: dir, sandbox: sandbox() });
    assert.equal(noPack.verdict, 'unknown');
    assert.equal(noPack.reason, 'missing_input');
    for (const [module, packName] of [
      ['core.ts', 'core'],
      ['protocol.ts', 'synthetic-review'],
      ['bare.ts', 'synthetic-review'],
    ]) {
      const [o] = await runCheck({ function: { module }, tier: 'advisory' }, { subject: {}, context: { pack: packName }, packDir: dir, sandbox: sandbox() });
      assert.equal(o.verdict, 'unknown', module);
      assert.equal(o.reason, 'check_error', module);
    }
  });

  it('a pack check gives only check verdicts and check reasons: no abstention, no model or submission reasons', async () => {
    const outcome = (fields: string) => `export default () => [{ ${fields}, statement: '结果', grounds: [], tier: 'advisory' }];`;
    const dir = pack({
      'abstain.ts': outcome("verdict: 'abstain'"),
      'skip.ts': outcome("verdict: 'unknown', missing: '合成检查所需事实', reason: 'declared_skip'"),
      'nocheck.ts': outcome("verdict: 'unknown', missing: '合成检查所需事实', reason: 'no_check'"),
      'integrity.ts': outcome("verdict: 'unknown', missing: '合成检查所需事实', reason: 'integrity_unproven'"),
      'output.ts': outcome("verdict: 'unknown', missing: '合成检查所需事实', reason: 'output_failed'"),
    });
    for (const module of ['abstain.ts', 'skip.ts', 'nocheck.ts']) {
      const [o] = await runCheck({ function: { module }, tier: 'advisory' }, { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox() });
      assert.equal(o.verdict, 'unknown', module);
      assert.equal(o.reason, 'check_error', module);
    }
    const [kept] = await runCheck({ function: { module: 'integrity.ts' }, tier: 'advisory' }, { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox() });
    assert.equal(kept.reason, 'integrity_unproven');
    const [output] = await runCheck({ function: { module: 'output.ts' }, tier: 'advisory' }, { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox() });
    assert.equal(output.verdict,'unknown');
    assert.equal(output.reason,'output_failed');
  });

  it('a declared tier is the default for pack outcomes; negative-case outcomes keep their own tier', async () => {
    const dir = pack({
      'negative.ts': [
        'export default () => [',
        "  { verdict: 'refute', code: 'synthetic-review.expected', statement: '反向用例的预期反驳', grounds: [], tier: 'advisory', data: { negative_case: true, expected: true } },",
        "  { verdict: 'support', statement: '其余一致', grounds: [], tier: 'advisory' },",
        '];',
      ].join('\n'),
    });
    const outcomes = await runCheck(
      { function: { module: 'negative.ts' }, tier: 'blocking', basis: '测试条款 5' },
      { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox() },
    );
    assert.deepEqual(
      outcomes.map((o) => o.tier),
      ['advisory', 'blocking'],
    );
  });

  it('a sandbox failure keeps only a stable, path-free part in the outcome; the full error goes to onError', async () => {
    const dir = pack({ 'throws.ts': 'export default () => { throw new Error(`failed in ${import.meta.url}`); };' });
    const errors: unknown[] = [];
    const go = () =>
      runCheck({ id: 'throws', function: { module: 'throws.ts' }, tier: 'advisory' }, { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, sandbox: sandbox(), onError: (e) => errors.push(e) });
    const [first] = await go();
    const [second] = await go();
    assert.equal(first.reason, 'check_error');
    assert.deepEqual(first, second, 'identical inputs give identical outcomes');
    assert.equal(JSON.stringify(first).includes(root), false, 'no host path in the outcome');
    assert.deepEqual(first.data, { sandbox: 'FUNCTION_THREW', module: 'throws.ts', phase: 'call' });
    assert.equal(errors.length, 2);
    const error = errors[0] as { code?: unknown; detail?: { stack?: unknown; durationMs?: unknown } };
    assert.equal(error.code, 'FUNCTION_THREW');
    assert.match(String(error.detail?.stack), /throws\.ts/);
    assert.equal(typeof error.detail?.durationMs, 'number');
  });

  it('passes unreadSources with external and slot to pack function', async () => {
    const dir = pack({
      'checks/unread.ts': [
        'export default function (input: { unread_sources?: { reference: string; reason: string; external?: string; slot?: string }[] }) {',
        "  return [{ verdict: 'unknown', missing: '合成检查所需事实', reason: 'missing_input', statement: '缺来源', grounds: [], tier: 'advisory', data: { unread: input.unread_sources ?? [] } }];",
        '}',
      ].join('\n'),
    });
    const declaration = { id: 'unread-check', tier: 'advisory' as const, function: { module: 'checks/unread.ts' } };
    const unread = [{ reference: `src:${'a'.repeat(64)}`, reason: '超过大小上限', external: 'plm:bugs:123', slot: 'expected' }];
    const bindings = { subject: {}, context: { pack: 'synthetic-review' }, packDir: dir, unreadSources: unread, sandbox: sandbox() };
    const [o] = await runCheck(declaration, bindings);
    assert.equal(o.verdict, 'unknown');
    assert.deepEqual(o.data, { unread });
  });
});
